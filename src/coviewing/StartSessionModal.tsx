import { useState, useEffect } from 'react';
import { fetch } from '@tauri-apps/plugin-http';

declare const __API_BASE__: string;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface Recipient {
  id:              string;
  recipient_email: string;
  status:          string;
}

interface StartSessionModalProps {
  fileId:   string;
  fileName: string;
  // Desktop owner-token — required to authenticate the modal's POST to /co-viewing/start
  // and the GET /recipients fetch (no Supabase auth session on desktop).
  token:    string;
  onStart:  (sessionId: string, channel: string, mode: 'synchronized' | 'free', context: 'standalone' | 'teams' | 'zoom') => void;
  onClose:  () => void;
}

export function StartSessionModal({ fileId, fileName, token, onStart, onClose }: StartSessionModalProps) {
  const [mode,       setMode]       = useState<'synchronized' | 'free'>('synchronized');
  const [context,   setContext]     = useState<'standalone' | 'teams' | 'zoom'>('standalone');
  const [guests,    setGuests]      = useState<string[]>([]);
  const [guestInput, setGuestInput] = useState('');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  // Subset of recipient emails the presenter chose to notify. Defaults
  // to all eligible (non-revoked) recipients on load, matching the
  // pre-checkbox "notify everyone" behavior so default UX is unchanged.
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [loading,   setLoading]     = useState(false);
  const [error,     setError]       = useState('');

  useEffect(() => {
    fetch(`${__API_BASE__}/api/v1/recipients?file_id=${fileId}`, {
      headers: {
        'X-App-Platform': 'desktop',
        'X-Access-Token': token,
      },
    })
      .then(r => r.json())
      .then(d => {
        const list = (d.recipients ?? []) as Recipient[];
        setRecipients(list);
        // Default: all non-revoked selected
        setSelectedEmails(new Set(
          list.filter(r => r.status !== 'revoked').map(r => r.recipient_email),
        ));
      })
      .catch(() => {});
  }, [fileId, token]);

  const eligibleRecipients = recipients.filter(r => r.status !== 'revoked');
  const allSelected = eligibleRecipients.length > 0
    && eligibleRecipients.every(r => selectedEmails.has(r.recipient_email));
  const noneSelected = selectedEmails.size === 0;

  const toggleRecipient = (email: string) => {
    setSelectedEmails(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedEmails(prev => {
      if (eligibleRecipients.every(r => prev.has(r.recipient_email))) {
        return new Set();
      }
      return new Set(eligibleRecipients.map(r => r.recipient_email));
    });
  };

  const addGuest = () => {
    const email = guestInput.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    if (guests.includes(email)) { setGuestInput(''); return; }
    setGuests(prev => [...prev, email]);
    setGuestInput('');
  };

  const removeGuest = (email: string) => setGuests(prev => prev.filter(e => e !== email));

  const handleStart = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/co-viewing/start`, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-App-Platform': 'desktop',
          'X-Access-Token': token,
        },
        body: JSON.stringify({
          file_id:        fileId,
          mode, context,
          session_guests: guests,
          // Subset filter — only these permanent recipients get email +
          // tray notifications. Empty array = notify no permanent
          // recipients (still creates the session, still notifies
          // session_guests via the realtime broadcast).
          notify_emails:  Array.from(selectedEmails),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to start session'); setLoading(false); return; }
      onStart(data.session_id, data.channel, mode, context);
    } catch {
      setError('Network error — please try again.');
      setLoading(false);
    }
  };

  const notifyCount = selectedEmails.size + guests.length;

  return (
    <div style={{
      position:       'fixed',
      inset:          0,
      background:     'rgba(0,0,0,0.5)',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      zIndex:         80,
      padding:        16,
      fontFamily:     FONT,
    }}>
      <div style={{
        background:   '#FFFFFF',
        border:       '0.5px solid #BFDBFE',
        borderRadius: 10,
        width:        '100%',
        maxWidth:     400,
        padding:      '22px',
        maxHeight:    '90vh',
        overflowY:    'auto',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 500, color: '#0F172A', margin: 0 }}>Start presenting</p>
            <p style={{ fontSize: 11, color: '#94A3B8', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>{fileName}</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: 4 }}>
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
          </button>
        </div>

        {/* Viewing mode */}
        <FieldLabel label="Viewing mode" />
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {(['synchronized', 'free'] as const).map(m => (
            <ModeChip key={m} label={m === 'synchronized' ? 'Synchronized' : 'Free scroll'} active={mode === m} onClick={() => setMode(m)} />
          ))}
        </div>

        {/* Context */}
        <FieldLabel label="Context" />
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {(['standalone', 'teams', 'zoom'] as const).map(c => (
            <ModeChip key={c} label={c.charAt(0).toUpperCase() + c.slice(1)} active={context === c} onClick={() => setContext(c)} />
          ))}
        </div>
        {context !== 'standalone' && (
          <p style={{ fontSize: 11, color: '#EF9F27', marginBottom: 14, marginTop: -8, lineHeight: 1.6 }}>
            Screenshot protection is not available in Teams/Zoom. Watermark attribution only.
          </p>
        )}

        {/* Permanent recipients with notify checkboxes */}
        {eligibleRecipients.length > 0 && (
          <>
            <FieldLabel label="Notify recipients" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14, maxHeight: 160, overflowY: 'auto' }}>
              {/* "All" master row — selecting toggles every row below */}
              <RecipientRow
                label="All recipients"
                checked={allSelected}
                indeterminate={!allSelected && !noneSelected}
                onToggle={toggleAll}
                muted
              />
              {eligibleRecipients.map(r => (
                <RecipientRow
                  key={r.id}
                  label={r.recipient_email}
                  checked={selectedEmails.has(r.recipient_email)}
                  onToggle={() => toggleRecipient(r.recipient_email)}
                />
              ))}
            </div>
          </>
        )}

        {/* Session-only guests */}
        <FieldLabel label="Session-only access" />
        <p style={{ fontSize: 11, color: '#94A3B8', marginBottom: 8, marginTop: -6, lineHeight: 1.5 }}>
          Can view during this session only. No file access after session ends.
        </p>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input
            type="email"
            value={guestInput}
            onChange={e => setGuestInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addGuest())}
            placeholder="Add email address"
            style={{ flex: 1, height: 32, padding: '0 10px', border: '0.5px solid #BFDBFE', borderRadius: 6, fontSize: 12, fontFamily: FONT, outline: 'none' }}
          />
          <button
            onClick={addGuest}
            style={{ padding: '0 12px', height: 32, borderRadius: 6, background: '#EFF6FF', border: '0.5px solid #BFDBFE', color: '#185FA5', fontSize: 12, cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}
          >
            Add
          </button>
        </div>
        {guests.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
            {guests.map(email => (
              <div key={email} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#F8FAFC', borderRadius: 5, border: '0.5px solid #BFDBFE' }}>
                <span style={{ fontSize: 11, color: '#64748B', flex: 1 }}>{email}</span>
                <span style={{ fontSize: 10, color: '#64748B', background: '#F1F5F9', padding: '1px 6px', borderRadius: 10 }}>Session only</span>
                <button onClick={() => removeGuest(email)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: '0 2px', lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
        )}

        {error && <p style={{ fontSize: 12, color: '#A32D2D', marginBottom: 12 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '9px 0', fontSize: 12, background: 'transparent', border: '0.5px solid #BFDBFE', borderRadius: 6, color: '#64748B', cursor: 'pointer', fontFamily: FONT }}>
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={loading}
            style={{ flex: 2, padding: '9px 0', fontSize: 12, fontWeight: 500, background: loading ? '#BFDBFE' : '#1D4ED8', border: 'none', borderRadius: 6, color: '#FFFFFF', cursor: loading ? 'wait' : 'pointer', fontFamily: FONT }}
          >
            {loading
              ? 'Starting…'
              : notifyCount > 0
                ? `Start presenting · notify ${notifyCount}`
                : 'Start presenting'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ label }: { label: string }) {
  return <p style={{ fontSize: 11, fontWeight: 500, color: '#64748B', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</p>;
}

function RecipientRow({
  label,
  checked,
  indeterminate,
  onToggle,
  muted,
}: {
  label:          string;
  checked:        boolean;
  indeterminate?: boolean;
  onToggle:       () => void;
  /** Visual distinction for the "All" master row */
  muted?:         boolean;
}) {
  // Tri-state visual: checked → blue with ✓, indeterminate → blue with −, unchecked → white border
  const boxBg     = checked || indeterminate ? '#1D4ED8' : '#FFFFFF';
  const boxBorder = checked || indeterminate ? '#1D4ED8' : '#BFDBFE';
  return (
    <button
      onClick={onToggle}
      style={{
        display:         'flex',
        alignItems:      'center',
        gap:             8,
        padding:         '5px 8px',
        background:      muted ? '#F1F5F9' : '#F8FAFC',
        borderRadius:    5,
        border:          `0.5px solid ${muted ? '#CBD5E1' : '#BFDBFE'}`,
        cursor:          'pointer',
        textAlign:       'left',
        fontFamily:      FONT,
      }}
    >
      <span
        style={{
          flexShrink:     0,
          width:          14,
          height:         14,
          borderRadius:   3,
          border:         `1px solid ${boxBorder}`,
          background:     boxBg,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
        }}
      >
        {checked && !indeterminate && (
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 5.5l2 2 4-4.5" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {indeterminate && (
          <span style={{ width: 7, height: 1.5, background: '#FFFFFF', borderRadius: 1 }} />
        )}
      </span>
      <span style={{
        flex:       1,
        fontSize:   muted ? 11 : 11,
        fontWeight: muted ? 500 : 400,
        color:      muted ? '#475569' : '#64748B',
        whiteSpace: 'nowrap',
        overflow:   'hidden',
        textOverflow: 'ellipsis',
      }}>
        {label}
      </span>
      {!muted && (
        <span style={{ fontSize: 10, color: '#3B82F6', background: '#EFF6FF', padding: '1px 6px', borderRadius: 10 }}>
          Permanent
        </span>
      )}
    </button>
  );
}

function ModeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding:      '5px 12px',
        borderRadius: 6,
        border:       `0.5px solid ${active ? '#3B82F6' : '#BFDBFE'}`,
        background:   active ? '#EFF6FF' : 'transparent',
        color:        active ? '#185FA5' : '#64748B',
        fontSize:     12,
        cursor:       'pointer',
        fontFamily:   FONT,
      }}
    >
      {label}
    </button>
  );
}
