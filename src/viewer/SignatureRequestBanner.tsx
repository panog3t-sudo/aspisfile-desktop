// Signature requests (stage 2, 2026-10-21) — recipient-side top banner while
// owner-placed fields are still unsigned. Same lane as CoViewingBanner.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

export function SignatureRequestBanner({ count, page }: { count: number; page: number }) {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, height: 40, zIndex: 60,
      background: '#B7791F', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8, fontFamily: FONT,
    }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M4 16.6l.95-3.5L14.9 3.15a1.9 1.9 0 012.7 2.7L7.6 15.9 4 16.6z" /><path d="M4.4 20.6h13.2" />
      </svg>
      <span style={{ fontSize: 12, color: '#fff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <strong>This document needs your signature</strong> · {count} {count === 1 ? 'place' : 'places'} to sign · first on page {page} — tap a <strong>Sign here</strong> box
      </span>
    </div>
  );
}
