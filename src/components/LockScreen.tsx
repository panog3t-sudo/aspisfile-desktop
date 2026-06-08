import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { supabase } from "../lib/supabase";
import { useLock, BIOMETRIC_FRESH_MS } from "../contexts/LockContext";
import { getActiveSessionToken } from "../lib/recipient-session";

declare const __API_BASE__: string;

type Props = {
  // Optional — when present the LockScreen is gating a specific file
  // (per-file lock inside SecureViewer); when absent the LockScreen is
  // gating the app itself (cold-start / idle lock).
  fileName?: string;
  onUnlock: () => void;
};

// Phase 1 Day 9.6 — LockScreen extended with PIN fallback.
//
// Reads the recipient's chosen mechanisms from LockContext:
//   - biometricEnabled + biometricAvailable → auto-prompts the Tauri
//     authenticate_biometric command on mount and window focus
//   - pinSet → renders the 6-digit PIN input; submits to
//     /api/v1/recipient-devices/me/verify-pin via Bearer
//
// Pre-Day-9 behaviour was biometric-only with retry on window focus.
// That focus retry stays (it's how the recipient re-tries biometric
// after dismissing the OS prompt); the new addition is a PIN fallback
// that surfaces alongside the biometric retry button.

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

export function LockScreen({ fileName, onUnlock }: Props) {
  const { biometricEnabled, biometricAvailable, pinSet, recordBiometric, lastBiometricAt, tryBeginBiometric, endBiometric } = useLock();

  // Phase A+ recipients (passkey-only, no Supabase session, never went
  // through SetupModal) have biometricEnabled=false and pinSet=false
  // by default. Without this check, the LockScreen would render "No
  // unlock mechanism is configured" and the recipient is stuck after
  // the idle-timeout lock fires.
  //
  // Treat "active recipient session token exists" as implicit
  // biometric-enabled — the recipient already proved Touch ID at file
  // open via the per-file gate (App.tsx::openLink). The lock is an
  // inactivity gate; same biometric re-confirms presence.
  const hasRecipientSession = !!getActiveSessionToken();
  const canUseBiometric = biometricAvailable && (biometricEnabled || hasRecipientSession);

  const [pin,    setPin]    = useState("");
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState("");
  const [status, setStatus] = useState<"idle" | "verifying" | "error">("idle");
  const inProgressRef = useRef(false);

  const attemptBiometric = async () => {
    if (inProgressRef.current) return;
    if (!canUseBiometric) return;
    // Dedup: a sibling biometric (the app-level LockScreen, or
    // openLink's per-file gate, or this same screen's prior attempt
    // in another mount) was just confirmed. Pass through without
    // prompting again. Avoids the v1.7.11 "two Touch IDs on return
    // from background" UX issue.
    if (Date.now() - lastBiometricAt < BIOMETRIC_FRESH_MS) {
      onUnlock();
      return;
    }
    // Hard global mutex — another biometric is in flight; bail out
    // and let the in-progress one win. When it completes, this
    // useEffect re-fires (deps include lastBiometricAt) and the
    // freshness check above passes through.
    if (!tryBeginBiometric()) {
      return;
    }
    inProgressRef.current = true;
    setStatus("verifying");
    setError("");
    try {
      await invoke("authenticate_biometric");
      recordBiometric();
      onUnlock();
    } catch {
      setStatus("error");
    } finally {
      inProgressRef.current = false;
      endBiometric();
    }
  };

  // Auto-prompt biometric on mount only. Earlier this also re-fired
  // on every window-focus event so cold-start launches caught the
  // OS biometric dialog correctly. Side-effect: cancelling Touch ID
  // returns focus to the window → focus handler re-fires → Touch ID
  // pops again, trapping the user in a prompt loop. They had to
  // cancel several times before falling through to PIN. Now we only
  // auto-attempt once on mount; if the user cancels, the manual
  // "Use Touch ID" button (further down this screen) is the way back.
  useEffect(() => {
    attemptBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseBiometric]);

  const verifyPin = async () => {
    if (busy) return;
    if (!/^\d{6}$/.test(pin)) {
      setError("Enter the 6-digit PIN.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
      const fp = await getFingerprint();
      const res = await fetch(`${__API_BASE__}/api/v1/recipient-devices/me/verify-pin`, {
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          "X-App-Platform": "desktop",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ deviceFingerprint: fp, pin }),
      });
      const json = await res.json();
      if (res.ok && json.status === "ok") {
        setPin("");
        recordBiometric();
        onUnlock();
        return;
      }
      if (res.status === 429) {
        setError("Too many attempts. Please wait a few minutes.");
      } else if (json.error === "INVALID_PIN") {
        setError("Incorrect PIN.");
      } else if (json.error === "NO_PIN_SET") {
        setError("No PIN is configured on this device.");
      } else if (json.error === "DEVICE_REVOKED") {
        setError("This device has been revoked. Sign in again.");
      } else {
        setError(json.detail || json.error || "Could not verify PIN.");
      }
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  const signOutEscape = async () => {
    await supabase.auth.signOut({ scope: "local" });
    // App.tsx's auth listener will route to idle; onUnlock is a no-op
    // here because there's nothing to unlock into.
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#000",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        userSelect: "none",
        WebkitUserSelect: "none",
      } as React.CSSProperties}
    >
      <span style={{ fontSize: 44, lineHeight: 1 }}>🔒</span>

      <p style={{ color: "#F1F5F9", fontSize: 15, fontWeight: 500, margin: 0 }}>
        {fileName ? 'Viewer locked' : 'AspisFile locked'}
      </p>

      {fileName && (
        <p
          style={{
            color: "#475569",
            fontSize: 12,
            margin: 0,
            maxWidth: 320,
            textAlign: "center",
            lineHeight: 1.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fileName}
        </p>
      )}

      {canUseBiometric && (
        <button
          onClick={attemptBiometric}
          disabled={status === "verifying"}
          style={{
            marginTop: 8,
            padding: "8px 18px",
            borderRadius: 8,
            background: "transparent",
            color: "#3B82F6",
            border: "0.5px solid rgba(255,255,255,0.18)",
            fontSize: 12,
            fontWeight: 500,
            cursor: status === "verifying" ? "default" : "pointer",
            fontFamily: "inherit",
          }}
        >
          {status === "verifying" ? "Waiting for authentication…" : "Use Touch ID / Windows Hello"}
        </button>
      )}

      {pinSet && (
        <div style={{ width: "100%", maxWidth: 280, marginTop: 12 }}>
          <input
            value={pin}
            onChange={e => { setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
            onKeyDown={e => { if (e.key === "Enter" && pin.length === 6) verifyPin(); }}
            placeholder="••••••"
            type="password"
            inputMode="numeric"
            maxLength={6}
            autoFocus={!biometricEnabled || !biometricAvailable}
            style={{
              width: "100%",
              padding: 14,
              borderRadius: 8,
              background: "rgba(255,255,255,0.05)",
              color: "#fff",
              border: "0.5px solid rgba(255,255,255,0.12)",
              fontSize: 20,
              letterSpacing: "0.5em",
              textAlign: "center",
              fontFamily: "'SF Mono','Menlo',monospace",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: 8,
            }}
          />
          <button
            onClick={verifyPin}
            disabled={busy || pin.length !== 6}
            style={{
              width: "100%",
              padding: "11px 14px",
              borderRadius: 8,
              background: (busy || pin.length !== 6) ? "rgba(255,255,255,0.08)" : "#3B82F6",
              color: (busy || pin.length !== 6) ? "rgba(255,255,255,0.35)" : "#fff",
              border: "none",
              fontSize: 13,
              fontWeight: 500,
              cursor: (busy || pin.length !== 6) ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {busy ? "Verifying…" : "Unlock"}
          </button>
        </div>
      )}

      {!pinSet && !canUseBiometric && (
        <p style={{ color: "#94A3B8", fontSize: 12, margin: "12px 0 0", maxWidth: 280, textAlign: "center", lineHeight: 1.5 }}>
          No unlock mechanism is configured. Sign out and sign in again to set one.
        </p>
      )}

      {error && (
        <p style={{ color: "#FCA5A5", fontSize: 11, margin: "8px 0 0", textAlign: "center" }}>
          {error}
        </p>
      )}

      {status === "error" && !error && (
        <p style={{ color: "#EF4444", fontSize: 11, margin: "8px 0 0" }}>
          Authentication failed — try again
        </p>
      )}

      <button
        onClick={signOutEscape}
        style={{
          marginTop: 16,
          background: "none",
          border: "none",
          color: "rgba(255,255,255,0.35)",
          fontSize: 11,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        Sign out
      </button>
    </div>
  );
}
