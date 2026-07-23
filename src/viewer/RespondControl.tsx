import { useState, useCallback } from "react";

// Recipient feedback — floating "Your feedback" thread control.
//
// Self-contained overlay: renders ABOVE the tiles, never touches the tile
// renderer, decrypt path, watermark, or any security gate. It reads THIS
// recipient's own feedback thread (GET /feedback) and appends new entries
// (POST /response). Sent entries are read-only; "+ Add" appends more. Shown
// only when the server set recipient_feedback (flag RECIPIENT_FEEDBACK).

declare const __API_BASE__: string;

type Decision = "approved" | "changes_requested" | "rejected";
type Entry =
  | { kind: "decision"; id: string; decision: Decision; note: string | null; created_at: string; is_current: boolean }
  | { kind: "comment"; id: string; body: string; page: number; created_at: string };

const CHOICES: { key: Decision; label: string; color: string; bg: string; border: string; icon: string }[] = [
  { key: "approved",          label: "Approve",         color: "#3FB980", bg: "#14311F", border: "#1F6B44", icon: "✓" },
  { key: "changes_requested", label: "Request changes", color: "#E0A54B", bg: "#332510", border: "#7A561D", icon: "!" },
  { key: "rejected",          label: "Reject",          color: "#E96B5C", bg: "#331512", border: "#7C332A", icon: "✕" },
];
const DECISION_META: Record<Decision, { label: string; color: string; bg: string; icon: string }> = {
  approved:          { label: "Approved",          color: "#3FB980", bg: "#14311F", icon: "✓" },
  changes_requested: { label: "Changes requested", color: "#E0A54B", bg: "#332510", icon: "!" },
  rejected:          { label: "Rejected",          color: "#E96B5C", bg: "#331512", icon: "✕" },
};

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

