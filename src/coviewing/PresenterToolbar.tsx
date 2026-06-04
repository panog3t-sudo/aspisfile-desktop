'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetch } from '@tauri-apps/plugin-http';

declare const __API_BASE__: string;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

interface PresenterToolbarProps {
  sessionId:   string;
  channel:     string;
  fileId:      string;
  // Desktop owner-token — required for the four authenticated co-viewing
  // endpoints called from this toolbar (participants, heartbeat, page, end).
  token:       string;
  mode:        'synchronized' | 'free';
  context:     'standalone' | 'teams' | 'zoom';
  currentPage: number;
  pageCount:   number;
  onPageChange: (page: number) => void;
  onStop:      () => void;
  // Participant panel toggle — SecureViewer owns the panelOpen state so
  // it can also size the document area (panel pushes TileRenderer width)
  panelOpen:   boolean;
  onTogglePanel: () => void;
  // The sender email behind this presenter-token open. Surfaced as a
  // "Presenting as …" chip so the user can tell at a glance that the
  // viewer is running off an owner-token, not whichever recipient
  // happens to be enrolled on this Mac.
  presenterEmail?: string;
}

export function PresenterToolbar({
  sessionId, channel: _channel, fileId: _fileId, token, mode, context, currentPage, pageCount, onPageChange, onStop, panelOpen, onTogglePanel, presenterEmail,
}: PresenterToolbarProps) {
  const [stopping,     setStopping]     = useState(false);
  const [linkCopied,   setLinkCopied]   = useState(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Presenter heartbeat — keeps session alive if no page changes (free scroll mode)
  useEffect(() => {
    const beat = () => fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/heartbeat`, {
      method: 'POST',
      headers: { 'X-App-Platform': 'desktop', 'X-Access-Token': token },
    }).catch(() => {});
    beat();
    heartbeatRef.current = setInterval(beat, 30_000);
    return () => { if (heartbeatRef.current) clearInterval(heartbeatRef.current); };
  }, [sessionId]);

  const changePage = useCallback(async (page: number) => {
    if (page < 1 || page > pageCount) return;
    onPageChange(page);
    if (mode === 'synchronized') {
      await fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/page`, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-App-Platform': 'desktop',
          'X-Access-Token': token,
        },
        body:    JSON.stringify({ page }),
      }).catch(() => {});
    }
  }, [sessionId, mode, pageCount, onPageChange]);

  const copyLink = async () => {
    const url = `${__API_BASE__}/session/${sessionId}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const handleStop = async () => {
    setStopping(true);
    await fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/end`, {
      method: 'POST',
      headers: { 'X-App-Platform': 'desktop', 'X-Access-Token': token },
    }).catch(() => {});
    onStop();
  };

  const CONTEXT_LABEL: Record<string, string> = {
    standalone: 'Standalone',
    teams:      'Teams',
    zoom:       'Zoom',
  };

  return (
    <div style={{
      position:   'fixed',
      top:        0,
      left:       0,
      right:      0,
      height:     44,
      zIndex:     60,
      background: '#0F172A',
      borderBottom: '0.5px solid rgba(29,78,216,0.4)',
      display:    'flex',
      alignItems: 'center',
      padding:    '0 12px',
      gap:        10,
      fontFamily: FONT,
    }}>
      {/* Context + mode badge */}
      <span style={{ fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 10, background: '#1D4ED8', color: '#FFFFFF', flexShrink: 0 }}>
        {CONTEXT_LABEL[context]} · {mode === 'synchronized' ? 'Sync' : 'Free'}
      </span>

      {/* Presenter identity chip — shows the sender email behind the
          owner-token so it's obvious the open isn't using whatever
          recipient is enrolled on this Mac. */}
      {presenterEmail && (
        <span
          title={`Presenting as ${presenterEmail}`}
          style={{
            fontSize: 10,
            fontWeight: 500,
            padding: '2px 8px',
            borderRadius: 10,
            background: 'rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.85)',
            border: '0.5px solid rgba(255,255,255,0.15)',
            flexShrink: 0,
            maxWidth: 220,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          Presenting as {presenterEmail}
        </span>
      )}

      {/* Page controls */}
      <button onClick={() => changePage(currentPage - 1)} disabled={currentPage <= 1} style={navBtnStyle(currentPage <= 1)}>‹</button>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' }}>
        {currentPage} / {pageCount}
      </span>
      <button onClick={() => changePage(currentPage + 1)} disabled={currentPage >= pageCount} style={navBtnStyle(currentPage >= pageCount)}>›</button>

      <div style={{ flex: 1 }} />

      {/* Participant panel toggle — opens/closes the persistent RHS
          sidebar that lives outside this toolbar. The detailed roster
          (emails, pages, follow mode, timers) renders there. */}
      <button
        onClick={onTogglePanel}
        title={panelOpen ? 'Hide participant panel' : 'Show participant panel'}
        style={{
          fontSize:     11,
          padding:      '4px 10px',
          borderRadius: 5,
          background:   panelOpen ? 'rgba(59,130,246,0.18)' : 'transparent',
          border:       `0.5px solid ${panelOpen ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.15)'}`,
          color:        panelOpen ? '#93C5FD' : 'rgba(255,255,255,0.7)',
          cursor:       'pointer',
          fontFamily:   FONT,
          whiteSpace:   'nowrap',
          flexShrink:   0,
          display:      'flex',
          alignItems:   'center',
          gap:          6,
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="7" r="3"/><path d="M3 21v-1a6 6 0 0 1 12 0v1"/><circle cx="17" cy="7" r="3"/><path d="M21 21v-1a6 6 0 0 0-3-5.2"/>
        </svg>
        Participants {panelOpen ? '▸' : '◂'}
      </button>

      {/* Copy link */}
      <button
        onClick={copyLink}
        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, background: 'rgba(255,255,255,0.08)', border: '0.5px solid rgba(255,255,255,0.15)', color: linkCopied ? '#86EFAC' : 'rgba(255,255,255,0.7)', cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}
      >
        {linkCopied ? 'Copied!' : 'Copy link'}
      </button>

      {/* Stop */}
      <button
        onClick={handleStop}
        disabled={stopping}
        style={{ fontSize: 11, fontWeight: 500, padding: '4px 12px', borderRadius: 5, background: stopping ? 'rgba(163,45,45,0.3)' : '#A32D2D', border: 'none', color: '#FFFFFF', cursor: stopping ? 'wait' : 'pointer', fontFamily: FONT, flexShrink: 0 }}
      >
        {stopping ? 'Ending…' : 'Stop presenting'}
      </button>
    </div>
  );
}

function navBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 24, height: 24, borderRadius: 4,
    background: disabled ? 'transparent' : 'rgba(255,255,255,0.08)',
    border: '0.5px solid rgba(255,255,255,0.15)',
    color: disabled ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)',
    fontSize: 16, cursor: disabled ? 'default' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, fontFamily: FONT,
  };
}
