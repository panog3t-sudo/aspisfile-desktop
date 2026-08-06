import { useEffect, useRef, useState } from "react";
import { saveRecipientSession } from "../lib/recipient-session";

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

// Shown during Phase 2 cross-vault re-auth: the recipient IS enrolled, but
// their session expired and their passkey isn't usable by the native bridge
// on this device (e.g. a Google Password Manager passkey on a Mac). The viewer
// has opened the browser sign-in page (/auth/desktop-verify), which runs a real
// WebAuthn assertion (any vault, phone-QR capable). This screen:
//
//   • Always tells the recipient what's happening and what to do — never blank.
//   • Polls /access/<token>/reauth-status, which mints a session once a fresh
//     passkey assertion exists — so this works on Mac AND Windows regardless of
//     which vault the passkey lives in, with no native/deep-link dependency.
type Props = {
  token:       string;          // the file access token (gate for reauth-status)
  email:       string | null;   // display only
  verifyUrl:   string | null;   // /auth/desktop-verify URL, for manual-open fallback
  openFailed?: boolean;         // the viewer couldn't open the browser automatically
  onComplete:  () => void;      // a session was saved; caller replays the pending file link
  onCancel:    () => void;      // recipient backed out
};

export function ReauthWaitingScreen({ token, email, verifyUrl, openFailed, onComplete, onCancel }: Props) {
  const [slow, setSlow]       = useState(false);
  const [invalid, setInvalid] = useState(false);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });

  useEffect(() => {
    let cancelled = false;

    const slowTimer = window.setTimeout(() => { if (!cancelled) setSlow(true); }, 25_000);

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${BASE}/api/v1/access/${token}/reauth-status`, {
          method: "POST",
        });
        if (res.status === 404) {
          // The file link itself is no longer valid — stop and say so.
          if (!cancelled) setInvalid(true);
          return;
        }
        if (res.ok) {
          const j = await res.json().catch(() => ({} as any));
          if (j?.status === "complete" && j.session_token && j.email && j.passkey_id) {
            if (cancelled) return;
            saveRecipientSession({
              email:     j.email,
              token:     j.session_token,
              passkeyId: j.passkey_id,
              expiresIn: Number.isFinite(j.expires_in) && j.expires_in > 0 ? j.expires_in : 28800,
            });
            onCompleteRef.current();
            return;
          }
        }
      } catch {
        // Offline / transient — keep polling.
      }
      if (!cancelled) window.setTimeout(tick, 2_000);
    };
    window.setTimeout(tick, 2_000);

    return () => { cancelled = true; window.clearTimeout(slowTimer); };
  }, [token]);

  const mode: "invalid" | "open_failed" | "waiting" =
    invalid ? "invalid" : openFailed ? "open_failed" : "waiting";

  const forWhom = email ? ` as ${email}` : "";

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 22, marginBottom: 14 }}>{mode === "invalid" ? "⚠️" : "🔑"}</div>

        {(mode === "waiting" || mode === "open_failed") && (
          <>
            <div style={spinner} />
            <h1 style={title}>Signing you back in</h1>

            {mode === "open_failed" ? (
              <>
                <p style={sub}>
                  We couldn&apos;t open your browser automatically. Copy this link into your
                  browser to confirm it&apos;s you{forWhom} — this viewer will continue on its
                  own the moment you&apos;re done.
                </p>
                {verifyUrl && <p style={linkBox}>{verifyUrl}</p>}
              </>
            ) : slow ? (
              <p style={sub}>
                Still waiting for you to confirm in the browser. If you&apos;ve already done it,
                this will finish in a few seconds — we&apos;re checking with the server directly.
                Your browser may also be asking permission to reopen AspisFile Viewer; allow it if so.
              </p>
            ) : (
              <p style={sub}>
                Your secure session expired, so we need to confirm it&apos;s you again. Approve it
                in the browser window we just opened{forWhom} — with Touch ID, Face ID, or your
                phone. Your document opens in this viewer automatically when you&apos;re done.
              </p>
            )}
          </>
        )}

        {mode === "invalid" && (
          <>
            <h1 style={title}>This file link is no longer valid</h1>
            <p style={sub}>
              Reopen the file link from your email to continue — the sender may have set it to
              expire, or it has already been superseded.
            </p>
          </>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 24, justifyContent: "center" }}>
          <button onClick={onCancel} style={btnSecondary}>
            {mode === "invalid" ? "Back" : "Cancel"}
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const wrap: React.CSSProperties = {
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0F172A",
  color: "#E2E8F0",
  fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
  padding: 32,
};

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  background: "rgba(255,255,255,0.03)",
  border: "0.5px solid rgba(255,255,255,0.12)",
  borderRadius: 14,
  padding: 32,
  textAlign: "center",
};

const spinner: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 16,
  border: "3px solid rgba(255,255,255,0.12)",
  borderTopColor: "#86EFAC",
  margin: "0 auto 18px",
  animation: "spin 0.8s linear infinite",
};

const title: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  color: "#F1F5F9",
  margin: "0 0 8px",
};

const sub: React.CSSProperties = {
  fontSize: 12.5,
  color: "#94A3B8",
  lineHeight: 1.6,
  margin: "0 0 4px",
};

const linkBox: React.CSSProperties = {
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  fontSize: 11,
  color: "#93C5FD",
  background: "rgba(255,255,255,0.04)",
  border: "0.5px solid rgba(255,255,255,0.10)",
  borderRadius: 6,
  padding: "8px 10px",
  margin: "12px 0 0",
  wordBreak: "break-all",
  userSelect: "all",
};

const btnSecondary: React.CSSProperties = {
  padding: "10px 20px",
  borderRadius: 8,
  border: "0.5px solid rgba(255,255,255,0.18)",
  background: "transparent",
  color: "#E2E8F0",
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
};
