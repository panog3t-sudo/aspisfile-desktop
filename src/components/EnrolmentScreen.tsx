import { useState } from "react";
import { registerPasskey, authenticatePasskey, PasskeyError, isPasskeySupported } from "../lib/passkey";

declare const __API_BASE__: string;

const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

// Phase A+ Stage 4 — desktop counterpart of the mobile enrolment
// screen. Recipient enters their email + the one-time code (Tier 1
// email-delivered or Tier 2 sender out-of-band), the app redeems via
// /api/v1/enrollment-codes/redeem, then registers + authenticates a
// passkey via the WebView's native WebAuthn (Touch ID on macOS,
// Windows Hello on Windows).

type Phase = "input" | "redeeming" | "registering" | "success" | "error";

type Props = {
  onComplete?: () => void;
  onCancel?:   () => void;
};

export function EnrolmentScreen({ onComplete, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>("input");
  const [email, setEmail] = useState("");
  const [code,  setCode]  = useState("");
  const [error, setError] = useState("");

  async function handleSubmit() {
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode  = code.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError("Enter your email.");
      return;
    }
    if (cleanCode.length < 4) {
      setError("Enter the enrollment code.");
      return;
    }
    if (!isPasskeySupported()) {
      setError("This system cannot create passkeys. macOS 13+ with Touch ID, or Windows 10+ with Windows Hello, is required.");
      setPhase("error");
      return;
    }

    setPhase("redeeming");
    setError("");

    let registrationToken: string;
    try {
      const res = await fetch(`${BASE}/api/v1/enrollment-codes/redeem`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email: cleanEmail, code: cleanCode }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError("The code was not recognised. Check your email or contact the sender for a fresh code.");
        setPhase("error");
        return;
      }
      registrationToken = json.registration_token;
    } catch (err: any) {
      setError(err?.message ?? "Could not contact AspisFile. Check your network.");
      setPhase("error");
      return;
    }

    setPhase("registering");
    const isMac        = /Mac/i.test(navigator.userAgent);
    const deviceLabel  = `${isMac ? "Mac" : "Windows PC"} · AspisFile Viewer`;

    try {
      await registerPasskey({ email: cleanEmail, registrationToken, deviceLabel });
    } catch (err: any) {
      if (err instanceof PasskeyError) {
        if (err.kind === "cancelled")        setError("Passkey setup was cancelled. Re-enter the code to retry.");
        else if (err.kind === "unsupported") setError("This system cannot create passkeys. Use macOS 13+ with Touch ID, or Windows 10+ with Windows Hello.");
        else if (err.kind === "network")     setError("Could not reach AspisFile during passkey setup. Try again.");
        else                                 setError("Could not register a passkey. Please contact the sender for a new code.");
      } else {
        setError("Could not register a passkey. Please contact the sender for a new code.");
      }
      setPhase("error");
      return;
    }

    // Best-effort immediate auth — same as mobile flow
    try {
      await authenticatePasskey({ email: cleanEmail });
    } catch (err: any) {
      console.warn("[enrolment] post-registration auth failed:", err?.message);
    }

    setPhase("success");
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

        {(phase === "input" || phase === "error") && (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 6px", color: "#F1F5F9" }}>
              I have an enrollment code
            </h1>
            <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 24px" }}>
              Enter your email and the code the sender shared with you.
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

            <Label>Enrollment code</Label>
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
              <button onClick={handleSubmit} style={btnPrimary}>Continue</button>
            </div>

            <p style={{ fontSize: 11, color: "#64748B", marginTop: 18, lineHeight: 1.5 }}>
              Codes expire 60 minutes after they&apos;re emailed, or 24 hours after the sender shows them. Single-use.
            </p>
          </>
        )}

        {phase === "redeeming" && (
          <Centered text="Verifying code…" />
        )}

        {phase === "registering" && (
          <Centered
            text={/Mac/i.test(navigator.userAgent)
              ? "Setting up Touch ID for AspisFile…"
              : "Setting up Windows Hello for AspisFile…"}
            sub="Approve the prompt to finish."
          />
        )}

        {phase === "success" && (
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                width: 56, height: 56, borderRadius: 28,
                background: "rgba(59, 109, 17, 0.2)",
                color: "#86EFAC",
                display: "flex", alignItems: "center", justifyContent: "center",
                margin: "0 auto 14px",
                fontSize: 24, fontWeight: 600,
              }}
            >
              ✓
            </div>
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "#F1F5F9", margin: "0 0 8px" }}>You&apos;re all set</h2>
            <p style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 20px" }}>
              AspisFile is ready on this Mac. When a sender shares a file with you, open the link &mdash; {/Mac/i.test(navigator.userAgent) ? "Touch ID" : "Windows Hello"} will unlock it.
            </p>
            <button onClick={() => onComplete?.()} style={btnPrimary}>Done</button>
          </div>
        )}
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

function Centered({ text, sub }: { text: string; sub?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "16px 0 0" }}>
      <p style={{ fontSize: 13, color: "#94A3B8", margin: 0 }}>{text}</p>
      {sub && <p style={{ fontSize: 11, color: "#64748B", marginTop: 8, lineHeight: 1.5 }}>{sub}</p>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "11px 12px",
  background: "rgba(255,255,255,0.05)",
  border: "0.5px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  color: "#F1F5F9",
  fontSize: 14,
  outline: "none",
  fontFamily: "inherit",
};

const btnPrimary: React.CSSProperties = {
  flex: 1,
  padding: "11px 16px",
  background: "#3B82F6",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const btnSecondary: React.CSSProperties = {
  flex: 1,
  padding: "11px 16px",
  background: "transparent",
  color: "#94A3B8",
  border: "0.5px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};
