// Signature requests (stage 2, 2026-10-21/22) — top banner for state that
// lasts. Same lane as CoViewingBanner. Recipient: outstanding → sent.
// Owner: fields saved → next step. Fixed element, never a hover card.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

export type SignatureBannerState =
  | { kind: "outstanding"; count: number; page: number; drafted: number; onShow: () => void }
  | { kind: "sent"; senderName: string }
  | { kind: "saved"; count: number; onDismiss: () => void };

export function SignatureRequestBanner({ state }: { state: SignatureBannerState }) {
  const bg = state.kind === "outstanding" ? "#B7791F" : "#1B8A57";
  const btn: React.CSSProperties = { fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 5, border: "none", background: "#fff", color: "#1D1D1D", cursor: "pointer", fontFamily: FONT, flexShrink: 0 };
  const quiet: React.CSSProperties = { ...btn, background: "rgba(255,255,255,0.18)", color: "#fff", border: "0.5px solid rgba(255,255,255,0.35)" };
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 40, zIndex: 60, background: bg, display: "flex", alignItems: "center", padding: "0 12px", gap: 8, fontFamily: FONT }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        {state.kind === "outstanding"
          ? <><path d="M4 16.6l.95-3.5L14.9 3.15a1.9 1.9 0 012.7 2.7L7.6 15.9 4 16.6z" /><path d="M4.4 20.6h13.2" /></>
          : <path d="M20 6L9 17l-5-5" />}
      </svg>
      <span style={{ fontSize: 12, color: "#fff", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {state.kind === "outstanding" && (state.drafted > 0
          ? <><strong>{state.count} {state.count === 1 ? "place" : "places"} left to sign.</strong> Your signatures are drafts until you press Send.</>
          : <><strong>This document needs your signature.</strong> {state.count} {state.count === 1 ? "place" : "places"} to sign · the first is on page {state.page}</>)}
        {state.kind === "sent" && <><strong>Signed and sent.</strong> {state.senderName} has been notified. You can close the document.</>}
        {state.kind === "saved" && <><strong>{state.count} {state.count === 1 ? "field" : "fields"} saved.</strong> Nobody has been asked yet — request the signatures from this file&rsquo;s page in your dashboard.</>}
      </span>
      {state.kind === "outstanding" && <button onClick={state.onShow} style={btn}>Show me</button>}
      {state.kind === "saved" && <button onClick={state.onDismiss} style={quiet}>Got it</button>}
    </div>
  );
}
