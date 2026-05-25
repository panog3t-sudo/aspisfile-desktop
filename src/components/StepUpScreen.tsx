import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { supabase } from "../lib/supabase";

// Phase 1 Day 12.5 — localStorage key threading approvalId across the
// OAuth round-trip. StepUpScreen sets it before launching the
// browser; on window-focus return, if a Supabase session is now live
// AND this key is set, we call /resolve-oauth and clear the key.
const OAUTH_RESOLVE_KEY = "asp_oauth_resolving_v1";

// 5-minute window — anything older is treated as stale. Mirrors the
// mobile equivalent in lib/recipientAuth.ts.
const OAUTH_RESOLVE_TTL_MS = 5 * 60 * 1000;

type OAuthProvider = "google" | "azure" | "apple";

declare const __API_BASE__: string;

// Phase 1 Day 9.3 — desktop step-up gate UI.
//
// Rendered by SecureViewer when /api/v1/mobile/access returns
//   { status: 'pending_approval', mechanism: null }  (suspicious tier)
// Calls the same /request-otp + /resolve-otp endpoints used by web +
// mobile via Tauri's HTTP plugin with a Supabase Bearer token.
//
// Day 9 shipped OTP-only; Day 12.5 wires OAuth via plugin-opener
// (launch URL in external browser) + plugin-deep-link (catch the
// aspisfile://auth/callback?code=… return). App.tsx handles the
// code-exchange; this component owns the approvalId round-trip via
// localStorage + window-focus listener.

export type StepUpCreds = {
  session_id:   string;
  session_key:  string;
  device_share: string | null;
  file_id:      string;
  expires_at:   string;
};

