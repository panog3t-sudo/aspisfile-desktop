import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  createCoViewingChannel,
  attachBroadcasts,
  type RecipientPresence,
  type ScrollChangePayload,
  type ZoomChangePayload,
} from '../lib/coviewing-realtime';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface CoViewingRecipientProps {
  channel:        string;
  mode:           'synchronized' | 'free';
  following:      boolean;
  email:          string;
  currentPage:    number;
  joinedAt:       string;
  onPageChange:   (page: number) => void;
  onSessionEnd:   () => void;
  onSetFollowing: (following: boolean) => void;
  onScrollChange?: (s: ScrollChangePayload) => void;
  onZoomChange?:   (z: ZoomChangePayload)   => void;
  // Sprint 8 — free scroll request/grant/revoke
  sessionId:      string;     // for the request-permission POST
  accessToken:    string;     // X-Access-Token header
  freeScrollGranted: boolean; // from /participants poll
}

type PermissionUiState =
  | 'idle'              // no permission, no pending request
  | 'requesting'        // POST in flight
  | 'pending'           // request sent, awaiting presenter
  | 'granted'           // permission active — can toggle Free
  | 'revoked-just-now'; // brief flash when presenter revokes

export function CoViewingRecipient({
  channel,
  mode,
  following,
  email,
  currentPage,
  joinedAt,
  onPageChange,
  onSessionEnd,
  onSetFollowing,
  onScrollChange,
  onZoomChange,
  sessionId,
  accessToken,
  freeScrollGranted,
}: CoViewingRecipientProps) {
  const followingRef     = useRef(following);
  followingRef.current   = following;
  const onScrollRef      = useRef(onScrollChange);
  onScrollRef.current    = onScrollChange;
  const onZoomRef        = useRef(onZoomChange);
  onZoomRef.current      = onZoomChange;

  const [permState, setPermState] = useState<PermissionUiState>(
    freeScrollGranted ? 'granted' : 'idle',
  );

  // Keep UI state in sync with the authoritative DB-backed flag from
  // the participants poll. Resets pending → granted when presenter
  // confirms via broadcast, OR via the next 10s poll.
  useEffect(() => {
    if (freeScrollGranted) {
      setPermState('granted');
    } else {
      setPermState(prev => (prev === 'pending' || prev === 'requesting') ? prev : 'idle');
    }
  }, [freeScrollGranted]);

  useEffect(() => {
    const ch = createCoViewingChannel(channel);
    attachBroadcasts(ch, {
      onPageChange: (page) => { if (followingRef.current) onPageChange(page); },
      onSessionEnd: () => onSessionEnd(),
      onScrollChange: (s) => { if (followingRef.current) onScrollRef.current?.(s); },
      onZoomChange:   (z) => { if (followingRef.current) onZoomRef.current?.(z); },
    });
    // Sprint 8 — listen for presenter grant/deny. Only react to events
    // addressed to OUR email (the channel is shared across guests).
    ch.on('broadcast', { event: 'permission_changed' }, ({ payload }: { payload?: { email?: string; type?: string; granted?: boolean } }) => {
      if (!payload || payload.email?.toLowerCase() !== email.toLowerCase()) return;
      if (payload.type !== 'free_scroll') return;
      if (payload.granted) {
        setPermState('granted');
      } else {
        setPermState('revoked-just-now');
        onSetFollowing(true);
        setTimeout(() => {
          setPermState(prev => prev === 'revoked-just-now' ? 'idle' : prev);
        }, 1500);
      }
    });
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await ch.track({ email, page: currentPage, following, joined_at: joinedAt } as RecipientPresence);
      }
    });
    return () => {
      ch.untrack().catch(() => {});
      supabase.removeChannel(ch);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  useEffect(() => {
    const ch = supabase.getChannels().find(c => c.topic === `realtime:${channel}`);
    if (!ch) return;
    ch.track({ email, page: currentPage, following, joined_at: joinedAt } as RecipientPresence).catch(() => {});
  }, [channel, email, currentPage, following, joinedAt]);

  async function requestFreeScroll() {
    if (permState === 'requesting' || permState === 'pending' || permState === 'granted') return;
    setPermState('requesting');
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/request-permission`, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-App-Platform': 'desktop',
          'X-Access-Token': accessToken,
        },
        body: JSON.stringify({ type: 'free_scroll' }),
      });
      if (!res.ok) {
        setPermState('idle');
        return;
      }
      const data = await res.json().catch(() => ({}));
      setPermState(data.already_granted ? 'granted' : 'pending');
    } catch {
      setPermState('idle');
    }
  }

  if (mode === 'free') return null;

  // Recipient can ALWAYS choose to follow (no permission needed).
  // The free-scroll segment is gated:
  //   idle       → "Request free scroll" (button outlined)
  //   requesting → "Requesting…" (disabled)
  //   pending    → "Waiting for approval…" (disabled, dimmed amber)
  //   granted    → "Scroll freely" (toggles like the follow segment)
  //   revoked-just-now → brief "Returned to follow" flash, then idle
  const freeChip = (() => {
    switch (permState) {
      case 'granted':
        return (
          <SegmentBtn
            active={!following}
            onClick={() => onSetFollowing(false)}
            label="Scroll freely"
            icon={<FreeScrollIcon />}
          />
        );
      case 'requesting':
        return <SegmentBtn active={false} onClick={() => {}} label="Requesting…" icon={<FreeScrollIcon />} disabled />;
      case 'pending':
        return <SegmentBtn active={false} onClick={() => {}} label="Waiting for approval" icon={<FreeScrollIcon />} disabled amber />;
      case 'revoked-just-now':
        return <SegmentBtn active={false} onClick={() => {}} label="Returned to follow" icon={<FreeScrollIcon />} disabled />;
      case 'idle':
      default:
        return (
          <SegmentBtn
            active={false}
            onClick={requestFreeScroll}
            label="Request free scroll"
            icon={<FreeScrollIcon />}
          />
        );
    }
  })();

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
      {freeChip}
    </div>
  );
}

function FreeScrollIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 7l-4 5 4 5"/><path d="M17 7l4 5-4 5"/><line x1="3" y1="12" x2="21" y2="12"/>
    </svg>
  );
}

function SegmentBtn({
  active,
  onClick,
  label,
  icon,
  disabled,
  amber,
}: {
  active:    boolean;
  onClick:   () => void;
  label:     string;
  icon:      React.ReactNode;
  disabled?: boolean;
  amber?:    boolean;
}) {
  const baseColor   = active ? '#FFFFFF' : amber ? '#FBBF24' : 'rgba(255,255,255,0.55)';
  const baseBg      = active ? '#1D4ED8' : 'transparent';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display:        'flex',
        alignItems:     'center',
        gap:            6,
        padding:        '5px 12px',
        borderRadius:   18,
        border:         'none',
        cursor:         disabled ? 'default' : active ? 'default' : 'pointer',
        background:     baseBg,
        color:          baseColor,
        fontSize:       11,
        fontWeight:     500,
        fontFamily:     FONT,
        whiteSpace:     'nowrap',
        opacity:        disabled ? 0.85 : 1,
        transition:     'background 0.12s ease, color 0.12s ease',
      }}
    >
      {icon}
      <span style={{ pointerEvents: 'none' }}>{label}</span>
    </button>
  );
}

declare const __API_BASE__: string;
