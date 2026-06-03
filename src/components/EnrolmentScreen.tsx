import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { registerPasskey, authenticatePasskey, PasskeyError } from "../lib/passkey";

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

// Native AS bridge enrolment (macOS in-window Touch ID) with Path B
// browser-redirect fallback for non-macOS or when the bridge fails.
//
// macOS happy path:
//   1. User enters email + enrolment code, clicks Continue.
//   2. POST /api/v1/enrollment-codes/redeem → registration_token (JWT, 5min).
//   3. lib/passkey.ts registerPasskey() → native AS bridge fires
//      ASAuthorizationController with the AspisFile window as anchor →
//      Touch ID prompt appears INSIDE the AspisFile window.
//   4. Server verify succeeds → authenticatePasskey() runs immediately
//      to mint a recipient session.
//   5. saveRecipientSession + onComplete().
//
// Fallback (Windows, or macOS bridge failure):
//   - openUrl(/enroll/desktop?email=…&code=…) → default browser handles
//     the ceremony and redirects back via aspisfile:// custom scheme.
//   - App.tsx's deep-link handler picks it up, calls saveRecipientSession,
//     dismisses this screen.

type Phase = "input" | "running" | "waiting_browser";

type Props = {
  onComplete?: () => void;
  onCancel?:   () => void;
};

