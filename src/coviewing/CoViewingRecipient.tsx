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
  sessionId:      string;
  accessToken:    string;
  freeScrollGranted:     boolean;
  pointerControlGranted: boolean;
  onFreeScrollChanged:     (granted: boolean) => void;
  onPointerControlChanged: (granted: boolean) => void;
}

type PermState =
  | 'idle'              // no permission, no pending request
  | 'requesting'        // POST in flight
  | 'pending'           // request sent, awaiting presenter
  | 'granted'           // permission active
  | 'revoked-just-now'; // brief flash when presenter revokes

type PermType = 'free_scroll' | 'pointer_control';

declare const __API_BASE__: string;

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
  pointerControlGranted,
  onFreeScrollChanged,
  onPointerControlChanged,
}: CoViewingRecipientProps) {
  const followingRef     = useRef(following);
  followingRef.current   = following;
  const onScrollRef      = useRef(onScrollChange);
  onScrollRef.current    = onScrollChange;
  const onZoomRef        = useRef(onZoomChange);
  onZoomRef.current      = onZoomChange;

  const [freeScrollState, setFreeScrollState] = useState<PermState>(
    freeScrollGranted ? 'granted' : 'idle',
  );
  const [controlState, setControlState] = useState<PermState>(
    pointerControlGranted ? 'granted' : 'idle',
  );

  // Keep local state in sync with the authoritative DB-backed flag.
  // Resets pending → granted when presenter confirms via broadcast,
  // OR via the next /participants poll on the presenter side which
  // pushes a permission_changed broadcast.
  useEffect(() => {
    if (freeScrollGranted) setFreeScrollState('granted');
    else setFreeScrollState(prev =>
      (prev === 'pending' || prev === 'requesting') ? prev : 'idle');
  }, [freeScrollGranted]);
  useEffect(() => {
    if (pointerControlGranted) setControlState('granted');
    else setControlState(prev =>
      (prev === 'pending' || prev === 'requesting') ? prev : 'idle');
  }, [pointerControlGranted]);

  useEffect(() => {
    const ch = createCoViewingChannel(channel);
    attachBroadcasts(ch, {
      onPageChange: (page) => { if (followingRef.current) onPageChange(page); },
      onSessionEnd: () => onSessionEnd(),
      onScrollChange: (s) => { if (followingRef.current) onScrollRef.current?.(s); },
      onZoomChange:   (z) => { if (followingRef.current) onZoomRef.current?.(z); },
    });

    ch.on('broadcast', { event: 'permission_changed' }, ({ payload }: { payload?: { email?: string; type?: string; granted?: boolean } }) => {
      if (!payload || payload.email?.toLowerCase() !== email.toLowerCase()) return;
      const granted = !!payload.granted;
      if (payload.type === 'free_scroll') {
        onFreeScrollChanged(granted);
        if (granted) {
          setFreeScrollState('granted');
          onSetFollowing(false);
        } else {
          setFreeScrollState('revoked-just-now');
          onSetFollowing(true);
          setTimeout(() => {
            setFreeScrollState(prev => prev === 'revoked-just-now' ? 'idle' : prev);
          }, 1500);
        }
      } else if (payload.type === 'pointer_control') {
        onPointerControlChanged(granted);
        if (granted) {
          setControlState('granted');
          // When the recipient gets control, they're driving — pull
          // them out of follow mode too so their scroll/page changes
          // aren't fighting the presenter's mirror.
          onSetFollowing(false);
        } else {
          setControlState('revoked-just-now');
          onSetFollowing(true);
          setTimeout(() => {
            setControlState(prev => prev === 'revoked-just-now' ? 'idle' : prev);
          }, 1500);
        }
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

  // Pointer-control: when we hold it, every page change we make is
  // broadcast to the presenter so they mirror. controlState comes
  // from our state machine (drops on revoke/release within a tick),
  // so we don't keep publishing past the moment control transfers.
  const lastPublishedPageRef = useRef<number | null>(null);
  useEffect(() => {
    if (controlState !== 'granted') return;
    if (lastPublishedPageRef.current === currentPage) return;
    lastPublishedPageRef.current = currentPage;
    const ch = supabase.getChannels().find(c => c.topic === `realtime:${channel}`);
    if (!ch) return;
    ch.send({
      type:  'broadcast',
      event: 'controller_page_change',
      payload: { email, page: currentPage },
    }).catch(() => {});
  }, [channel, controlState, currentPage, email]);

  async function requestPermission(type: PermType) {
    const setState = type === 'free_scroll' ? setFreeScrollState : setControlState;
    const current  = type === 'free_scroll' ? freeScrollState : controlState;
    if (current === 'requesting' || current === 'pending' || current === 'granted') return;
    setState('requesting');
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/request-permission`, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-App-Platform': 'desktop',
          'X-Access-Token': accessToken,
        },
        body: JSON.stringify({ type }),
      });
      if (!res.ok) { setState('idle'); return; }
      const data = await res.json().catch(() => ({}));
      setState(data.already_granted ? 'granted' : 'pending');
    } catch {
      setState('idle');
    }
  }

  async function releasePermission(type: PermType) {
    if (type === 'free_scroll') {
      onSetFollowing(true);
      setFreeScrollState('idle');
      onFreeScrollChanged(false);
    } else {
      onSetFollowing(true);
      setControlState('idle');
      onPointerControlChanged(false);
    }
    try {
      await fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/release-permission`, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-App-Platform': 'desktop',
          'X-Access-Token': accessToken,
        },
        body: JSON.stringify({ type }),
      });
    } catch {
      // Best-effort — server poll converges.
    }
  }

  if (mode === 'free') return null;

  const freeChip = renderChip({
    state:    freeScrollState,
    grantedLabel: 'Scroll freely',
    requestLabel: 'Request free scroll',
    active:   !following && freeScrollState === 'granted',
    onActivate: () => onSetFollowing(false),
    onRequest:  () => requestPermission('free_scroll'),
    icon:     <FreeScrollIcon />,
  });

  const controlChip = renderChip({
    state:    controlState,
    grantedLabel: 'Controlling',
    requestLabel: 'Request control',
    active:   !following && controlState === 'granted',
    onActivate: () => onSetFollowing(false),
    onRequest:  () => requestPermission('pointer_control'),
    icon:     <ControlIcon />,
  });

  // Releasing one permission while holding the other shouldn't drop
  // the Follow toggle into a weird state — Follow always means "yield
  // to the presenter". So the click handler releases BOTH if held.
  const handleFollowClick = () => {
    const heldFree    = freeScrollState === 'granted';
    const heldControl = controlState   === 'granted';
    if (heldFree)    releasePermission('free_scroll');
    if (heldControl) releasePermission('pointer_control');
    if (!heldFree && !heldControl) onSetFollowing(true);
  };

  return (
    <>
      {controlState === 'granted' && (
        <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 56, background: 'rgba(29,78,216,0.95)', color: '#FFFFFF',
          padding: '5px 12px', borderRadius: 14, fontSize: 11, fontWeight: 500,
          fontFamily: FONT, boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <ControlIcon />
          You are controlling the document
        </div>
      )}
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
          onClick={handleFollowClick}
          label="Follow presenter"
          icon={
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 11l19-9-9 19-2-8-8-2z"/>
            </svg>
          }
        />
        {freeChip}
        {controlChip}
      </div>
    </>
  );
}

function renderChip({ state, grantedLabel, requestLabel, active, onActivate, onRequest, icon }: {
  state:        PermState;
  grantedLabel: string;
  requestLabel: string;
  active:       boolean;
  onActivate:   () => void;
  onRequest:    () => void;
  icon:         React.ReactNode;
}) {
  switch (state) {
    case 'granted':
      return <SegmentBtn active={active} onClick={onActivate} label={grantedLabel} icon={icon} />;
    case 'requesting':
      return <SegmentBtn active={false} onClick={() => {}} label="Requesting…" icon={icon} disabled />;
    case 'pending':
      return <SegmentBtn active={false} onClick={() => {}} label="Waiting for approval" icon={icon} disabled amber />;
    case 'revoked-just-now':
      return <SegmentBtn active={false} onClick={() => {}} label="Returned to follow" icon={icon} disabled />;
    case 'idle':
    default:
      return <SegmentBtn active={false} onClick={onRequest} label={requestLabel} icon={icon} />;
  }
}

function FreeScrollIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 7l-4 5 4 5"/><path d="M17 7l4 5-4 5"/><line x1="3" y1="12" x2="21" y2="12"/>
    </svg>
  );
}

function ControlIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3l14 8-6 2-2 6-6-16z"/>
    </svg>
  );
}

function SegmentBtn({
  active, onClick, label, icon, disabled, amber,
}: {
  active:    boolean;
  onClick:   () => void;
  label:     string;
  icon:      React.ReactNode;
  disabled?: boolean;
  amber?:    boolean;
}) {
  const color = active ? '#FFFFFF' : amber ? '#FBBF24' : 'rgba(255,255,255,0.55)';
  const bg    = active ? '#1D4ED8' : 'transparent';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display:      'flex',
        alignItems:   'center',
        gap:          6,
        padding:      '5px 12px',
        borderRadius: 18,
        border:       'none',
        cursor:       disabled ? 'default' : active ? 'default' : 'pointer',
        background:   bg,
        color,
        fontSize:     11,
        fontWeight:   500,
        fontFamily:   FONT,
        whiteSpace:   'nowrap',
        opacity:      disabled ? 0.85 : 1,
        transition:   'background 0.12s ease, color 0.12s ease',
      }}
    >
      {icon}
      <span style={{ pointerEvents: 'none' }}>{label}</span>
    </button>
  );
}
