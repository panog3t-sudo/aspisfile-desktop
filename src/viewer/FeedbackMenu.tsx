import { useState, useEffect, useCallback } from "react";

// Recipient feedback — unified draft-then-send menu.
//
// One floating button expands into a menu with Respond / Comment / Draw. Every
// item is a LOCAL DRAFT (shown on the page for the recipient only, deletable);
// nothing reaches the sender until "Send", which is confirmed and irreversible.
// Self-contained overlay — never touches the tile/decrypt/watermark/security
// path. Entering Comment/Draw collapses the menu so the page is tappable; a
// small "Done" bar returns to the menu.

declare const __API_BASE__: string;

export type Decision = "approved" | "changes_requested" | "rejected";
export type DraftComment = { tempId: string; page: number; x: number; y: number; body: string; at: string };
export type DraftMarkup  = { tempId: string; page: number; points: Array<{ x: number; y: number }>; color?: string; at: string };
type SentEntry =
  | { kind: "decision"; id: string; decision: Decision; note: string | null; created_at: string; is_current: boolean }
  | { kind: "comment"; id: string; page: number; body: string; created_at: string }
  | { kind: "markup"; id: string; page: number; created_at: string };

const CHOICES: { key: Decision; label: string; color: string; bg: string; border: string; icon: string }[] = [
  { key: "approved",          label: "Approve",         color: "#3FB980", bg: "#14311F", border: "#1F6B44", icon: "✓" },
  { key: "changes_requested", label: "Request changes", color: "#E0A54B", bg: "#332510", border: "#7A561D", icon: "!" },
  { key: "rejected",          label: "Reject",          color: "#E96B5C", bg: "#331512", border: "#7C332A", icon: "✕" },
];
const DEC_META: Record<Decision, { label: string; color: string; bg: string; icon: string }> = {
  approved:          { label: "Approved",          color: "#3FB980", bg: "#14311F", icon: "✓" },
  changes_requested: { label: "Changes requested", color: "#E0A54B", bg: "#332510", icon: "!" },
  rejected:          { label: "Rejected",          color: "#E96B5C", bg: "#331512", icon: "✕" },
};
const fmtTime = (iso: string) => { try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };

const chip = { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 999 } as const;
const del = (onClick: () => void) => (
  <button onClick={onClick} title="Delete draft" style={{ marginLeft: "auto", background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 15, lineHeight: 1 }}>×</button>
);

