import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

// Path B browser-redirect enrolment. WKWebView's in-window WebAuthn
// doesn't work reliably in Tauri custom-window apps on macOS Tahoe
// (Code=1004 + nil credential — see the deferred native AS bridge
// memory). We delegate to the user's default browser, where Safari
// or Chrome run the WebAuthn ceremony natively against
// aspisfile.com as the RP and post the result back to AspisFile via
// the aspisfile:// custom scheme.
//
// Flow on this screen:
//   1. User enters email + enrolment code, clicks Continue.
//   2. We validate locally, then openUrl(<enrol-landing>) → default
//      browser opens to /enroll/desktop?email=…&code=….
//   3. Browser tab does the redeem + register-options + Touch ID +
//      register-verify dance.
//   4. Browser tab redirects to aspisfile://enrol-complete?session_
//      token=…&email=…&passkey_id=…&expires_in=…
//   5. App.tsx's deep-link handler picks it up, saves the session
//      via saveRecipientSession(), dismisses this screen, replays
//      any pending share-link.
//
// This screen sits in "waiting" mode after step 2 until step 5
// fires (or the user clicks "Cancel"). There's no way for the
// browser to push an error state back into this screen — the user
// would see the failure in the browser tab and come back to retry.

type Phase = "input" | "waiting";

type Props = {
  onComplete?: () => void;
  onCancel?:   () => void;
};

export function EnrolmentScreen({ onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>("input");
  const [email, setEmail] = useState("");
  const [code,  setCode]  = useState("");
  const [error, setError] = useState("");

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
    setPhase("waiting");

    const url = new URL(`${BASE}/enroll/desktop`);
    url.searchParams.set("email", cleanEmail);
    url.searchParams.set("code",  cleanCode);

    try {
      await openUrl(url.toString());
    } catch (err: any) {
      setError("Could not open your browser. Copy and open this link manually: " + url.toString());
      setPhase("input");
    }
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

        {phase === "waiting" && (
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