export function RespondControl({ fileId, sessionId }: { fileId: string; sessionId: string }) {
  const [open, setOpen]         = useState(false);
  const [entries, setEntries]   = useState<Entry[]>([]);
  const [loaded, setLoaded]     = useState(false);
  const [compose, setCompose]   = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote]         = useState("");
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/viewer/${fileId}/feedback?session=${encodeURIComponent(sessionId)}`,
        { headers: { "X-App-Platform": "desktop" } });
      if (res.ok) {
        const json = await res.json();
        setEntries(Array.isArray(json.entries) ? json.entries : []);
      }
    } catch { /* keep last */ }
    setLoaded(true);
  }, [fileId, sessionId]);

  const openPanel = () => { setOpen(true); setError(null); if (!loaded) load(); };

  const currentDecision = [...entries].reverse().find((e): e is Extract<Entry, { kind: "decision" }> => e.kind === "decision" && e.is_current);
  const hasEntries = entries.length > 0;

  const submit = async () => {
    if (!decision || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/viewer/${fileId}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Platform": "desktop" },
        body: JSON.stringify({ session_id: sessionId, decision, note: note.trim() || undefined }),
      });
      if (!res.ok) { setError("Couldn’t send. Please try again."); setBusy(false); return; }
      setBusy(false); setCompose(false); setDecision(null); setNote("");
      await load();
    } catch {
      setError("Couldn’t reach the server. Please try again."); setBusy(false);
    }
  };

  return (
    <>
      {!open && (
        <button onClick={openPanel}
          style={{
            position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 998,
            display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 999, cursor: "pointer",
            fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", fontSize: 13, fontWeight: 640,
            border: hasEntries ? "1px solid #1F6B44" : "1px solid #2E3760",
            background: hasEntries ? "#12301F" : "#1A1F3A", color: hasEntries ? "#7CE0B0" : "#EAEFFB",
            boxShadow: "0 8px 22px rgba(0,0,0,.45)",
          }}>
          <span aria-hidden style={{ fontSize: 14 }}>{hasEntries ? "✓" : "✎"}</span>
          {hasEntries ? `Your feedback${currentDecision ? ` · ${DECISION_META[currentDecision.decision].label}` : ""}` : "Respond"}
        </button>
      )}

      {open && (
        <div onClick={() => !busy && setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(4,6,14,.55)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 460, margin: 12, background: "#141830", border: "1px solid #2E3760", borderRadius: 16,
              padding: "16px 16px 18px", boxShadow: "0 24px 60px rgba(0,0,0,.6)", maxHeight: "80vh", display: "flex", flexDirection: "column",
              fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", color: "#EAEFFB",
            }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 660 }}>Your feedback</h3>
              <button onClick={() => setOpen(false)} disabled={busy}
                style={{ marginLeft: "auto", background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
            </div>

            {/* Thread — read-only, in time order */}
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 9, paddingRight: 2 }}>
              {!loaded ? (
                <div style={{ color: "#9098BC", fontSize: 12.5, padding: "10px 0" }}>Loading…</div>
              ) : !hasEntries ? (
                <div style={{ color: "#9098BC", fontSize: 12.5, padding: "6px 0 10px", lineHeight: 1.5 }}>
                  You haven’t sent any feedback yet. Add your response or a note below.
                </div>
              ) : entries.map((e) => e.kind === "decision" ? (
                <div key={e.id} style={{ border: "1px solid #242B4C", borderRadius: 10, padding: "10px 11px", background: "#0E1228" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: DECISION_META[e.decision].bg, color: DECISION_META[e.decision].color, fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6 }}>
                      <span aria-hidden>{DECISION_META[e.decision].icon}</span>{DECISION_META[e.decision].label}
                    </span>
                    {e.is_current && <span style={{ fontSize: 9.5, fontWeight: 700, color: "#7C9CF5", letterSpacing: ".04em" }}>◀ CURRENT</span>}
                    <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 10, color: "#666E96" }}>{fmtTime(e.created_at)}</span>
                  </div>
                  {e.note && <div style={{ fontSize: 12.5, color: "#C9CFEA", marginTop: 7, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{e.note}</div>}
                </div>
              ) : (
                <div key={e.id} style={{ border: "1px solid #242B4C", borderRadius: 10, padding: "10px 11px", background: "#0E1228" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 10, fontWeight: 700, color: "#7C9CF5", background: "#1C2347", padding: "2px 7px", borderRadius: 999 }}>💬 PAGE {e.page}</span>
                    <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 10, color: "#666E96" }}>{fmtTime(e.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "#C9CFEA", marginTop: 7, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{e.body}</div>
                </div>
              ))}
            </div>

            {/* Compose / + Add */}
            {!compose ? (
              <button onClick={() => { setCompose(true); setDecision(null); setNote(""); }}
                style={{ marginTop: 12, alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 14px", borderRadius: 10, border: "1px solid #2E3760", background: "#1A1F3A", color: "#EAEFFB", cursor: "pointer", fontSize: 13, fontWeight: 620 }}>
                <span aria-hidden style={{ fontSize: 15 }}>＋</span>{hasEntries ? "Add response or note" : "Add your response"}
              </button>
            ) : (
              <div style={{ marginTop: 12, borderTop: "1px solid #242B4C", paddingTop: 13 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
                  {CHOICES.map((c) => {
                    const on = decision === c.key;
                    return (
                      <button key={c.key} onClick={() => setDecision(c.key)}
                        style={{ border: `1px solid ${on ? c.color : c.border}`, borderRadius: 11, padding: "11px 6px", background: on ? c.bg : "transparent", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, boxShadow: on ? `0 0 0 1px ${c.color} inset` : "none" }}>
                        <span style={{ width: 30, height: 30, borderRadius: 9, background: c.bg, color: c.color, display: "grid", placeItems: "center", fontSize: 15, fontWeight: 700 }}>{c.icon}</span>
                        <span style={{ fontSize: 11.5, fontWeight: 640, color: c.color }}>{c.label}</span>
                      </button>
                    );
                  })}
                </div>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Add a note (optional)…"
                  style={{ width: "100%", minHeight: 56, resize: "vertical", boxSizing: "border-box", marginTop: 11, border: "1px solid #2E3760", background: "#080A14", color: "#EAEFFB", borderRadius: 10, padding: "10px 12px", fontSize: 13, lineHeight: 1.5, fontFamily: "inherit" }} />
                {error && <div style={{ color: "#E96B5C", fontSize: 12, marginTop: 8 }}>{error}</div>}
                <div style={{ display: "flex", gap: 9, marginTop: 11 }}>
                  <button onClick={submit} disabled={!decision || busy}
                    style={{ flex: 1, background: !decision || busy ? "#26305A" : "#2E55D4", color: "#fff", border: "none", borderRadius: 10, padding: 11, fontSize: 13.5, fontWeight: 660, cursor: !decision || busy ? "default" : "pointer" }}>
                    {busy ? "Sending…" : "Send to sender"}
                  </button>
                  <button onClick={() => { setCompose(false); setError(null); }} disabled={busy}
                    style={{ padding: "11px 14px", borderRadius: 10, border: "1px solid #2E3760", background: "transparent", color: "#9098BC", cursor: "pointer", fontSize: 13 }}>Cancel</button>
                </div>
                <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 10.5, color: "#666E96", marginTop: 9, textAlign: "center" }}>🛡 Signed with your passkey · sent feedback can’t be edited</div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
