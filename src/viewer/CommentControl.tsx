import { useState } from "react";

// Recipient feedback Phase 2 — comment mode toggle + compose sheet.
//
// Self-contained overlay: the toggle flips comment mode (TileRenderer then
// captures a click on the page and reports page-fraction coords via
// onPlaceComment, which sets draftPin here). This component composes the
// comment text and POSTs it. Never touches the tile/security path.

declare const __API_BASE__: string;

type DraftPin = { page: number; x: number; y: number };

export function CommentControl({
  fileId, sessionId, on, setOn, draft, setDraft, onPosted,
}: {
  fileId: string;
  sessionId: string;
  on: boolean;
  setOn: (v: boolean) => void;
  draft: DraftPin | null;
  setDraft: (v: DraftPin | null) => void;
  onPosted: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => { setDraft(null); setText(""); setError(null); };

  const post = async () => {
    if (!draft || !text.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/viewer/${fileId}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Platform": "desktop" },
        body: JSON.stringify({ session_id: sessionId, page: draft.page, x: draft.x, y: draft.y, body: text.trim() }),
      });
      if (!res.ok) { setError("Couldn’t post. Please try again."); setBusy(false); return; }
      setBusy(false); setDraft(null); setText("");
      onPosted();          // refetch pins + thread; comment mode stays on for more
    } catch {
      setError("Couldn’t reach the server. Please try again."); setBusy(false);
    }
  };

  return (
    <>
      {/* Toggle — bottom-left, out of the way of the centered Respond control */}
      {!draft && (
        <button onClick={() => setOn(!on)}
          style={{
            position: "fixed", bottom: 18, left: 16, zIndex: 998,
            display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 15px", borderRadius: 999, cursor: "pointer",
            fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", fontSize: 12.5, fontWeight: 640,
            border: on ? "1px solid #7C9CF5" : "1px solid #2E3760",
            background: on ? "#1C2347" : "#1A1F3A", color: on ? "#7C9CF5" : "#EAEFFB",
            boxShadow: on ? "0 0 0 1px #7C9CF5 inset, 0 8px 22px rgba(0,0,0,.45)" : "0 8px 22px rgba(0,0,0,.45)",
          }}>
          <span aria-hidden style={{ fontSize: 14 }}>💬</span>{on ? "Comment · on" : "Comment"}
        </button>
      )}

      {/* Hint while placing */}
      {on && !draft && (
        <div style={{
          position: "fixed", bottom: 62, left: "50%", transform: "translateX(-50%)", zIndex: 997,
          background: "#141830", border: "1px solid #2E3760", borderRadius: 999, padding: "6px 13px",
          color: "#9098BC", fontSize: 12, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        }}>Tap a spot on the page to add a comment</div>
      )}

      {/* Compose sheet */}
      {draft && (
        <div onClick={() => !busy && cancel()}
          style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(4,6,14,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 440, margin: 12, background: "#141830", border: "1px solid #2E3760", borderRadius: 16,
              padding: "15px 15px 17px", boxShadow: "0 24px 60px rgba(0,0,0,.6)",
              fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", color: "#EAEFFB",
            }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 11 }}>
              <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11, fontWeight: 700, color: "#7C9CF5", background: "#1C2347", padding: "3px 9px", borderRadius: 999 }}>💬 NEW COMMENT · PAGE {draft.page}</span>
              <button onClick={cancel} disabled={busy} style={{ marginLeft: "auto", background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} autoFocus placeholder="Your comment on this spot…"
              style={{ width: "100%", minHeight: 64, resize: "vertical", boxSizing: "border-box", border: "1px solid #2E3760", background: "#080A14", color: "#EAEFFB", borderRadius: 10, padding: "10px 12px", fontSize: 13, lineHeight: 1.5, fontFamily: "inherit" }} />
            {error && <div style={{ color: "#E96B5C", fontSize: 12, marginTop: 8 }}>{error}</div>}
            <div style={{ display: "flex", gap: 9, marginTop: 11 }}>
              <button onClick={post} disabled={!text.trim() || busy}
                style={{ flex: 1, background: !text.trim() || busy ? "#26305A" : "#2E55D4", color: "#fff", border: "none", borderRadius: 10, padding: 11, fontSize: 13.5, fontWeight: 660, cursor: !text.trim() || busy ? "default" : "pointer" }}>
                {busy ? "Posting…" : "Post comment"}
              </button>
              <button onClick={cancel} disabled={busy} style={{ padding: "11px 14px", borderRadius: 10, border: "1px solid #2E3760", background: "transparent", color: "#9098BC", cursor: "pointer", fontSize: 13 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
