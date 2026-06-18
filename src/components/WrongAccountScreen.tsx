// Shown when a deep-link's file recipient does NOT match the identity this
// viewer is signed in as. The viewer must never silently re-authenticate as
// a different recipient (see backend memory: feedback-viewer-identity-binding)
// — switching is a deliberate action the user takes here.

type Props = {
  fileRecipient: string;   // who the file was sent to
  boundEmail:    string;   // who this viewer is signed in as
  onSwitch:      () => void;
  onCancel:      () => void;
};

const btnPrimary: React.CSSProperties = {
  width: "100%", padding: "11px 16px", borderRadius: 8, border: "none",
  background: "#2E55D4", color: "#fff", fontSize: 13, fontWeight: 600,
  cursor: "pointer", fontFamily: "inherit",
};
const btnSecondary: React.CSSProperties = {
  width: "100%", padding: "10px 16px", borderRadius: 8,
  border: "0.5px solid rgba(255,255,255,0.18)", background: "transparent",
  color: "#94A3B8", fontSize: 12.5, fontWeight: 500, cursor: "pointer",
  fontFamily: "inherit", marginTop: 10,
};

export function WrongAccountScreen({ fileRecipient, boundEmail, onSwitch, onCancel }: Props) {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0F172A", color: "#E2E8F0",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", padding: 32,
    }}>
      <div style={{
        maxWidth: 420, width: "100%", background: "rgba(255,255,255,0.03)",
        border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 32,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 18, marginBottom: 16,
          background: "rgba(46,85,212,0.18)", color: "#9FB4F2",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
        }}>🔒</div>

        <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px", color: "#F1F5F9" }}>
          This file is for a different account
        </h1>
        <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 18px" }}>
          It was sent to <strong style={{ color: "#E2E8F0" }}>{fileRecipient}</strong>, but this
          viewer is signed in as <strong style={{ color: "#E2E8F0" }}>{boundEmail}</strong>. For
          security, a file only opens for the account it was sent to.
        </p>

        <button onClick={onSwitch} style={btnPrimary}>
          Switch to {fileRecipient}
        </button>
        <button onClick={onCancel} style={btnSecondary}>
          Cancel
        </button>

        <p style={{ fontSize: 11, color: "#64748B", marginTop: 18, lineHeight: 1.5 }}>
          Switching signs this viewer out of {boundEmail} and asks you to sign in as{" "}
          {fileRecipient} (Touch ID / your enrolment).
        </p>
      </div>
    </div>
  );
}
