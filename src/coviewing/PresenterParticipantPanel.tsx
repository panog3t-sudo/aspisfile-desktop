import { useEffect, useState } from 'react';
import { fetch } from '@tauri-apps/plugin-http';
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

  // Realtime presence subscription
  useEffect(() => {
    const ch = createCoViewingChannel(channel);
    attachPresence(ch, {
      onPresenceSync: (state) => {
        // state: { [presenceKey]: RecipientPresence[] }
        // Flatten — one entry per key (single device per email).
        const flat: Record<string, PresenceRow> = {};
        for (const arr of Object.values(state)) {
          for (const p of arr) {
            if (p && typeof p.email === 'string') {
              flat[p.email.toLowerCase()] = {
                email:     p.email,
                page:      p.page,
                following: p.following,
                joined_at: p.joined_at,
              };
            }
          }
        }
        setPresence(flat);
        // Anyone now back in presence is no longer "gone"
        setGone(prev => {
          const next = { ...prev };
          for (const email of Object.keys(flat)) {
            delete next[email];
          }
          return next;
        });
      },
      onPresenceJoin: (newPresences) => {
        const ts = Date.now();
        const updates: Record<string, number> = {};
        for (const p of newPresences) {
          if (p && p.email) updates[p.email.toLowerCase()] = ts;
        }
        if (Object.keys(updates).length === 0) return;
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
        const updates: Record<string, { at: number }> = {};
        for (const p of leftPresences) {
          if (p && p.email) updates[p.email.toLowerCase()] = { at: ts };
        }
        if (Object.keys(updates).length > 0) {
          setGone(prev => ({ ...prev, ...updates }));
        }
      },
    });
    ch.subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [channel]);

  // 1s tick to drive live timers
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const rows = roster.map(r => {
    const emailKey = r.recipient_email.toLowerCase();
    const pres     = presence[emailKey];
    const goneAt   = gone[emailKey]?.at ?? null;
    const isLive   = !!pres && !goneAt;
    const flashAt  = recentJoin[emailKey];
    return {
      email:        r.recipient_email,
      joinedAt:     r.joined_at,
      accessType:   r.access_type,
      page:         pres?.page ?? r.last_seen_page,
      following:    pres?.following,
      isLive,
      goneAt,
      isFlashing:   !!flashAt && Date.now() - flashAt < 3000,
    };
  }).sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return a.email.localeCompare(b.email);
  });

  const liveCount = rows.filter(r => r.isLive).length;

  return (
    <aside
      style={{
        width:         320,
        flexShrink:    0,
        height:        '100vh',
        background:    '#0F172A',
        borderLeft:    '0.5px solid rgba(59,130,246,0.4)',
        // Account for fixed PresenterToolbar overlay at top
        paddingTop:    44,
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
}: {
  email:         string;
  joinedAt:      string;
  accessType:    'permanent' | 'session_only';
  page:          number;
  following?:    boolean;
  isLive:        boolean;
  isFlashing:    boolean;
  goneAt:        number | null;
  presenterPage: number;
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
