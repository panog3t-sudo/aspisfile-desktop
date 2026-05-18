import { useEffect, useRef } from 'react';
import { subscribeCoViewingChannel } from '../lib/coviewing-realtime';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface CoViewingRecipientProps {
  channel:      string;
  mode:         'synchronized' | 'free';
  following:    boolean;
  onPageChange: (page: number) => void;
  onSessionEnd: () => void;
  onToggleFollow: () => void;
}

export function CoViewingRecipient({
  channel, mode, following, onPageChange, onSessionEnd, onToggleFollow,
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
      position:   'fixed',
      bottom:     38,
      left:       '50%',
      transform:  'translateX(-50%)',
      zIndex:     55,
      background: '#1D4ED8',
      border:     '0.5px solid rgba(59,130,246,0.5)',
      borderRadius: 20,
      padding:    '5px 14px',
      display:    'flex',
      alignItems: 'center',
      gap:        8,
      fontFamily: FONT,
    }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 11l19-9-9 19-2-8-8-2z"/>
      </svg>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)' }}>
        {following ? 'Following presenter' : 'Scrolling freely'}
      </span>
      <button
        onClick={onToggleFollow}
        style={{
          fontSize:     10,
          padding:      '2px 8px',
          borderRadius: 10,
          background:   following ? 'rgba(255,255,255,0.2)' : '#FFFFFF',
          border:       'none',
          color:        following ? '#FFFFFF' : '#1D4ED8',
          cursor:       'pointer',
          fontFamily:   FONT,
        }}
      >
        {following ? 'Scroll freely' : 'Follow presenter'}
      </button>
    </div>
  );
}
