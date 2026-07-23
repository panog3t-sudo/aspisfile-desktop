import { useState } from "react";

// Recipient feedback (Phase 1) — floating "Respond" control.
//
// Self-contained overlay: it renders ABOVE the tiles and never touches the
// tile renderer, decrypt path, watermark, or any security gate. It only POSTs
// a decision + optional note to the session-gated /response endpoint. Shown
// only when the server set recipient_feedback (flag RECIPIENT_FEEDBACK).

declare const __API_BASE__: string;

type Decision = "approved" | "changes_requested" | "rejected";

const CHOICES: { key: Decision; label: string; color: string; bg: string; border: string; icon: string }[] = [
  { key: "approved",          label: "Approve",         color: "#3FB980", bg: "#14311F", border: "#1F6B44", icon: "✓" },
  { key: "changes_requested", label: "Request changes", color: "#E0A54B", bg: "#332510", border: "#7A561D", icon: "!" },
  { key: "rejected",          label: "Reject",          color: "#E96B5C", bg: "#331512", border: "#7C332A", icon: "✕" },
];

const SENT_LABEL: Record<Decision, string> = {
  approved: "Approved", changes_requested: "Changes requested", rejected: "Rejected",
};

export function RespondControl({ fileId, sessionId }: { fileId: string; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Decision | null>(null);

  const openSheet = () => { setDecision(sent); setError(null); setOpen(true); };

  const submit = async () => {
    if (!decision || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/viewer/${fileId}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Platform": "desktop" },
        body: JSON.stringify({ session_id: sessionId, decision, note: note.trim() || undefined }),
      });
      if (!res.ok) { setError("Couldn’t send your response. Please try again."); setBusy(false); return; }
      setSent(decision); setOpen(false); setBusy(false);
    } catch {
      setError("Couldn’t reach the server. Please try again."); setBusy(false);
    }
  };

  return (
    <>
      {/* Floating trigger — bottom center, out of the toolbar's way */}
      {!open && (
        <button
          onClick={openSheet}
          style={{
            position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 998,
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "10px 18px", borderRadius: 999, cursor: "pointer",
            fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
            fontSize: 13, fontWeight: 640,
            border: sent ? "1px solid #1F6B44" : "1px solid #2E3760",
            background: sent ? "#12301F" : "#1A1F3A",
            color: sent ? "#7CE0B0" : "#EAEFFB",
            boxShadow: "0 8px 22px rgba(0,0,0,.45)",
          }}
        >
          <span aria-hidden style={{ fontSize: 14 }}>{sent ? "✓" : "✎"}</span>
          {sent ? `Responded · ${SENT_LABEL[sent]}` : "Respond"}
        </button>
      )}

      {/* Sheet */}
      {open && (
        <div
          onClick={() => !busy && setOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 10001,
            background: "rgba(4,6,14,.55)", display: "flex", alignItems: "flex-end", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 460, margin: 12,
              background: "#141830", border: "1px solid #2E3760", borderRadius: 16,
              padding: "16px 16px 18px", boxShadow: "0 24px 60px rgba(0,0,0,.6)",
              fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", color: "#EAEFFB",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 13 }}>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 660 }}>How do you want to respond?</h3>
              <button onClick={() => setOpen(false)} disabled={busy}
                style={{ marginLeft: "auto", background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
              {CHOICES.map((c) => {
                const on = decision === c.key;
                return (
                  <button key={c.key} onClick={() => setDecision(c.key)}
                    style={{
                      border: `1px solid ${on ? c.color : c.border}`, borderRadius: 11, padding: "12px 6px",
                      background: on ? c.bg : "transparent", cursor: "pointer",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 7,
                      boxShadow: on ? `0 0 0 1px ${c.color} inset` : "none",
                    }}>
                    <span style={{
                      width: 32, height: 32, borderRadius: 9, background: c.bg, color: c.color,
                      display: "grid", placeItems: "center", fontSize: 16, fontWeight: 700,
                    }}>{c.icon}</span>
                    <span style={{ fontSize: 12, fontWeight: 640, color: c.color }}>{c.label}</span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 13 }}>
              <label style={{ display: "block", fontSize: 11.5, color: "#9098BC", marginBottom: 6, fontWeight: 600 }}>
                Add a note <span style={{ color: "#666E96", fontWeight: 400 }}>(optional)</span>
              </label>
              <textarea
                value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
                placeholder="Anything you’d like the sender to know…"
                style={{
                  width: "100%", minHeight: 68, resize: "vertical", boxSizing: "border-box",
                  border: "1px solid #2E3760", background: "#080A14", color: "#EAEFFB",
                  borderRadius: 10, padding: "10px 12px", fontSize: 13, lineHeight: 1.5, fontFamily: "inherit",
                }}
              />
            </div>

            {error && <div style={{ color: "#E96B5C", fontSize: 12, marginTop: 9 }}>{error}</div>}

            <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 13 }}>
              <button onClick={submit} disabled={!decision || busy}
                style={{
                  flex: 1, background: !decision || busy ? "#26305A" : "#2E55D4", color: "#fff",
                  border: "none", borderRadius: 10, padding: 11, fontSize: 13.5, fontWeight: 660,
                  cursor: !decision || busy ? "default" : "pointer",
                }}>
                {busy ? "Sending…" : sent ? "Update my response" : "Send to sender"}
              </button>
              <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11, color: "#9098BC", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span aria-hidden style={{ color: "#7C9CF5" }}>🛡</span>Signed with your passkey
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
