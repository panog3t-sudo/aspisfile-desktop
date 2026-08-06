import { useEffect, useState } from "react";
import { getActiveSessionToken, getRecipientSession, RecipientSession } from "../lib/recipient-session";
import { isAfsRenderEnabled, toggleAfsRender } from "../lib/afs-render";

type Props = {
  onLink:   (url: string) => void;
  // Phase A+ Stage 4 — invoked when the user taps "I have an
  // enrollment code". App.tsx switches to the EnrolmentScreen.
  onEnrol?: () => void;
  // Phase 3 — invoked when an enrolled recipient whose session has
  // expired taps "Sign back in". Resolves { ok } on success (App opens
  // any pending file), or { ok:false, message } to show inline.
  onSignIn?: () => Promise<{ ok: boolean; message?: string }>;
};

export function IdleScreen({ onLink, onEnrol, onSignIn }: Props) {
  const [input, setInput] = useState("");
  // Phase A+ UX polish — surface enrolment state on the idle screen so
  // a recipient who already installed the app can either see they're
  // enrolled (and as which email) or find the entry point to enrol
  // without needing a fresh deep-link to arrive first. Mirrors the
  // mobile account.tsx "Recipient identity" card.
  const [session, setSession] = useState<RecipientSession | null>(null);
  // Enrolled on this device but the session token has expired → offer a
  // "Sign back in" affordance instead of a dead "Enrolled" card.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInMsg, setSignInMsg] = useState("");
  // Phase B test toggle — visible in release builds (no devtools to set the
  // localStorage flag from a console). Flipping it takes effect on the next
  // file open (the viewer reads the flag at mount), so no reload needed.
  const [afsOn, setAfsOn] = useState(isAfsRenderEnabled());

  const refresh = () => {
    const s = getRecipientSession();
    setSession(s);
    setNeedsSignIn(!!s && !getActiveSessionToken());
  };

  useEffect(() => {
    refresh();
    const onVisible = () => refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  async function doSignIn() {
    if (!onSignIn || signingIn) return;
    setSignInMsg("");
    setSigningIn(true);
    try {
      const res = await onSignIn();
      if (!res.ok) {
        setSignInMsg(res.message || "Couldn't sign you in on this device. Open your file link from your email.");
      } else {
        refresh(); // App opens any pending file; otherwise the card updates to active.
      }
    } finally {
      setSigningIn(false);
    }
  }

  function handleOpen() {
    const val = input.trim();
    if (val) onLink(val);
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0F172A",
        color: "#94A3B8",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        gap: 16,
        padding: 32,
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 4 }}>🔒</div>
      <p style={{ fontSize: 15, fontWeight: 500, color: "#E2E8F0", margin: 0 }}>
        AspisFile Viewer
      </p>
      <p style={{ fontSize: 13, margin: 0, color: "#64748B" }}>
        Open a secure file link or double-click a .afs file to begin.
      </p>

      {/* Phase A+ UX polish — recipient identity card.
          Enrolled  → show the email + a small "Use another code" link
                      (still routes to EnrolmentScreen, which lets the
                      user enrol an additional code if a sender issues
                      one to a different address on the same device).
          Unenrolled → the original "I have a setup code" button. */}
      {session ? (
        <div
          style={{
            marginTop: 18,
            background: "rgba(255,255,255,0.04)",
            border: "0.5px solid rgba(255,255,255,0.18)",
            borderRadius: 8,
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            maxWidth: 360,
          }}
        >
          <span style={{ fontSize: 10, color: "#64748B", textTransform: "uppercase", letterSpacing: 1 }}>
            Enrolled
          </span>
          <span style={{ fontSize: 13, color: "#E2E8F0", fontWeight: 500, wordBreak: "break-all" }}>
            {session.email}
          </span>

          {needsSignIn && onSignIn && (
            <>
              <p style={{ fontSize: 11, color: "#94A3B8", margin: "6px 0 2px", lineHeight: 1.5, textAlign: "center" }}>
                Your secure session expired.
              </p>
              <button
                onClick={doSignIn}
                disabled={signingIn}
                style={{
                  marginTop: 2,
                  background: "#185FA5",
                  border: "none",
                  color: "#fff",
                  padding: "8px 18px",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: signingIn ? "default" : "pointer",
                  fontFamily: "inherit",
                  opacity: signingIn ? 0.7 : 1,
                }}
              >
                {signingIn ? "Signing you in…" : "Sign back in"}
              </button>
              {signInMsg && (
                <p style={{ fontSize: 11, color: "#FCA5A5", margin: "6px 0 0", lineHeight: 1.5, textAlign: "center", maxWidth: 300 }}>
                  {signInMsg}
                </p>
              )}
            </>
          )}

          {onEnrol && (
            <button
              onClick={onEnrol}
              style={{
                marginTop: 4,
                background: "transparent",
                border: "none",
                color: "#94A3B8",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "inherit",
                textDecoration: "underline",
              }}
            >
              Use a different setup code
            </button>
          )}
        </div>
      ) : (
        onEnrol && (
          // Last-resort fallback — a quiet link, not a prominent button. The
          // primary path is to open the file link (which enrols automatically);
          // this is here for the recipient who was emailed a setup code. Same
          // label as the code email's "tap 'I have a setup code'".
          <button
            onClick={onEnrol}
            style={{
              marginTop: 16,
              background: "transparent",
              border: "none",
              color: "#64748B",
              padding: "6px 8px",
              fontSize: 11,
              cursor: "pointer",
              fontFamily: "inherit",
              textDecoration: "underline",
            }}
          >
            I have a setup code
          </button>
        )
      )}

      {/* Dev-mode URL input — paste a share link to test without deep link */}
      {import.meta.env.DEV && (
        <div
          style={{
            marginTop: 24,
            width: "100%",
            maxWidth: 480,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1 }}>
            Dev — paste share link
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleOpen()}
              placeholder="http://localhost:3000/access/TOKEN?sig=...&env=..."
              style={{
                flex: 1,
                padding: "9px 12px",
                borderRadius: 6,
                border: "0.5px solid #334155",
                background: "#1E293B",
                color: "#E2E8F0",
                fontSize: 12,
                fontFamily: "monospace",
                outline: "none",
              }}
            />
            <button
              onClick={handleOpen}
              disabled={!input.trim()}
              style={{
                padding: "9px 16px",
                borderRadius: 6,
                border: "none",
                background: input.trim() ? "#2563EB" : "#1E293B",
                color: input.trim() ? "#fff" : "#475569",
                fontSize: 13,
                cursor: input.trim() ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              Open
            </button>
          </div>
        </div>
      )}

      {/* .afs render toggle — DEV builds only. A real recipient must never see
          this: tapping it could disable the relay render path. Release builds
          keep the hidden Cmd/Ctrl+Shift+A shortcut (App.tsx) as the safety
          switch. Post-cutover .afs render is always ON by default anyway. */}
      {import.meta.env.DEV && (
        <button
          onClick={() => setAfsOn(toggleAfsRender())}
          style={{
            marginTop: 28,
            background: afsOn ? "rgba(37,99,235,0.18)" : "transparent",
            border: `0.5px solid ${afsOn ? "#2563EB" : "rgba(255,255,255,0.14)"}`,
            color: afsOn ? "#93C5FD" : "#475569",
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: 11,
            cursor: "pointer",
            fontFamily: "monospace",
            letterSpacing: 0.4,
          }}
        >
          .afs render: {afsOn ? "ON" : "OFF"} · tap to toggle
        </button>
      )}
    </div>
  );
}
