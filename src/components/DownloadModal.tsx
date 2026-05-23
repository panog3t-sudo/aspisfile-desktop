// Sprint 2 — passive notification after a successful download write.
// The audit confirmation already fired (download-confirmed POST inside
// runDownload). This modal is UI-only. "Done" closes it and the viewer
// state machine sits at "confirmed".

export function DownloadModal({ fileName, onDone }: { fileName: string; onDone: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(15, 23, 42, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#fff',
        borderRadius: 10,
        padding: '20px 22px',
        minWidth: 340, maxWidth: 420,
        boxShadow: '0 12px 32px rgba(15, 23, 42, 0.25)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: '#EAF3DE',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 12,
        }}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M3 8.5L6.5 12L13 5" stroke="#3B6D11" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div style={{ fontSize: 16, fontWeight: 500, color: '#0F172A', marginBottom: 6 }}>
          Your file has been saved to your device.
        </div>
        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 18, wordBreak: 'break-all' }}>
          {fileName}
        </div>
        <button
          onClick={onDone}
          style={{
            width: '100%',
            padding: '9px 14px',
            background: '#0F172A',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