export function EnrolmentScreen({ onComplete, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>("input");
  const [email, setEmail] = useState("");
  const [code,  setCode]  = useState("");
  const [error, setError] = useState("");

  async function fallbackToBrowser(cleanEmail: string, cleanCode: string) {
    const url = new URL(`${BASE}/enroll/desktop`);
    url.searchParams.set("email", cleanEmail);
    url.searchParams.set("code",  cleanCode);
    try {
      await openUrl(url.toString());
      setPhase("waiting_browser");
    } catch {
      setError("Could not open your browser. Copy and open this link manually: " + url.toString());
      setPhase("input");
    }
  }

  async function handleSubmit() {
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode  = code.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError("Enter a valid email.");
      return;
    }
    if (cleanCode.length < 4) {
      setError("Enter the enrolment code.");
      return;
    }

    setError("");
    setPhase("running");

    // Native bridge attempt — macOS only. On non-macOS, get_platform
    // returns "windows" and we skip straight to the browser path.
    let platform = "unknown";
    try { platform = await invoke<string>("get_platform"); } catch {}

    if (platform !== "macos") {
      await fallbackToBrowser(cleanEmail, cleanCode);
      return;
    }

    // 1. Redeem the code for a registration token.
    let registrationToken: string;
    try {
      const redeemRes = await fetch(`${BASE}/api/v1/enrollment-codes/redeem`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email: cleanEmail, code: cleanCode }),
      });
      const redeemJson = await redeemRes.json().catch(() => ({} as any));
      if (!redeemRes.ok || !redeemJson.success) {
        setError("That code didn't work. Check it or ask the sender to resend.");
        setPhase("input");
        return;
      }
      registrationToken = redeemJson.registration_token;
    } catch (err: any) {
      setError("Network error. Try again.");
      setPhase("input");
      return;
    }

    // 2. Native AS bridge → in-window Touch ID, then server verify.
    try {
      await registerPasskey({
        email:             cleanEmail,
        registrationToken,
        deviceLabel:       "AspisFile Mac",
      });
    } catch (err: any) {
      // Cancelled by user — back to the form.
      if (err instanceof PasskeyError && err.kind === "cancelled") {
        setError("");
        setPhase("input");
        return;
      }
      // Bridge failed for any other reason — fall back to browser.
      // The code is single-use and was already redeemed above, so the
      // browser flow can't re-use it. Show the user a clean message
      // and end this attempt; they'll need a fresh code to retry.
      console.error("[enrolment] native bridge failed:", err);
      setError("In-app enrolment failed. Please ask the sender for a fresh code and try again.");
      setPhase("input");
      return;
    }

    // 3. Immediately authenticate to mint the session token.
    try {
      await authenticatePasskey({ email: cleanEmail });
    } catch (err: any) {
      setError("Enrolment succeeded but sign-in failed. Reopen the app.");
      setPhase("input");
      return;
    }

    onComplete?.();
  }

  function handleRestart() {
    setPhase("input");
    setError("");
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0F172A",
        color: "#E2E8F0",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        padding: 32,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "rgba(255,255,255,0.03)",
          border: "0.5px solid rgba(255,255,255,0.12)",
          borderRadius: 14,
          padding: 32,
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 8 }}>🔒</div>

        {phase === "input" && (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 6px", color: "#F1F5F9" }}>
              I have an enrolment code
            </h1>
            <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 24px" }}>
              Enter your email and the code the sender shared with you. Your browser will open briefly to confirm with Touch ID.
            </p>

            <Label>Email</Label>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(""); }}
              placeholder="you@example.com"
              style={inputStyle}
              autoFocus
            />

            <Label>Enrolment code</Label>
            <input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value); setError(""); }}
              placeholder="anchor-sunset-7421"
              style={{ ...inputStyle, fontFamily: "Menlo, Monaco, 'Courier New', monospace", letterSpacing: 1 }}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            />

            {error ? <p style={{ color: "#FCA5A5", fontSize: 12, marginTop: 14, lineHeight: 1.5 }}>{error}</p> : null}

            <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
              {onCancel && (
                <button onClick={onCancel} style={btnSecondary}>Cancel</button>
              )}
              <button onClick={handleSubmit} style={btnPrimary}>Continue in browser</button>
            </div>

            <p style={{ fontSize: 11, color: "#64748B", marginTop: 18, lineHeight: 1.5 }}>
              Codes expire 60 minutes after they&apos;re emailed, or 24 hours after the sender shows them. Single-use.
            </p>
          </>
        )}

        {phase === "running" && (
          <div style={{ textAlign: "center", padding: "8px 0 0" }}>
            <div
              style={{
                width: 32, height: 32, borderRadius: 16,
                border: "3px solid rgba(255,255,255,0.12)",
                borderTopColor: "#86EFAC",
                margin: "0 auto 18px",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "#F1F5F9", margin: "0 0 8px" }}>
              Confirm with Touch ID
            </h2>
            <p style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 20px" }}>
              Approve the system prompt to finish enrolment.
            </p>
          </div>
        )}

        {phase === "waiting_browser" && (
          <div style={{ textAlign: "center", padding: "8px 0 0" }}>
            <div
              style={{
                width: 32, height: 32, borderRadius: 16,
                border: "3px solid rgba(255,255,255,0.12)",
                borderTopColor: "#86EFAC",
                margin: "0 auto 18px",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "#F1F5F9", margin: "0 0 8px" }}>
              Complete in your browser
            </h2>
            <p style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 20px" }}>
              We&apos;ve opened a secure enrolment page in your default browser. Confirm with {/Mac/i.test(navigator.userAgent) ? "Touch ID" : "Windows Hello"} there — AspisFile will take over automatically when you&apos;re done.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={handleRestart} style={btnSecondary}>Use a different code</button>
              {onCancel && (
                <button onClick={onCancel} style={btnSecondary}>Cancel</button>
              )}
            </div>
          </div>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <p style={{ fontSize: 10, fontWeight: 500, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.6, margin: "12px 0 6px" }}>
      {children}
    </p>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 8,
  border: "0.5px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.04)",
  color: "#E2E8F0",
  fontSize: 14,
  outline: "none",
  fontFamily: "inherit",
};

const btnPrimary: React.CSSProperties = {
  flex: 1,
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  background: "#185FA5",
  color: "#fff",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const btnSecondary: React.CSSProperties = {
  flex: 1,
  padding: "10px 16px",
  borderRadius: 8,
  border: "0.5px solid rgba(255,255,255,0.18)",
  background: "transparent",
  color: "#E2E8F0",
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
};
