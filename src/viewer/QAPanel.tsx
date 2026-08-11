import { useEffect, useState, useCallback } from "react";
import { fetch } from "@tauri-apps/plugin-http";
import { getActiveSessionToken } from "../lib/recipient-session";

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

// Data-room Q&A — per-document, private to this member (party). Separate from
// the recipient Feedback feature. Gated by the recipient passkey session; the
// backend scopes everything to this member's own email + threads.
type Post = { author_type: "member" | "team"; author_name: string | null; body: string; created_at: string };
type Q = { id: string; status: string; created_at: string; posts: Post[] };

function tAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function QAPanel({ roomId, fileId, docName, onClose, onUnread }: {
  roomId: string; fileId: string; docName: string; onClose: () => void; onUnread?: (n: number) => void;
}) {
  const [questions, setQuestions] = useState<Q[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const headers = () => {
    const t = getActiveSessionToken();
    return { "Content-Type": "application/json", "X-App-Platform": "desktop", ...(t ? { Authorization: `Bearer ${t}` } : {}) } as Record<string, string>;
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/v1/rooms/${roomId}/qa?fileId=${encodeURIComponent(fileId)}`, { headers: headers() });
      if (!res.ok) { setErr("Couldn’t load Q&A. Try again."); return; }
      const d = await res.json();
      setErr("");
      setQuestions(Array.isArray(d.questions) ? d.questions : []);
    } catch { setErr("Couldn’t reach AspisFile."); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, fileId]);

  useEffect(() => {
    load();
    // Opening the panel marks this document's threads seen → clears the badge.
    const markSeen = async () => {
      try {
        await fetch(`${BASE}/api/v1/rooms/${roomId}/qa`, { method: "POST", headers: headers(), body: JSON.stringify({ fileId, seen: true }) });
        onUnread?.(0);
      } catch { /* best-effort */ }
    };
    markSeen();
    // While the panel is open, poll so a deal-team answer appears without a
    // manual refresh; re-mark seen each round so it never re-badges live.
    const timer = window.setInterval(async () => { await load(); markSeen(); }, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/v1/rooms/${roomId}/qa`, { method: "POST", headers: headers(), body: JSON.stringify({ fileId, body }) });
      if (!res.ok) { setErr("Couldn’t send your question."); return; }
      setDraft("");
      await load();
    } catch { setErr("Couldn’t reach AspisFile."); } finally { setBusy(false); }
  };

  return (
    // Docked side panel — a flex sibling of the document, so the document
    // shrinks to make room instead of being covered (matches the presenter
    // participant panel). No full-screen backdrop; the file stays readable.
    <div style={{ width: 380, maxWidth: "42vw", height: "100%", flexShrink: 0, background: "#141830", borderLeft: "1px solid #2E3760", display: "flex", flexDirection: "column", boxShadow: "-20px 0 60px rgba(0,0,0,.4)", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif" }}>
        <div style={{ padding: "16px 16px 11px", borderBottom: "1px solid #2E3760" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#EAEFFB" }}>Q&A</div>
            <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", color: "#9098BC", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>
          <div style={{ fontSize: 11.5, color: "#7C9CF5", fontFamily: "ui-monospace,Menlo,monospace", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{docName}</div>
          <div style={{ fontSize: 11, color: "#666E96", marginTop: 7 }}>🔒 Private — only you and the deal team can see these questions.</div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "13px 14px" }}>
          {err && <div style={{ fontSize: 12, color: "#F0A5A5", marginBottom: 10 }}>{err}</div>}
          {questions === null ? <div style={{ fontSize: 12.5, color: "#9098BC" }}>Loading…</div>
            : questions.length === 0 ? <div style={{ fontSize: 12.5, color: "#9098BC", lineHeight: 1.6 }}>No questions yet. Ask the deal team about this document below.</div>
            : questions.map(q => (
              <div key={q.id} style={{ marginBottom: 15 }}>
                <div style={{ marginBottom: 6 }}>
                  <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 8.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 20, color: q.status === "open" ? "#F5C97B" : "#86EFAC", background: q.status === "open" ? "rgba(200,132,30,.18)" : "rgba(27,138,87,.20)" }}>{q.status === "open" ? "Open" : "Answered"}</span>
                </div>
                {q.posts.map((p, i) => (
                  <div key={i} style={{ padding: "8px 11px", borderRadius: 9, marginBottom: 6, background: p.author_type === "team" ? "#1C2347" : "#0E1228" }}>
                    <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: ".04em", color: "#666E96", marginBottom: 3 }}>{p.author_type === "team" ? `Answered by ${p.author_name || "the deal team"}` : "You"} · {tAgo(p.created_at)}</div>
                    <div style={{ fontSize: 12.5, color: "#EAEFFB", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{p.body}</div>
                  </div>
                ))}
                {q.status === "open" && !q.posts.some(p => p.author_type === "team") && <div style={{ fontSize: 11, color: "#666E96", fontStyle: "italic", paddingLeft: 2 }}>Awaiting the deal team…</div>}
              </div>
            ))}
        </div>

        <div style={{ borderTop: "1px solid #2E3760", padding: 12 }}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask about this document…" style={{ width: "100%", background: "#080A14", border: "1px solid #2E3760", borderRadius: 10, color: "#EAEFFB", fontFamily: "inherit", fontSize: 12.5, padding: "9px 11px", minHeight: 52, resize: "none", outline: "none", boxSizing: "border-box" }} />
          <button onClick={send} disabled={busy || !draft.trim()} style={{ width: "100%", marginTop: 8, background: "#2E55D4", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, padding: 9, cursor: (busy || !draft.trim()) ? "default" : "pointer", opacity: (busy || !draft.trim()) ? 0.6 : 1 }}>{busy ? "Sending…" : "Send question"}</button>
        </div>
      </div>
  );
}
