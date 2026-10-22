import { useCallback, useEffect, useRef, useState } from "react";

// Shared frame for the viewer's floating panels (22 Oct 2026, Pano: a panel
// over the corner is in the way when that corner is where you must sign).
// Every panel gets the same three controls in its title bar:
//   −  minimise to a small pill at the bottom-left (state and drafts kept)
//   +  (on the pill) restore
//   ×  close
// and the title bar drags the panel anywhere. Position is per panel, per
// session; the default corner is the panel's own.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
const PILL_SLOT = 36;   // vertical pitch between stacked pills

export function FloatingPanel({ title, pill, corner, width = 340, maxHeight = "70vh", zIndex = 998, onClose, children, pillSlot = 0, minimised, onMinimisedChange }: {
  title: string;
  pill: string;                                 // label on the minimised pill, e.g. "Signature fields · 1 unsaved"
  corner: "bottom-right" | "top-left";
  width?: number; maxHeight?: string; zIndex?: number;
  onClose: () => void;
  children: React.ReactNode;
  pillSlot?: number;                            // 0 = lowest pill, 1 = the one above it …
  minimised?: boolean; onMinimisedChange?: (m: boolean) => void;   // controlled, optional
}) {
  const [innerMin, setInnerMin] = useState(false);
  const min = minimised ?? innerMin;
  const setMin = useCallback((m: boolean) => { setInnerMin(m); onMinimisedChange?.(m); }, [onMinimisedChange]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);   // null = default corner
  const dragRef = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const onMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current; if (!d) return;
    const w = panelRef.current?.offsetWidth ?? width, h = panelRef.current?.offsetHeight ?? 200;
    setPos({ left: Math.min(window.innerWidth - w - 8, Math.max(8, d.ox + e.clientX - d.sx)), top: Math.min(window.innerHeight - h - 8, Math.max(8, d.oy + e.clientY - d.sy)) });
  }, [width]);
  const onUp = useCallback(() => { dragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }, [onMove]);
  const beginDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = panelRef.current?.getBoundingClientRect(); if (!r) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    e.preventDefault();
  }, [onMove, onUp]);
  useEffect(() => () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }, [onMove, onUp]);

  const ctl: React.CSSProperties = { background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 17, lineHeight: 1, width: 24, height: 24, borderRadius: 6, display: "grid", placeItems: "center" };

  if (min) {
    return (
      <button onClick={() => setMin(false)} title="Restore"
        style={{ position: "fixed", left: 16, bottom: 18 + pillSlot * PILL_SLOT, zIndex, display: "flex", alignItems: "center", gap: 8,
          background: "#141830", border: "1px solid #2E3760", borderRadius: 999, padding: "6px 8px 6px 12px", color: "#EAEFFB", fontFamily: FONT, fontSize: 12, fontWeight: 600,
          boxShadow: "0 8px 22px rgba(0,0,0,.45)", cursor: "pointer", whiteSpace: "nowrap" }}>
        {pill}
        <span style={{ width: 20, height: 20, borderRadius: 999, background: "#2E55D4", color: "#fff", display: "grid", placeItems: "center", fontSize: 14, lineHeight: 1 }}>+</span>
      </button>
    );
  }

  const place: React.CSSProperties = pos
    ? { left: pos.left, top: pos.top }
    : corner === "bottom-right" ? { right: 16, bottom: 18 } : { top: 50, left: 12 };

  return (
    <div ref={panelRef} style={{ position: "fixed", ...place, width, maxWidth: "calc(100vw - 24px)", maxHeight, zIndex, display: "flex", flexDirection: "column",
      background: "#141830", border: "1px solid #2E3760", borderRadius: 14, boxShadow: "0 16px 40px rgba(0,0,0,.55)", fontFamily: FONT, color: "#EAEFFB" }}>
      <div onMouseDown={beginDrag} title="Drag to move" style={{ display: "flex", alignItems: "center", gap: 4, padding: "10px 10px 6px 14px", cursor: "move", userSelect: "none", flexShrink: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 660, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        <button onClick={() => setMin(true)} title="Minimise — keeps everything, frees the page" style={ctl}>−</button>
        <button onClick={onClose} title="Close" style={ctl}>×</button>
      </div>
      <div style={{ overflowY: "auto", padding: "0 14px 12px", minHeight: 0 }}>{children}</div>
    </div>
  );
}
