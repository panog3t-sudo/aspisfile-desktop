import { useEffect, useRef } from 'react';
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
  // Recipient identity + page state — published as Realtime presence so
  // the presenter's participant panel can render live status (page,
  // follow mode, joined/left).
  email:          string;
  currentPage:    number;
  joinedAt:       string; // ISO from the moment /join succeeded
  onPageChange:   (page: number) => void;
  onSessionEnd:   () => void;
  onSetFollowing: (following: boolean) => void;
  // Scroll + zoom mirror callbacks. Fire when the presenter broadcasts
  // a change; SecureViewer updates its state and TileRenderer applies
  // it (only when followingPresenter — free-mode recipients ignore).
  onScrollChange?: (s: ScrollChangePayload) => void;
  onZoomChange?:   (z: ZoomChangePayload)   => void;
}

// Bottom-of-viewer pill shown to recipients in a synchronized session.
// Two-cell segmented control — the active cell is highlighted; clicking
// the other cell switches mode.
//
// In addition to UI, this component subscribes to the co-viewing channel
// and tracks Realtime presence so the presenter sees this recipient as
// live with their current page + follow mode.
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
}: CoViewingRecipientProps) {
  const followingRef     = useRef(following);
  followingRef.current   = following;
  const onScrollRef      = useRef(onScrollChange);
  onScrollRef.current    = onScrollChange;
  const onZoomRef        = useRef(onZoomChange);
  onZoomRef.current      = onZoomChange;

  // One channel object for the lifetime of this component. Subscribes
  // for broadcasts (presenter page sync, session end) AND tracks the
  // recipient's presence. The channel auto-publishes presence_leave on
  // teardown.
  useEffect(() => {
    const ch = createCoViewingChannel(channel);
    attachBroadcasts(ch, {
      onPageChange: (page) => { if (followingRef.current) onPageChange(page); },
      onSessionEnd: () => onSessionEnd(),
      // Scroll + zoom mirror only while following. Free-mode recipients
      // ignore presenter scroll/zoom and navigate independently.
      onScrollChange: (s) => { if (followingRef.current) onScrollRef.current?.(s); },
      onZoomChange:   (z) => { if (followingRef.current) onZoomRef.current?.(z); },
    });
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await ch.track({
          email,
          page:      currentPage,
          following,
          joined_at: joinedAt,
        } as RecipientPresence);
      }
    });
    return () => {
      // Explicit untrack flushes presence_leave to the channel
      // synchronously. Without this, the presenter's strikethrough
      // sometimes takes the full Supabase heartbeat timeout (30-60s)
      // to drop the entry. removeChannel alone is meant to deliver
      // the leave but the broadcast can race the disconnect.
      ch.untrack().catch(() => {});
      supabase.removeChannel(ch);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  // Re-publish presence whenever page or following changes. The track
  // helper merges into the existing presence entry so the presenter sees
  // an update instantly via presence_sync.
  useEffect(() => {
    const ch = supabase.getChannels().find(c => c.topic === `realtime:${channel}`);
    if (!ch) return;
    ch.track({
      email,
      page:      currentPage,
      following,
      joined_at: joinedAt,
    } as RecipientPresence).catch(() => {});
  }, [channel, email, currentPage, following, joinedAt]);

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
