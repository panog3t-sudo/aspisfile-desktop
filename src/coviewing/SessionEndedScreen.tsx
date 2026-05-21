'use client';

import { useEffect, useState } from 'react';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface SessionEndedScreenProps {
  presenterName?: string;
  /** Triggered after the countdown (or immediately when the user clicks
   *  "Close now"). The parent SecureViewer wires this to its own file
   *  close handler — the file is cleared, viewer returns to launcher
   *  state. The Tauri window stays open. */
  onCloseFile: () => void;
}

const AUTO_CLOSE_SECONDS = 4;

// Shown briefly after the presenter ends a co-viewing session. Per the
// product decision (2026-05-21), the file hard-closes for every
// participant regardless of permanent / session-only access — no
// possibility of a lingering open file after the presenter is done.
// Permanent recipients can re-open the file via their email link or
// the recipient portal.
export function SessionEndedScreen({ presenterName, onCloseFile }: SessionEndedScreenProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_CLOSE_SECONDS);

  useEffect(() => {
    if (secondsLeft <= 0) {
      onCloseFile();
      return;
    }
    const id = window.setTimeout(() => setSecondsLeft(s => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [secondsLeft, onCloseFile]);

  return (
    <div style={{
      position:       'fixed',
      inset:          0,
      background:     '#0F172A',
      zIndex:         100,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      flexDirection:  'column',
      fontFamily:     FONT,
      gap:            12,
    }}>
      <div style={{
        width:           48,
        height:          48,
        borderRadius:    '50%',
        background:      'rgba(59,130,246,0.12)',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'center',
        marginBottom:    8,
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#93C5FD" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11l19-9-9 19-2-8-8-2z"/>
        </svg>
      </div>

      <p style={{ fontSize: 16, fontWeight: 500, color: '#FFFFFF', margin: 0 }}>
        Presentation ended
      </p>

      <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', margin: 0, textAlign: 'center', lineHeight: 1.6, maxWidth: 320, padding: '0 16px' }}>
        {presenterName ? `${presenterName} has ended the session.` : 'The presenter has ended the session.'}
        {' '}You can re-open this document from your email or the recipients page.
      </p>

      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', margin: '4px 0 0' }}>
        Closing in {secondsLeft}s…
      </p>

      <button
        onClick={onCloseFile}
        style={{
          marginTop:    4,
          padding:      '8px 20px',
          borderRadius: 6,
          background:   'rgba(59,130,246,0.15)',
          border:       '0.5px solid rgba(59,130,246,0.35)',
          color:        '#93C5FD',
          fontSize:     12,
          cursor:       'pointer',
          fontFamily:   FONT,
        }}
      >
        Close now
      </button>
    </div>
  );
}
