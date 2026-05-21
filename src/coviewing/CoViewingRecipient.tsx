import { useEffect, useRef } from 'react';
import { subscribeCoViewingChannel } from '../lib/coviewing-realtime';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface CoViewingRecipientProps {
  channel:        string;
  mode:           'synchronized' | 'free';
  following:      boolean;
  onPageChange:   (page: number) => void;
  onSessionEnd:   () => void;
  onSetFollowing: (following: boolean) => void;
}

// Bottom-of-viewer pill shown to recipients in a synchronized session.
// Two-cell segmented control — the active cell is highlighted; clicking
// the other cell switches mode. No more "toggle button" pattern (the old
// version was confusing because the button label was the opposite action
// of the current state).
export function CoViewingRecipient({
  channel, mode, following, onPageChange, onSessionEnd, onSetFollowing,
}: CoViewingRecipientProps) {
  const followingRef = useRef(following);
  followingRef.current = following;

  useEffect(() => {
    const unsub = subscribeCoViewingChannel(channel, {
      onPageChange: (page) => {
        if (followingRef.current) onPageChange(page);
      },
      onSessionEnd: () => onSessionEnd(),
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  if (mode === 'free') return null;

  return (
    <div style={{
      position:     'fixed',
      bottom:       38,
      left:         '50%',
      transform:    'translateX(-50%)',
      zIndex:       55,
      background:   'rgba(15,23,42,0.92)',
      border:       '0.5px solid rgba(59,130,246,0.4)',
      borderRadius: 22,
      padding:      4,
      display:      'flex',
      alignItems:   'center',
      gap:          2,
      fontFamily:   FONT,
      boxShadow:    '0 6px 18px rgba(0,0,0,0.3)',
    }}>
      <SegmentBtn
        active={following}
        onClick={() => onSetFollowing(true)}
        label="Follow presenter"
        icon={
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 11l19-9-9 19-2-8-8-2z"/>
          </svg>
        }
      />
      <SegmentBtn
        active={!following}
        onClick={() => onSetFollowing(false)}
        label="Scroll freely"
        icon={
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7l-4 5 4 5"/><path d="M17 7l4 5-4 5"/><line x1="3" y1="12" x2="21" y2="12"/>
          </svg>
        }
      />
    </div>
  );
}

function SegmentBtn({
  active,
  onClick,
  label,
  icon,
}: {
  active:  boolean;
  onClick: () => void;
  label:   string;
  icon:    React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display:        'flex',
        alignItems:     'center',
        gap:            6,
        padding:        '5px 12px',
        borderRadius:   18,
        border:         'none',
        cursor:         active ? 'default' : 'pointer',
        background:     active ? '#1D4ED8' : 'transparent',
        color:          active ? '#FFFFFF' : 'rgba(255,255,255,0.55)',
        fontSize:       11,
        fontWeight:     500,
        fontFamily:     FONT,
        whiteSpace:     'nowrap',
        transition:     'background 0.12s ease, color 0.12s ease',
      }}
    >
      {icon}
      {label}
    </button>
  );
}
