// Sprint 2 — BLOB_DELETED (HTTP 410) screen. Per roadmap memory: a
// dedicated screen, NOT a toast. The encrypted blob is gone from S3
// (cron cleanup after all recipients confirmed download); a retry will
// never succeed.

export function DownloadDeletedScreen({ onClose }: { onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: '#0F172A',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 16,
      color: '#F1F5F9',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: 32, textAlign: 'center',
    }}>
      <div style={{ fontSize: 48, lineHeight: 1, marginBottom: 4 }}>🗑</div>
      <div style={{ fontSize: 20, fontWeight: 500 }}>This file has been deleted.</div>
      <div style={{ fontSize: 13, color: '#94A3B8', maxWidth: 360, lineHeight: 1.5 }}>
        The encrypted copy on AspisFile's servers has been removed after all recipients confirmed download.
        Ask the sender to re-share if you still need access.
      </div>
      <button
        onClick={onClose}
        style={{
          marginTop: 8,
          padding: '8px 18px',
          background: '#1E293B',
          color: '#F1F5F9',
          border: '0.5px solid #334155',
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Close
      </button>
    </div>
  );
}
