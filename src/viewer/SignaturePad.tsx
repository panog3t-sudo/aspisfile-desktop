import { useRef, useState } from "react";

// Recipient e-signature capture — draw or type. Returns box-relative strokes
// (0..1) for drawn, or the typed name. Purely a capture UI; the signature is
// placed on the page + sent as a draft by the caller. Overlay only.

export type SignatureData =
  | { style: "drawn"; points: Array<Array<{ x: number; y: number }>>; signer_name: string }
  | { style: "typed"; typed_name: string; signer_name: string };

const PAD_W = 360, PAD_H = 150;   // ~2.4:1, matches the on-page signature box aspect

export function SignaturePad({ onCancel, onDone }: { onCancel: () => void; onDone: (s: SignatureData) => void }) {
  const [tab, setTab] = useState<"draw" | "type">("draw");
  const [name, setName] = useState("");
  const [typed, setTyped] = useState("");
  const [strokes, setStrokes] = useState<Array<Array<{ x: number; y: number }>>>([]);
  const drawingRef = useRef(false);

  const pt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: React.MouseEvent<HTMLDivElement>) => { drawingRef.current = true; const p = pt(e); setStrokes((s) => [...s, [p]]); };
  const move = (e: React.MouseEvent<HTMLDivElement>) => { if (!drawingRef.current) return; const p = pt(e); setStrokes((s) => { if (!s.length) return s; const c = s.slice(); c[c.length - 1] = [...c[c.length - 1], p]; return c; }); };
  const up = () => { drawingRef.current = false; };
  const clear = () => { setStrokes([]); };

  const hasDrawing = strokes.some((st) => st.length > 1);
  const canAdd = name.trim() && (tab === "draw" ? hasDrawing : typed.trim());

  const submit = () => {
    if (!canAdd) return;
    if (tab === "draw") onDone({ style: "drawn", points: strokes.filter((st) => st.length > 1), signer_name: name.trim() });
    else onDone({ style: "typed", typed_name: typed.trim(), signer_name: name.trim() });
  };

  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 10002, background: "rgba(4,6,14,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 420, background: "#141830", border: "1px solid #2E3760", borderRadius: 16, padding: 18, boxShadow: "0 24px 60px rgba(0,0,0,.65)", color: "#EAEFFB", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 13 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 660 }}>Sign the document</h3>
          <button onClick={onCancel} style={{ marginLeft: "auto", background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Your full name"
          style={{ width: "100%", boxSizing: "border-box", border: "1px solid #2E3760", background: "#080A14", color: "#EAEFFB", borderRadius: 10, padding: "10px 12px", fontSize: 13, marginBottom: 12 }} />

        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {(["draw", "type"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "8px", borderRadius: 9, border: `1px solid ${tab === t ? "#5C82EE" : "#2E3760"}`, background: tab === t ? "#1C2347" : "transparent", color: tab === t ? "#7C9CF5" : "#9098BC", cursor: "pointer", fontSize: 12.5, fontWeight: 640 }}>{t === "draw" ? "✍️ Draw" : "⌨ Type"}</button>
          ))}
        </div>

        {tab === "draw" ? (
          <>
            <div onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={up}
              style={{ width: "100%", aspectRatio: `${PAD_W} / ${PAD_H}`, background: "#FBFBF7", borderRadius: 10, border: "1px solid #2E3760", cursor: "crosshair", position: "relative", overflow: "hidden" }}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                {strokes.map((st, i) => st.length > 1 && (
                  <polyline key={i} points={st.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")} fill="none" stroke="#0E1130" strokeWidth={2.2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
                ))}
                <line x1="6" y1="78" x2="94" y2="78" stroke="#C7D3F5" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
              <button onClick={clear} style={{ background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 12 }}>Clear</button>
            </div>
          </>
        ) : (
          <div style={{ width: "100%", aspectRatio: `${PAD_W} / ${PAD_H}`, background: "#FBFBF7", borderRadius: 10, border: "1px solid #2E3760", display: "grid", placeItems: "center", padding: 12 }}>
            <span style={{ fontFamily: "'Segoe Script','Brush Script MT','Snell Roundhand',cursive", fontSize: 34, color: "#0E1130", textAlign: "center", lineHeight: 1.1 }}>{typed || "Your signature"}</span>
          </div>
        )}
        {tab === "type" && (
          <input value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={80} placeholder="Type your signature"
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #2E3760", background: "#080A14", color: "#EAEFFB", borderRadius: 10, padding: "10px 12px", fontSize: 13, marginTop: 10 }} />
        )}

        <div style={{ display: "flex", gap: 9, marginTop: 14 }}>
          <button onClick={submit} disabled={!canAdd} style={{ flex: 1, background: canAdd ? "#2E55D4" : "#26305A", color: "#fff", border: "none", borderRadius: 10, padding: 11, fontSize: 13.5, fontWeight: 660, cursor: canAdd ? "pointer" : "default" }}>Add signature</button>
          <button onClick={onCancel} style={{ padding: "11px 14px", borderRadius: 10, border: "1px solid #2E3760", background: "transparent", color: "#9098BC", cursor: "pointer", fontSize: 13 }}>Cancel</button>
        </div>
        <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 10.5, color: "#666E96", marginTop: 10, textAlign: "center" }}>Signed with your passkey · draft until you press Send</div>
      </div>
    </div>
  );
}
