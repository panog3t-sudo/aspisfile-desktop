import { useEffect, useRef, useState } from "react";
import { saveRecipientSession } from "../lib/recipient-session";

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

// Shown while the browser-side WebAuthn enrolment is in progress (the
// rt auto-enrolment path from App.tsx). Its whole reason to exist is so
// the viewer NEVER sits on a blank idle screen during setup, and so a
// blocked aspisfile:// deep link can't strand the recipient:
//
//   • It always shows the recipient what is happening and what to do.
//   • It polls /enrol-status directly (same rt the browser is using), so
//     the moment their passkey exists server-side the viewer takes over
//     on its own — the deep link stays the fast path but is no longer
//     the ONLY path (the failure that stranded a real recipient).
//   • It reports link-expiry explicitly instead of spinning forever.
//
// enrol-status mints a session for ANY non-revoked passkey on the email,
// regardless of which vault (iCloud / Google / Hello) created it — so this
// path also sidesteps the cross-vault re-auth gap for first enrolment.
type Props = {
  rt:          string | null;   // registration token; null when setup couldn't start
  email:       string | null;   // for display only — the session email comes from the server
  enrolUrl:    string | null;   // the /enroll/desktop URL, for the manual-open fallback
  openFailed?: boolean;         // the viewer couldn't open the browser automatically
  startError?: string | null;   // setup couldn't start at all (e.g. couldn't resolve the recipient)
  onComplete:  () => void;      // a session was saved; caller replays the pending file link
  onCancel:    () => void;      // recipient backed out
  onEnterCode?: () => void;     // last-resort: open the manual setup-code screen. Only
                                // surfaced once automatic setup has FAILED (expired /
                                // couldn't start), so the code is a fallback, not a
                                // co-equal first option.
};

export function EnrolmentWaitingScreen({ rt, email, enrolUrl, openFailed, startError, onComplete, onCancel, onEnterCode }: Props) {
  const [slow, setSlow]       = useState(false);
  const [expired, setExpired] = useState(false);

  // Keep onComplete in a ref so the poll effect doesn't tear down and
  // restart (resetting its timers) every time the parent re-renders.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });

  useEffect(() => {
    if (!rt || startError) return;   // nothing to poll for
    let cancelled = false;

    const slowTimer = window.setTimeout(() => { if (!cancelled) setSlow(true); }, 25_000);

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${BASE}/api/v1/recipient-passkeys/enrol-status`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${rt}` },
        });
        if (res.status === 401) {
          // Registration token expired (10-min TTL). Stop and tell the
          // recipient plainly rather than polling a dead token forever.
          if (!cancelled) setExpired(true);
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
        // Offline / transient — keep polling; the interval handles retry.
      }
      if (!cancelled) window.setTimeout(tick, 2_000);
    };
    window.setTimeout(tick, 2_000);

    return () => { cancelled = true; window.clearTimeout(slowTimer); };
  }, [rt, startError]);

  // ── Which state are we in? Always resolves to a screen with a clear
  //    message — there is deliberately no path that renders nothing. ──
  const mode: "start_failed" | "expired" | "open_failed" | "waiting" =
    startError ? "start_failed"
    : expired  ? "expired"
    : openFailed ? "open_failed"
    : "waiting";

  const forWhom = email ? ` for ${email}` : "";

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 22, marginBottom: 14 }}>
          {mode === "expired" || mode === "start_failed" ? "⚠️" : "🔒"}
        </div>

        {(mode === "waiting" || mode === "open_failed") && (
          <>
            <div style={spinner} />
            <h1 style={title}>Setting up secure access</h1>

            {mode === "open_failed" ? (
              <>
                <p style={sub}>
                  We couldn&apos;t open your browser automatically. Copy this link into your
                  browser to confirm it&apos;s you and finish setup — this viewer will continue
                  on its own the moment you&apos;re done.
                </p>
                {enrolUrl && (
                  <p style={linkBox}>{enrolUrl}</p>
                )}
              </>
            ) : slow ? (
              <p style={sub}>
                Still waiting for you to confirm in the browser. If you&apos;ve already done it,
                this will catch up in a few seconds — we&apos;re checking with the server directly.
                Your browser may also be asking permission to reopen AspisFile Viewer; allow it if so.
              </p>
            ) : (
              <p style={sub}>
                Confirm it&apos;s you in the browser window we just opened{forWhom} — with Touch ID,
                Face ID, or your phone. You don&apos;t need to come back here; the document opens in
                this viewer automatically when you&apos;re done.
              </p>
            )}
          </>
        )}

        {mode === "expired" && (
          <>
            <h1 style={title}>Setup link expired</h1>
            <p style={sub}>
              For your security the setup link is only valid for a few minutes. Reopen the
              file link from your email to start again — it only takes a moment.
            </p>
          </>
        )}

        {mode === "start_failed" && (
          <>
            <h1 style={title}>Couldn&apos;t start setup</h1>
            <p style={sub}>{startError || "Reopen the file link from your email to try again."}</p>
          </>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 24, justifyContent: "center" }}>
          <button onClick={onCancel} style={btnSecondary}>
            {mode === "waiting" || mode === "open_failed" ? "Cancel" : "Back"}
          </button>
          {/* Last-resort manual path — only on a CONFIRMED/certain failure
              (link expired, setup couldn't start, or the browser wouldn't
              open), never while setup is still in progress. Leads to the
              enrolment-code screen, which finishes with native Touch ID and
              needs no browser. */}
          {(mode === "expired" || mode === "start_failed" || mode === "open_failed") && onEnterCode && (
            <button onClick={onEnterCode} style={btnSecondary}>
              I have a setup code
            </button>
          )}
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
