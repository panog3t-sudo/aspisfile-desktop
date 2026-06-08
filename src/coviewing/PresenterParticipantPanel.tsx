import { useCallback, useEffect, useRef, useState } from 'react';
import { fetch } from '@tauri-apps/plugin-http';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import {
  createCoViewingChannel,
  attachPresence,
} from '../lib/coviewing-realtime';

declare const __API_BASE__: string;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface Props {
  sessionId:    string;
  channel:      string;
  // Desktop owner-token for the /participants poll
  token:        string;
  // Presenter's current page — used to compute "same page as you" per row
  currentPage:  number;
  onClose:      () => void;
}

interface ParticipantRow {
  recipient_email: string;
  joined_at:       string;
  access_type:     'permanent' | 'session_only';
  last_seen_page:  number;
  free_scroll_granted:      boolean;
  free_scroll_requested_at: string | null;
}

interface PresenceRow {
  email:     string;
  page:      number;
  following: boolean;
  joined_at: string;
}

// Persistent RHS sidebar for the presenter. Combines two data sources:
//   - DB roster (poll /participants every 10s) — authoritative list of
//     who was invited + the last page they reported
//   - Realtime presence on the session channel — authoritative live
//     connection status + per-viewer follow mode (presence track state).
//     presence_leave fires automatically on viewer disconnect.
//
// Row state derived per render:
//   - live:       in presence AND not in gone map
//   - gone:       was in presence, now not (presence_leave fired)
//   - recentJoin: flash green border for 3s after presence_join
//
// Timer ticks every 1s from joined_at.
export function PresenterParticipantPanel({
  sessionId, channel, token, currentPage, onClose,
}: Props) {
  const [roster, setRoster]         = useState<ParticipantRow[]>([]);
  const [presence, setPresence]     = useState<Record<string, PresenceRow>>({});
  const [gone, setGone]             = useState<Record<string, { at: number }>>({});
  const [recentJoin, setRecentJoin] = useState<Record<string, number>>({});
  const [, setTick]                 = useState(0);
  const channelRef                  = useRef<RealtimeChannel | null>(null);

  // Reconcile local state from a presenceState snapshot. Two paths
  // call this: presence_sync event handler (fast), and a 3s defensive
  // poll (backup for when sync/leave events don't arrive — sometimes
  // happens after a recipient hard-closes their file).
  const reconcilePresence = useCallback((state: Record<string, unknown[]>) => {
    const flat: Record<string, PresenceRow> = {};
    for (const arr of Object.values(state)) {
      for (const p of arr as Array<Partial<PresenceRow>>) {
        if (p && typeof p.email === 'string') {
          flat[p.email.toLowerCase()] = {
            email:     p.email,
            page:      p.page ?? 1,
            following: p.following ?? false,
            joined_at: p.joined_at ?? new Date().toISOString(),
          };
        }
      }
    }
    setPresence(prev => {
      // Anyone in prev but not in flat is newly gone — record the moment.
      const ts = Date.now();
      const newlyGone: Record<string, { at: number }> = {};
      for (const email of Object.keys(prev)) {
        if (!flat[email]) newlyGone[email] = { at: ts };
      }
      if (Object.keys(newlyGone).length > 0) {
        setGone(g => ({ ...newlyGone, ...g })); // existing wins (preserve first detection time)
      }
      return flat;
    });
    setGone(prev => {
      const next = { ...prev };
      for (const email of Object.keys(flat)) delete next[email]; // back live
      return next;
    });
  }, []);

  // DB roster poll
  useEffect(() => {
    const fetch_ = () => {
      fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/participants`, {
        headers: { 'X-App-Platform': 'desktop', 'X-Access-Token': token },
      })
        .then(r => r.json())
        .then(d => setRoster(d.participants ?? []))
        .catch(() => {});
    };
    fetch_();
    const iv = setInterval(fetch_, 10_000);
    return () => clearInterval(iv);
  }, [sessionId, token]);

  // Realtime presence subscription + 3s defensive poll.
  //
  // Three layers of detection, in order of preference:
  //   1. presence_join / presence_leave events — immediate updates when
  //      they fire reliably.
  //   2. presence_sync events — full state reconcile.
  //   3. 3s poll of ch.presenceState() — backup for cases where Supabase
  //      doesn't deliver the leave event to a long-lived subscriber.
  //      This was the actual fix for "timer keeps running and the name
  //      isn't crossed out until I close/reopen the panel": leave fired
  //      on the recipient side but the presenter's subscription never
  //      saw it. Poll catches the stale "live" entry within 3s.
  useEffect(() => {
    const ch = createCoViewingChannel(channel);
    channelRef.current = ch;
    attachPresence(ch, {
      onPresenceSync: (state) => {
        reconcilePresence(state as unknown as Record<string, unknown[]>);
      },
      onPresenceJoin: (newPresences) => {
        const ts = Date.now();
        const updates: Record<string, number> = {};
        const presenceAdditions: Record<string, PresenceRow> = {};
        for (const p of newPresences) {
          if (!p || !p.email) continue;
          const key = p.email.toLowerCase();
          updates[key] = ts;
          presenceAdditions[key] = {
            email:     p.email,
            page:      p.page,
            following: p.following,
            joined_at: p.joined_at,
          };
        }
        if (Object.keys(updates).length === 0) return;
        // Add to presence immediately
        setPresence(prev => ({ ...prev, ...presenceAdditions }));
        // Clear gone for these emails (they're back)
        setGone(prev => {
          const next = { ...prev };
          for (const email of Object.keys(updates)) delete next[email];
          return next;
        });
        // Flash highlight for 3s
        setRecentJoin(prev => ({ ...prev, ...updates }));
        setTimeout(() => {
          setRecentJoin(prev => {
            const next = { ...prev };
            for (const email of Object.keys(updates)) {
              if (next[email] === updates[email]) delete next[email];
            }
            return next;
          });
        }, 3000);
      },
      onPresenceLeave: (leftPresences) => {
        const ts = Date.now();
        const leaverEmails: string[] = [];
        for (const p of leftPresences) {
          if (p && p.email) leaverEmails.push(p.email.toLowerCase());
        }
        if (leaverEmails.length === 0) return;
        // Mark gone for the "Left HH:MM" + strikethrough rendering
        setGone(prev => {
          const next = { ...prev };
          for (const email of leaverEmails) next[email] = { at: ts };
          return next;
        });
        // Remove from presence immediately — don't wait for sync to
        // catch up (was the cause of the stale-row bug).
        setPresence(prev => {
          const next = { ...prev };
          for (const email of leaverEmails) delete next[email];
          return next;
        });
      },
    });
    // Server-side guest_left broadcast (fired by /viewer/<fileId>/close
    // when the closing viewer_session had a co_viewing_participant_id).
    // Authoritative belt-and-braces over Supabase Realtime presence,
    // which sometimes leaves the local presenceState cache stale on
    // a remote disconnect — the presenter would otherwise see the
    // guest as "live" until the next panel re-mount.
    ch.on('broadcast', { event: 'guest_left' }, ({ payload }: { payload?: { email?: string } }) => {
      const email = payload?.email?.toLowerCase();
      if (!email) return;
      const ts = Date.now();
      setGone(prev => ({ ...prev, [email]: { at: ts } }));
      setPresence(prev => {
        const next = { ...prev };
        delete next[email];
        return next;
      });
    });
    // Sprint 8 — recipient asked for a permission. Optimistically
    // update the roster row so the presenter sees the pending badge
    // before the next /participants poll. The poll itself converges
    // the canonical state.
    ch.on('broadcast', { event: 'permission_request' }, ({ payload }: { payload?: { email?: string; type?: string; requested_at?: string } }) => {
      const email = payload?.email?.toLowerCase();
      if (!email || payload?.type !== 'free_scroll') return;
      setRoster(prev => prev.map(r =>
        r.recipient_email.toLowerCase() === email
          ? { ...r, free_scroll_requested_at: payload.requested_at ?? new Date().toISOString() }
          : r,
      ));
    });
    ch.subscribe();
    return () => {
      channelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [channel, reconcilePresence]);

  // Defensive presence poll — Supabase Realtime occasionally fails to
  // deliver presence_leave events to a long-lived subscriber. Polling
  // ch.presenceState() and re-running the reconcile keeps the panel
  // accurate within 3s regardless.
  useEffect(() => {
    const iv = setInterval(() => {
      const ch = channelRef.current;
      if (!ch) return;
      try {
        const state = ch.presenceState();
        reconcilePresence(state as unknown as Record<string, unknown[]>);
      } catch {
        // ignore — channel might be torn down
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [reconcilePresence]);

  // 1s tick to drive live timers
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  // Sprint 8 — Grant/revoke free scroll. Optimistic update on the
  // local roster row; the /participants poll converges canonical state.
  async function setFreeScroll(email: string, granted: boolean) {
    setRoster(prev => prev.map(r =>
      r.recipient_email.toLowerCase() === email.toLowerCase()
        ? { ...r, free_scroll_granted: granted, free_scroll_requested_at: null }
        : r,
    ));
    try {
      await fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/grant-permission`, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-App-Platform': 'desktop',
          'X-Access-Token': token,
        },
        body: JSON.stringify({ recipient_email: email, type: 'free_scroll', granted }),
      });
    } catch {
      // Best-effort — the next poll will correct any drift.
    }
  }

  const rows = roster.map(r => {
    const emailKey = r.recipient_email.toLowerCase();
    const pres     = presence[emailKey];
    const goneAt   = gone[emailKey]?.at ?? null;
    const isLive   = !!pres && !goneAt;
    const flashAt  = recentJoin[emailKey];
    return {
      email:                    r.recipient_email,
      joinedAt:                 r.joined_at,
      accessType:               r.access_type,
      page:                     pres?.page ?? r.last_seen_page,
      following:                pres?.following,
      isLive,
      goneAt,
      isFlashing:               !!flashAt && Date.now() - flashAt < 3000,
      freeScrollGranted:        r.free_scroll_granted,
      freeScrollRequestedAt:    r.free_scroll_requested_at,
    };
  }).sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return a.email.localeCompare(b.email);
  });

  const liveCount = rows.filter(r => r.isLive).length;

  return (
    <aside
      style={{
        // Compact width — the previous 320px was too wide. 260 fits
        // initials avatar + email (with ellipsis at long addresses) +
        // page badge + close button. SecureViewer's flex container now
        // handles the PresenterToolbar overlap by pushing the whole
        // row down 44px, so we no longer carry paddingTop here.
        width:         260,
        flexShrink:    0,
        height:        '100%',
        background:    '#0F172A',
        borderLeft:    '0.5px solid rgba(59,130,246,0.4)',
        display:       'flex',
        flexDirection: 'column',
        fontFamily:    FONT,
        boxSizing:     'border-box',
      }}
    >
      {/* Header */}
      <div style={{
        padding:        '14px 16px',
        borderBottom:   '0.5px solid rgba(59,130,246,0.25)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        flexShrink:     0,
      }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 500, color: '#FFFFFF', margin: 0 }}>
            Participants
          </p>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', margin: '2px 0 0' }}>
            {liveCount} of {rows.length} live
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Hide participant panel"
          title="Hide participant panel"
          style={{
            width:          26,
            height:         26,
            borderRadius:   4,
            border:         '0.5px solid rgba(255,255,255,0.15)',
            background:     'rgba(255,255,255,0.06)',
            color:          'rgba(255,255,255,0.7)',
            cursor:         'pointer',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            fontSize:       14,
            lineHeight:     1,
            fontFamily:     'system-ui',
          }}
        >
          ›
        </button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {rows.length === 0 ? (
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textAlign: 'center', margin: '24px 8px 0', lineHeight: 1.6 }}>
            Waiting for someone to join…
          </p>
        ) : (
          rows.map(r => (
            <RowView
              key={r.email}
              email={r.email}
              joinedAt={r.joinedAt}
              accessType={r.accessType}
              page={r.page}
              following={r.following}
              isLive={r.isLive}
              isFlashing={r.isFlashing}
              goneAt={r.goneAt}
              presenterPage={currentPage}
              freeScrollGranted={r.freeScrollGranted}
              freeScrollRequestedAt={r.freeScrollRequestedAt}
              onGrantFreeScroll={() => setFreeScroll(r.email, true)}
              onRevokeFreeScroll={() => setFreeScroll(r.email, false)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function RowView({
  email,
  joinedAt,
  accessType,
  page,
  following,
  isLive,
  isFlashing,
  goneAt,
  presenterPage,
  freeScrollGranted,
  freeScrollRequestedAt,
  onGrantFreeScroll,
  onRevokeFreeScroll,
}: {
  email:                   string;
  joinedAt:                string;
  accessType:              'permanent' | 'session_only';
  page:                    number;
  following?:              boolean;
  isLive:                  boolean;
  isFlashing:              boolean;
  goneAt:                  number | null;
  presenterPage:           number;
  freeScrollGranted:       boolean;
  freeScrollRequestedAt:   string | null;
  onGrantFreeScroll:       () => void;
  onRevokeFreeScroll:      () => void;
}) {
  const initials  = email.slice(0, 2).toUpperCase();
  const bg        = colorFromEmail(email);
  const onSame    = page === presenterPage;
  const leftLabel = goneAt
    ? `Left ${new Date(goneAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : null;

  return (
    <div style={{
      display:      'flex',
      gap:          10,
      alignItems:   'center',
      padding:      '8px 10px',
      borderRadius: 6,
      marginBottom: 4,
      background:   isFlashing ? 'rgba(134,239,172,0.10)' : 'transparent',
      border:       isFlashing ? '0.5px solid rgba(134,239,172,0.6)' : '0.5px solid transparent',
      opacity:      isLive ? 1 : 0.45,
      transition:   'background 0.2s ease, opacity 0.2s ease, border-color 0.2s ease',
    }}>
      {/* Avatar */}
      <span style={{
        flexShrink:     0,
        width:          28,
        height:         28,
        borderRadius:   '50%',
        background:     bg,
        color:          '#FFFFFF',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        fontSize:       10,
        fontWeight:     600,
        letterSpacing:  0.4,
      }}>
        {initials}
      </span>

      {/* Email + secondary line */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize:       12,
          fontWeight:     500,
          color:          'rgba(255,255,255,0.9)',
          margin:         0,
          textDecoration: isLive ? 'none' : 'line-through',
          whiteSpace:     'nowrap',
          overflow:       'hidden',
          textOverflow:   'ellipsis',
        }}>
          {email}
        </p>
        <p style={{
          fontSize:     10,
          color:        'rgba(255,255,255,0.5)',
          margin:       '2px 0 0',
          whiteSpace:   'nowrap',
          overflow:     'hidden',
          textOverflow: 'ellipsis',
        }}>
          {leftLabel ?? (
            <>
              {isLive ? elapsedLabel(joinedAt) : '—'}
              {accessType === 'session_only' && (
                <span style={{ color: 'rgba(255,255,255,0.4)' }}> · guest</span>
              )}
              {isLive && following !== undefined && (
                <span style={{ color: following ? '#93C5FD' : 'rgba(255,255,255,0.5)' }}>
                  {' · '}{following ? 'Following' : 'Free'}
                </span>
              )}
            </>
          )}
        </p>
      </div>

      {/* Permission controls — only relevant while live */}
      {isLive && (
        <>
          {freeScrollRequestedAt && !freeScrollGranted && (
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                onClick={onGrantFreeScroll}
                title={`Grant free scroll to ${email}`}
                style={permBtnStyle('grant')}
              >Grant</button>
              <button
                onClick={onRevokeFreeScroll}
                title="Dismiss the request"
                style={permBtnStyle('deny')}
              >Deny</button>
            </div>
          )}
          {freeScrollGranted && (
            <button
              onClick={onRevokeFreeScroll}
              title={`Revoke free scroll from ${email}`}
              style={permBtnStyle('revoke')}
            >Revoke</button>
          )}
        </>
      )}

      {/* Page badge */}
      <span
        title={isLive ? (onSame ? 'On your page' : `Viewing page ${page}`) : `Last seen on page ${page}`}
        style={{
          flexShrink:   0,
          fontSize:     10,
          color:        onSame ? '#86EFAC' : '#FDE68A',
          background:   onSame ? 'rgba(134,239,172,0.12)' : 'rgba(253,230,138,0.12)',
          padding:      '2px 7px',
          borderRadius: 9,
          fontWeight:   500,
        }}
      >
        p{page}
      </span>
    </div>
  );
}

function permBtnStyle(kind: 'grant' | 'deny' | 'revoke'): React.CSSProperties {
  const palette = {
    grant:  { bg: 'rgba(134,239,172,0.18)', fg: '#86EFAC', border: 'rgba(134,239,172,0.4)' },
    deny:   { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.6)', border: 'rgba(255,255,255,0.15)' },
    revoke: { bg: 'rgba(252,165,165,0.16)', fg: '#FCA5A5', border: 'rgba(252,165,165,0.4)' },
  }[kind];
  return {
    flexShrink:   0,
    fontSize:     10,
    fontWeight:   500,
    padding:      '3px 8px',
    borderRadius: 8,
    background:   palette.bg,
    color:        palette.fg,
    border:       `0.5px solid ${palette.border}`,
    cursor:       'pointer',
    fontFamily:   FONT,
    whiteSpace:   'nowrap',
  };
}

function elapsedLabel(isoStart: string): string {
  const start = new Date(isoStart).getTime();
  if (Number.isNaN(start)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}

// Deterministic avatar background — same email always lands on the same
// hue. Hash → HSL.
function colorFromEmail(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h << 5) - h + email.charCodeAt(i);
    h |= 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}