async function getFingerprint(): Promise<string> {
  const platform = await invoke<string>("get_platform");
  const raw = `${platform}:${screen.width}x${screen.height}:${
    Intl.DateTimeFormat().resolvedOptions().timeZone
  }`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function bearerHeaders(): Promise<Record<string, string>> {
  const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
  return {
    "Content-Type":   "application/json",
    "X-App-Platform": "desktop",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

type Step = "choose" | "sending" | "enter";

export function StepUpScreen({
  approvalId,
  fileName,
  recipientEmail,
  onApproved,
  onDelegationRequired,
}: {
  approvalId:           string;
  fileName:             string;
  recipientEmail:       string;
  onApproved:           (creds: StepUpCreds) => void;
  onDelegationRequired: (approvalId: string) => void;
}) {
  const [step,  setStep]  = useState<Step>("choose");
  const [code,  setCode]  = useState("");
  const [error, setError] = useState("");
  const [busy,  setBusy]  = useState(false);
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  const resolveInFlightRef = useRef(false);

  // Phase 1 Day 12.5 — OAuth round-trip completion detector.
  //
  // StepUpScreen.handleOAuth stashes the approvalId in localStorage
  // and launches the external browser via plugin-opener. The user
  // completes OAuth, the provider redirects to aspisfile://auth/
  // callback?code=…, App.tsx's deep-link handler exchanges that for
  // a Supabase session. At that point the Tauri window regains focus
  // — this effect catches it, sees the stale localStorage entry, and
  // calls /resolve-oauth with the now-live Bearer token.
  //
  // Polling-on-focus (vs CustomEvent dispatch) keeps the coupling
  // shallow: App.tsx only knows about code exchange, StepUpScreen
  // only knows about the approval lifecycle.
  useEffect(() => {
    const handler = async () => {
      if (resolveInFlightRef.current) return;

      const raw = localStorage.getItem(OAUTH_RESOLVE_KEY);
      if (!raw) return;

      let stored: { approvalId: string; provider: OAuthProvider; ts: number } | null = null;
      try { stored = JSON.parse(raw); } catch { localStorage.removeItem(OAUTH_RESOLVE_KEY); return; }
      if (!stored || stored.approvalId !== approvalId) return;
      if (Date.now() - stored.ts > OAUTH_RESOLVE_TTL_MS) {
        localStorage.removeItem(OAUTH_RESOLVE_KEY);
        return;
      }

      // Need an actual Supabase session before we can call /resolve-oauth.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      resolveInFlightRef.current = true;
      localStorage.removeItem(OAUTH_RESOLVE_KEY);
      try {
        const fp = await getFingerprint();
        const res = await fetch(`${__API_BASE__}/api/v1/approvals/${approvalId}/resolve-oauth`, {
          method:  "POST",
          headers: await bearerHeaders(),
          body:    JSON.stringify({ deviceFingerprint: fp }),
        });
        const json = await res.json();
        if (json.status === "delegation_required") {
          onDelegationRequired(json.approval_id || approvalId);
          return;
        }
        if (!res.ok || json.status !== "approved") {
          setError(json.detail || json.error || "Could not complete sign-in.");
          setOauthBusy(null);
          return;
        }
        onApproved({
          session_id:   json.session_id,
          session_key:  json.session_key,
          device_share: json.device_share ?? null,
          file_id:      json.file_id,
          expires_at:   json.expires_at,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error.");
        setOauthBusy(null);
      } finally {
        resolveInFlightRef.current = false;
      }
    };

    // Run once on mount in case the focus event already fired before
    // we registered (e.g. very fast browser OAuth completion).
    handler();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [approvalId, onApproved, onDelegationRequired]);

  const handleOAuth = async (provider: OAuthProvider) => {
    if (oauthBusy) return;
    setOauthBusy(provider);
    setError("");
    try {
      localStorage.setItem(OAUTH_RESOLVE_KEY, JSON.stringify({
        approvalId, provider, ts: Date.now(),
      }));

      const { data, error: signErr } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: "aspisfile://auth/callback",
          skipBrowserRedirect: true,
          ...(provider === "azure" ? { scopes: "email profile" } : {}),
        },
      });
      if (signErr || !data?.url) {
        localStorage.removeItem(OAUTH_RESOLVE_KEY);
        setError(signErr?.message ?? "OAuth init failed.");
        setOauthBusy(null);
        return;
      }
      // Launch in the user's default browser. The provider page opens
      // there; Tauri stays in the background until the aspisfile://
      // callback brings it back to foreground.
      await openUrl(data.url);
      // Stay in `oauthBusy` state until the focus listener resolves
      // the gate or the user dismisses StepUpScreen.
    } catch (e) {
      localStorage.removeItem(OAUTH_RESOLVE_KEY);
      setError(e instanceof Error ? e.message : "OAuth launch failed.");
      setOauthBusy(null);
    }
  };

  const requestOtp = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setStep("sending");
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/approvals/${approvalId}/request-otp`, {
        method: "POST",
        headers: await bearerHeaders(),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.detail || json.error || "Could not send code.");
        setStep("choose");
        return;
      }
      setStep("enter");
    } catch {
      setError("Network error — try again.");
      setStep("choose");
    } finally {
      setBusy(false);
    }
  };

  const resolveOtp = async () => {
    if (busy) return;
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fp = await getFingerprint();
      const res = await fetch(`${__API_BASE__}/api/v1/approvals/${approvalId}/resolve-otp`, {
        method:  "POST",
        headers: await bearerHeaders(),
        body:    JSON.stringify({ code, deviceFingerprint: fp }),
      });
      const json = await res.json();
      if (json.status === "delegation_required") {
        onDelegationRequired(json.approval_id || approvalId);
        return;
      }
      if (!res.ok || json.status !== "approved") {
        if (json.error === "INVALID_CODE") {
          setError(typeof json.remaining === "number"
            ? `Incorrect code. ${json.remaining} ${json.remaining === 1 ? "attempt" : "attempts"} left.`
            : "Incorrect code.");
        } else if (json.error === "CODE_EXPIRED") {
          setError("Code expired. Send a new one.");
        } else if (json.error === "TOO_MANY_ATTEMPTS") {
          setError("Too many attempts. Request a fresh code.");
        } else {
          setError(json.detail || json.error || "Could not verify code.");
        }
        return;
      }
      onApproved({
        session_id:   json.session_id,
        session_key:  json.session_key,
        device_share: json.device_share ?? null,
        file_id:      json.file_id,
        expires_at:   json.expires_at,
      });
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "enter") {
    return (
      <div style={styles.overlay}>
        <div style={styles.card}>
          <div style={styles.iconBlue}>
            <span style={{ fontSize: 24 }}>✉︎</span>
          </div>
          <p style={styles.title}>Enter the code</p>
          <p style={styles.body}>
            We sent a 6-digit code to <span style={styles.emph}>{recipientEmail || "your email"}</span>.
          </p>

          <input
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter" && code.length === 6) resolveOtp(); }}
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            style={styles.codeInput}
          />

          {error && <p style={styles.error}>{error}</p>}

          <button
            onClick={resolveOtp}
            disabled={busy || code.length !== 6}
            style={{
              ...styles.primaryBtn,
              ...(busy || code.length !== 6 ? styles.primaryBtnDisabled : {}),
            }}
          >
            {busy ? "Verifying…" : "Verify and continue"}
          </button>

          <div style={styles.row}>
            <button
              onClick={() => { setStep("choose"); setCode(""); setError(""); }}
              style={styles.link}
            >
              ← Back
            </button>
            <button
              onClick={requestOtp}
              disabled={busy}
              style={styles.linkBlue}
            >
              Resend code
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.iconBlue}>
          <span style={{ fontSize: 22 }}>🛡</span>
        </div>
        <p style={styles.title}>Additional verification required</p>
        <p style={styles.body}>
          Confirm your identity to open <span style={styles.emph}>{fileName || "this file"}</span>.
          We will send a 6-digit code to <span style={styles.emph}>{recipientEmail || "your email"}</span>.
        </p>

        <button
          onClick={requestOtp}
          disabled={busy}
          style={{
            ...styles.primaryBtn,
            ...(busy ? styles.primaryBtnDisabled : {}),
          }}
        >
          {step === "sending" || busy ? "Sending…" : "Email me a one-time code"}
        </button>

        <div style={styles.divider} />

        <button
          onClick={() => handleOAuth("google")}
          disabled={!!oauthBusy}
          style={{ ...styles.oauthBtn, ...(oauthBusy === "google" ? styles.oauthBtnBusy : {}) }}
        >
          {oauthBusy === "google" ? "Opening…" : "Continue with Google"}
        </button>
        <button
          onClick={() => handleOAuth("azure")}
          disabled={!!oauthBusy}
          style={{ ...styles.oauthBtn, ...(oauthBusy === "azure" ? styles.oauthBtnBusy : {}) }}
        >
          {oauthBusy === "azure" ? "Opening…" : "Continue with Microsoft"}
        </button>
        <button
          onClick={() => handleOAuth("apple")}
          disabled={!!oauthBusy}
          style={{ ...styles.oauthBtnDark, ...(oauthBusy === "apple" ? styles.oauthBtnBusy : {}) }}
        >
          {oauthBusy === "apple" ? "Opening…" : "Continue with Apple"}
        </button>

        {error && <p style={styles.error}>{error}</p>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay:           { position: "fixed", inset: 0, zIndex: 9999, background: "#111111", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" },
  card:              { width: "100%", maxWidth: 380, background: "#1A1A1A", border: "0.5px solid #2A2A2A", borderRadius: 12, padding: 28 },
  iconBlue:          { width: 44, height: 44, borderRadius: 11, background: "rgba(59,130,246,0.12)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" },
  title:             { color: "#fff", fontSize: 14, fontWeight: 500, textAlign: "center", margin: "0 0 6px" },
  body:              { color: "rgba(255,255,255,0.55)", fontSize: 12, lineHeight: 1.6, textAlign: "center", margin: "0 0 20px" },
  emph:              { color: "#fff" },
  codeInput:         { width: "100%", padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.05)", color: "#fff", border: "0.5px solid rgba(255,255,255,0.12)", fontSize: 22, letterSpacing: "0.35em", textAlign: "center", fontFamily: "'SF Mono','Menlo',monospace", outline: "none", boxSizing: "border-box", marginBottom: 10 },
  error:             { color: "#FCA5A5", fontSize: 11, margin: "0 0 12px", textAlign: "center" },
  primaryBtn:        { width: "100%", padding: "11px 14px", borderRadius: 8, marginBottom: 10, background: "#3B82F6", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" },
  primaryBtnDisabled: { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.35)", cursor: "not-allowed" },
  row:               { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  link:              { background: "none", border: "none", color: "rgba(255,255,255,0.45)", fontSize: 11, cursor: "pointer", padding: 0, fontFamily: "inherit" },
  linkBlue:          { background: "none", border: "none", color: "#3B82F6", fontSize: 11, cursor: "pointer", padding: 0, fontFamily: "inherit" },
  divider:           { borderTop: "0.5px solid rgba(255,255,255,0.06)", margin: "4px -28px 14px" },
  disabledBtn:       { width: "100%", padding: "9px 14px", borderRadius: 8, background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.35)", border: "0.5px solid rgba(255,255,255,0.08)", cursor: "not-allowed", fontSize: 12, fontFamily: "inherit", marginBottom: 8 },
  oauthBtn:          { width: "100%", padding: "11px 14px", borderRadius: 8, background: "#fff", color: "#0F172A", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 },
  oauthBtnDark:      { width: "100%", padding: "11px 14px", borderRadius: 8, background: "#000", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 },
  oauthBtnBusy:      { opacity: 0.6, cursor: "wait" },
};
