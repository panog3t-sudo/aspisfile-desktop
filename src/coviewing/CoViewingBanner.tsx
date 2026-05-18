'use client';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface CoViewingBannerProps {
  presenterName: string;
  currentPage:   number;
  onFollow:      () => void;
  onDismiss:     () => void;
  loading?:      boolean;
}

export function CoViewingBanner({ presenterName, currentPage, onFollow, onDismiss, loading }: CoViewingBannerProps) {
  return (
    <div style={{
      position:    'fixed',
      top:         0,
      left:        0,
      right:       0,
      height:      40,
      zIndex:      60,
      background:  '#1D4ED8',
      display:     'flex',
      alignItems:  'center',
      padding:     '0 12px',
      gap:         8,
      fontFamily:  FONT,
    }}>
      {/* Icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M3 11l19-9-9 19-2-8-8-2z"/>
      </svg>

      {/* Label */}
      <span style={{ fontSize: 12, color: '#FFFFFF', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <strong>{presenterName}</strong> is now presenting · Page {currentPage}
      </span>

      {/* Actions */}
      <button
        onClick={onFollow}
        disabled={loading}
        style={{
          fontSize: 11, fontWeight: 500,
          padding: '4px 12px', borderRadius: 5,
          background: '#FFFFFF', border: 'none',
          color: '#1D4ED8', cursor: loading ? 'wait' : 'pointer',
          fontFamily: FONT, flexShrink: 0,
          opacity: loading ? 0.7 : 1,
        }}
      >
        {loading ? 'Joining…' : 'Follow'}
      </button>
      <button
        onClick={onDismiss}
        style={{
          fontSize: 11, padding: '4px 10px', borderRadius: 5,
          background: 'rgba(255,255,255,0.15)', border: '0.5px solid rgba(255,255,255,0.3)',
          color: '#FFFFFF', cursor: 'pointer', fontFamily: FONT, flexShrink: 0,
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
