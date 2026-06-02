import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { StepUpCreds } from "./StepUpScreen";

// Rendered by SecureViewer when /api/v1/mobile/access returns
//   { status: 'pending_approval', mechanism: 'sender', approval_id, expires_at }
//
// The sender (file owner) must explicitly approve the open from their
// dashboard or mobile app. Recipient has nothing to do but wait.
//
// Mechanics:
//   - Subscribes to Supabase Realtime channel `viewer-approval-<id>`.
//     When the sender approves, the server fires a `key_issued`
//     broadcast with session_id + session_key + device_share. We pass
//     those to onApproved which lets SecureViewer continue rendering
//     the file the same as if the open had never been gated.
//
//   - Countdown to expires_at. When the timer hits zero, the approval
//     is auto-expired by the server and the recipient sees the
//     "Request expired" state.
//
//   - Recipient can close the window; the approval stays pending on
//     the server. When the sender approves later, the recipient
//     receives an email (sendApprovalGrantedEmail) and the next time
//     they relaunch AspisFile the auto-resume picks up the approved
//     state (handled in App.tsx, separate task).

interface Props {
  approvalId:      string;
  fileName:        string;
  senderName:      string;
  expiresAt:       string | null;
  onApproved:      (creds: StepUpCreds) => void;
  onCancel:        () => void;
}

type Phase = "waiting" | "approved" | "rejected" | "expired";

export function SenderApprovalWaitingScreen({
  approvalId,
  fileName,
  senderName,
  expiresAt,
  onApproved,
  onCancel,
}: Props) {
  const [phase, setPhase]     = useState<Phase>("waiting");
  const [remaining, setRemaining] = useState<number>(() => {
    if (!expiresAt) return 0;
    return Math.max(0, new Date(expiresAt).getTime() - Date.now());
  });

  // ── Realtime subscription ────────────────────────────────────────
  // The same channel the server broadcasts on in /api/v1/approvals/
  // [id]/respond. event: 'key_issued' carries session credentials; the
  // 'denied' / 'expired' events flip the UI to the matching terminal
  // state.
  useEffect(() => {
    const channel = supabase
      .channel(`viewer-approval-${approvalId}`)
      .on('broadcast', { event: 'key_issued' }, (msg) => {
        const payload = msg.payload as {
          session_id:   string;
          session_key:  string;
          device_share: string | null;
          file_id:      string;
          expires_at:   string;
        };
        setPhase("approved");
        onApproved({
          session_id:   payload.session_id,
          session_key:  payload.session_key,
          device_share: payload.device_share ?? null,
          file_id:      payload.file_id,
          expires_at:   payload.expires_at,
        });
      })
      .on('broadcast', { event: 'denied' }, () => setPhase("rejected"))
      .on('broadcast', { event: 'expired' }, () => setPhase("expired"))
      .subscribe();

    return () => {
      supabase.removeChannel(channel).then(() => {}, () => {});
    };
  }, [approvalId, onApproved]);

  // ── Countdown tick ──────────────────────────────────────────────
  useEffect(() => {
    if (!expiresAt || phase !== "waiting") return;
    const tick = () => {
      const r = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      setRemaining(r);
      if (r === 0) setPhase("expired");
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, phase]);

  const hms = formatRemaining(remaining);

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        {phase === "waiting" && (
          <>
            <Spinner />
            <h1 style={titleStyle}>Waiting for {senderName} to approve</h1>
            <p style={subtitleStyle}>
              Because this is the first file from {senderName}, they need to
              approve your access. They&apos;ll get a notification on their
              dashboard and mobile.
            </p>

            <div style={metaBoxStyle}>
              <Row label="File"    value={fileName} />
              <Row label="Sender"  value={senderName} />
              {expiresAt && <Row label="Expires" value={`in ${hms}`} />}
            </div>

            <p style={{ fontSize: 12, color: '#94A3B8', margin: '24px 0 0', lineHeight: 1.6 }}>
              You can close this window — {senderName} will get the request
              either way, and we&apos;ll email you when access is granted.
            </p>

            <button onClick={onCancel} style={cancelButtonStyle}>
              Close and try later
            </button>
          </>
        )}

        {phase === "approved" && (
          <>
            <h1 style={titleStyle}>✓ Approved</h1>
            <p style={subtitleStyle}>Opening the file…</p>
          </>
        )}

        {phase === "rejected" && (
          <>
            <h1 style={titleStyle}>{senderName} declined access</h1>
            <p style={subtitleStyle}>
              {senderName} chose not to grant access to {fileName}. Contact
              them directly if you think this is a mistake.
            </p>
            <button onClick={onCancel} style={primaryButtonStyle}>Close</button>
          </>
        )}

        {phase === "expired" && (
          <>
            <h1 style={titleStyle}>Request expired</h1>
            <p style={subtitleStyle}>
              {senderName} didn&apos;t respond in time. Open the link in your
              email again to try once more, or contact them directly.
            </p>
            <button onClick={onCancel} style={primaryButtonStyle}>Close</button>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
      <span style={{ color: '#94A3B8' }}>{label}</span>
      <span style={{ color: '#0F172A', fontWeight: 500, maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <div style={{
        width: 32, height: 32,
        border: '3px solid #BFDBFE',
        borderTopColor: '#185FA5',
        borderRadius: '50%',
        margin: '0 auto 24px',
        animation: 'aspis-wait-spin 0.8s linear infinite',
      }} />
      <style>{`@keyframes aspis-wait-spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const containerStyle: React.CSSProperties = {
  position:   'fixed',
  inset:      0,
  background: 'rgba(15, 23, 42, 0.94)',
  display:    'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex:     1000,
  padding:    24,
  fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
};

const cardStyle: React.CSSProperties = {
  background:    '#fff',
  borderRadius:  12,
  padding:       '40px 32px',
  maxWidth:      440,
  width:         '100%',
  textAlign:     'center',
  boxShadow:     '0 16px 48px rgba(0,0,0,0.4)',
};

const titleStyle: React.CSSProperties = {
  fontSize:   18,
  fontWeight: 600,
  color:      '#0F172A',
  margin:     '0 0 8px',
};

const subtitleStyle: React.CSSProperties = {
  fontSize:   13,
  color:      '#64748B',
  lineHeight: 1.6,
  margin:     '0 0 24px',
};

const metaBoxStyle: React.CSSProperties = {
  background:    '#F8FAFC',
  border:        '0.5px solid #E2E8F0',
  borderRadius:  8,
  padding:       '8px 16px',
  textAlign:     'left',
  marginTop:     8,
};

const primaryButtonStyle: React.CSSProperties = {
  marginTop:    16,
  width:        '100%',
  padding:      '11px 0',
  borderRadius: 8,
  background:   '#185FA5',
  color:        '#fff',
  border:       'none',
  fontSize:     14,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
};

const cancelButtonStyle: React.CSSProperties = {
  marginTop:    20,
  background:   'transparent',
  color:        '#94A3B8',
  border:       'none',
  fontSize:     12,
  cursor:       'pointer',
  fontFamily:   'inherit',
};