export function FeedbackMenu(props: {
  fileId: string;
  sessionId: string;
  mode: "none" | "comment" | "draw";
  setMode: (m: "none" | "comment" | "draw") => void;
  draftDecision: { decision: Decision; note: string } | null;
  setDraftDecision: (d: { decision: Decision; note: string } | null) => void;
  draftComments: DraftComment[];
  removeDraftComment: (tempId: string) => void;
  draftMarkups: DraftMarkup[];
  removeDraftMarkup: (tempId: string) => void;
  onSend: () => Promise<boolean>;
  sending: boolean;
}) {
  const { mode, setMode, draftDecision, setDraftDecision, draftComments, removeDraftComment, draftMarkups, removeDraftMarkup, onSend, sending } = props;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sent, setSent] = useState<SentEntry[]>([]);
  const [note, setNote] = useState(draftDecision?.note ?? "");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/viewer/${props.fileId}/feedback?session=${encodeURIComponent(props.sessionId)}`, { headers: { "X-App-Platform": "desktop" } });
      if (res.ok) { const j = await res.json(); setSent(Array.isArray(j.entries) ? j.entries : []); }
    } catch { /* keep */ }
  }, [props.fileId, props.sessionId]);
  useEffect(() => { load(); }, [load]);

  const draftCount = (draftDecision ? 1 : 0) + draftComments.length + draftMarkups.length;
  const enterMode = (m: "comment" | "draw") => { setMode(m); setOpen(false); };
  const doSend = async () => { const ok = await onSend(); if (ok) { setConfirm(false); setNote(""); await load(); } };

  // Collapsed + in comment/draw mode → the "Done" hint bar.
  if (mode !== "none" && !open) {
    return (
      <div style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 998,
        display: "flex", alignItems: "center", gap: 12, background: "#141830", border: "1px solid #2E3760", borderRadius: 999,
        padding: "8px 8px 8px 16px", boxShadow: "0 8px 22px rgba(0,0,0,.45)", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif" }}>
        <span style={{ color: "#9098BC", fontSize: 12.5 }}>
          {mode === "comment" ? "Tap a spot on the page to add a comment" : "Draw on the page to mark it up"}
        </span>
        <button onClick={() => { setMode("none"); setOpen(true); }}
          style={{ background: "#2E55D4", color: "#fff", border: "none", borderRadius: 999, padding: "7px 15px", fontSize: 12.5, fontWeight: 640, cursor: "pointer" }}>Done</button>
      </div>
    );
  }

  return (
    <>
      {/* Collapsed launcher */}
      {!open && (
        <button onClick={() => { setOpen(true); load(); }}
          style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 998,
            display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 999, cursor: "pointer",
            fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", fontSize: 13, fontWeight: 640,
            border: draftCount ? "1px solid #7A561D" : "1px solid #2E3760", background: draftCount ? "#332510" : "#1A1F3A",
            color: draftCount ? "#E0A54B" : "#EAEFFB", boxShadow: "0 8px 22px rgba(0,0,0,.45)" }}>
          <span aria-hidden style={{ fontSize: 14 }}>✎</span>Feedback{draftCount ? ` · ${draftCount} draft${draftCount !== 1 ? "s" : ""}` : ""}
        </button>
      )}

      {open && (
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(4,6,14,.55)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, margin: 12, background: "#141830", border: "1px solid #2E3760", borderRadius: 16,
            padding: "16px 16px 18px", boxShadow: "0 24px 60px rgba(0,0,0,.6)", maxHeight: "84vh", display: "flex", flexDirection: "column",
            fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", color: "#EAEFFB" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 13 }}>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 660 }}>Feedback</h3>
              <button onClick={() => setOpen(false)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
            </div>

            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Respond */}
              <div>
                <div style={{ fontSize: 11.5, color: "#9098BC", fontWeight: 600, marginBottom: 8 }}>Your response</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
                  {CHOICES.map((c) => {
                    const on = draftDecision?.decision === c.key;
                    return (
                      <button key={c.key} onClick={() => setDraftDecision({ decision: c.key, note })}
                        style={{ border: `1px solid ${on ? c.color : c.border}`, borderRadius: 11, padding: "10px 6px", background: on ? c.bg : "transparent", cursor: "pointer",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 6, boxShadow: on ? `0 0 0 1px ${c.color} inset` : "none" }}>
                        <span style={{ width: 28, height: 28, borderRadius: 8, background: c.bg, color: c.color, display: "grid", placeItems: "center", fontSize: 14, fontWeight: 700 }}>{c.icon}</span>
                        <span style={{ fontSize: 11, fontWeight: 640, color: c.color }}>{c.label}</span>
                      </button>
                    );
                  })}
                </div>
                <textarea value={note} onChange={(e) => { setNote(e.target.value); if (draftDecision) setDraftDecision({ ...draftDecision, note: e.target.value }); }}
                  maxLength={2000} placeholder="Add a note (optional)…"
                  style={{ width: "100%", minHeight: 48, resize: "vertical", boxSizing: "border-box", marginTop: 9, border: "1px solid #2E3760", background: "#080A14", color: "#EAEFFB", borderRadius: 10, padding: "9px 11px", fontSize: 13, fontFamily: "inherit" }} />
              </div>

              {/* Annotate */}
              <div style={{ display: "flex", gap: 9 }}>
                <button onClick={() => enterMode("comment")} style={{ flex: 1, border: "1px solid #2E3760", background: "#1A1F3A", color: "#EAEFFB", borderRadius: 10, padding: "10px", fontSize: 12.5, fontWeight: 640, cursor: "pointer" }}>💬 Comment on the page</button>
                <button onClick={() => enterMode("draw")} style={{ flex: 1, border: "1px solid #2E3760", background: "#1A1F3A", color: "#EAEFFB", borderRadius: 10, padding: "10px", fontSize: 12.5, fontWeight: 640, cursor: "pointer" }}>✎ Draw on the page</button>
              </div>

              {/* Drafts */}
              {draftCount > 0 && (
                <div>
                  <div style={{ fontSize: 11.5, color: "#E0A54B", fontWeight: 600, marginBottom: 8 }}>Drafts — not sent yet</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {draftDecision && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px dashed #7A561D", borderRadius: 9, padding: "8px 10px", background: "#0E1228" }}>
                        <span style={{ ...chip, color: DEC_META[draftDecision.decision].color, background: DEC_META[draftDecision.decision].bg }}>{DEC_META[draftDecision.decision].icon} {DEC_META[draftDecision.decision].label}</span>
                        {draftDecision.note && <span style={{ fontSize: 12, color: "#C9CFEA", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{draftDecision.note}</span>}
                        {del(() => { setDraftDecision(null); setNote(""); })}
                      </div>
                    )}
                    {draftComments.map((c) => (
                      <div key={c.tempId} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px dashed #7A561D", borderRadius: 9, padding: "8px 10px", background: "#0E1228" }}>
                        <span style={{ ...chip, color: "#7C9CF5", background: "#1C2347" }}>💬 P{c.page}</span>
                        <span style={{ fontSize: 12, color: "#C9CFEA", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{c.body}</span>
                        <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 9.5, color: "#666E96", flexShrink: 0 }}>{fmtTime(c.at)}</span>
                        {del(() => removeDraftComment(c.tempId))}
                      </div>
                    ))}
                    {draftMarkups.map((m) => (
                      <div key={m.tempId} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px dashed #7A561D", borderRadius: 9, padding: "8px 10px", background: "#0E1228" }}>
                        <span style={{ ...chip, color: "#E0A54B", background: "#332510" }}>✎ MARKUP · P{m.page}</span>
                        <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 9.5, color: "#666E96" }}>{fmtTime(m.at)}</span>
                        {del(() => removeDraftMarkup(m.tempId))}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sent (read-only) */}
              {sent.length > 0 && (
                <div>
                  <div style={{ fontSize: 11.5, color: "#7CE0B0", fontWeight: 600, marginBottom: 8 }}>Sent</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {sent.map((e) => (
                      <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #242B4C", borderRadius: 9, padding: "8px 10px", background: "#0E1228" }}>
                        {e.kind === "decision" ? <span style={{ ...chip, color: DEC_META[e.decision].color, background: DEC_META[e.decision].bg }}>{DEC_META[e.decision].icon} {DEC_META[e.decision].label}</span>
                          : e.kind === "comment" ? <span style={{ ...chip, color: "#7C9CF5", background: "#1C2347" }}>💬 P{e.page}</span>
                          : <span style={{ ...chip, color: "#E0A54B", background: "#332510" }}>✎ P{e.page}</span>}
                        {e.kind === "decision" && e.is_current && <span style={{ fontSize: 9.5, fontWeight: 700, color: "#7C9CF5" }}>◀ CURRENT</span>}
                        {e.kind === "comment" && <span style={{ fontSize: 12, color: "#C9CFEA", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.body}</span>}
                        <span style={{ marginLeft: "auto", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 10, color: "#666E96" }}>{fmtTime(e.created_at)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Send */}
            <button onClick={() => draftCount > 0 && setConfirm(true)} disabled={draftCount === 0}
              style={{ marginTop: 14, background: draftCount ? "#2E55D4" : "#26305A", color: "#fff", border: "none", borderRadius: 10, padding: 12, fontSize: 13.5, fontWeight: 660, cursor: draftCount ? "pointer" : "default" }}>
              {draftCount ? `Send ${draftCount} item${draftCount !== 1 ? "s" : ""} to sender` : "Nothing to send yet"}
            </button>
          </div>
        </div>
      )}

      {/* Are-you-sure */}
      {confirm && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10002, background: "rgba(4,6,14,.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ width: "100%", maxWidth: 360, background: "#141830", border: "1px solid #2E3760", borderRadius: 14, padding: 20, boxShadow: "0 24px 60px rgba(0,0,0,.7)", color: "#EAEFFB", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif" }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 660 }}>Send to the sender?</h3>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "#9098BC", lineHeight: 1.5 }}>
              This sends {draftCount} item{draftCount !== 1 ? "s" : ""} to the sender. <b style={{ color: "#E0A54B" }}>You can’t change or delete them after sending.</b> (You can still add more later.)
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={doSend} disabled={sending}
                style={{ flex: 1, background: sending ? "#26305A" : "#2E55D4", color: "#fff", border: "none", borderRadius: 10, padding: 11, fontSize: 13.5, fontWeight: 660, cursor: sending ? "default" : "pointer" }}>{sending ? "Sending…" : "Send"}</button>
              <button onClick={() => setConfirm(false)} disabled={sending}
                style={{ padding: "11px 16px", borderRadius: 10, border: "1px solid #2E3760", background: "transparent", color: "#9098BC", cursor: "pointer", fontSize: 13 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
