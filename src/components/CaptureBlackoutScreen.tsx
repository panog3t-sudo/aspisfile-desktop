// Shown when a dedicated screen-capture / recording tool (OBS, Loom,
// Snagit, CleanShot, …) is detected running while a document is open.
// The TileRenderer is unmounted behind this, so the tiles genuinely stop
// rendering (defense in depth on top of the window's contentProtected
// flag). Reversible: when the capture tool closes, the poll in
// SecureViewer clears the detection and the viewer comes back.
// Shown briefly when a Print Screen keypress is detected. Unlike the recorder
// blackout (a persistent running-process state), a screenshot is a one-off
// event, so this auto-clears after a few seconds. The tiles are unmounted
// behind it, and the sender has been notified of the attempt.
export function ScreenshotPausedScreen() {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000', zIndex: 10000,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 32,
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
    }}>
      <p style={{ color: '#fff', fontSize: 18, fontWeight: 600, margin: '0 0 8px', textAlign: 'center' }}>
        Screenshot detected
      </p>
      <p style={{ color: '#94A3B8', fontSize: 14, lineHeight: 1.5, textAlign: 'center', maxWidth: 480 }}>
        This document is confidential and screenshots are not permitted. The sender has been notified. Viewing resumes in a moment.
      </p>
    </div>
  );
}

export function CaptureBlackoutScreen({ apps }: { apps: string[] }) {
  const list = apps.join(', ');
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000', zIndex: 10000,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 32,
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
    }}>
      <p style={{ color: '#fff', fontSize: 18, fontWeight: 600, margin: '0 0 8px', textAlign: 'center' }}>
        Viewing paused — screen recording detected
      </p>
      <p style={{ color: '#94A3B8', fontSize: 14, lineHeight: 1.5, textAlign: 'center', maxWidth: 480 }}>
        {list
          ? `Close ${list} to continue viewing this document.`
          : 'Close your screen-recording software to continue viewing this document.'}
        {' '}The sender has been notified.
      </p>
    </div>
  );
}
