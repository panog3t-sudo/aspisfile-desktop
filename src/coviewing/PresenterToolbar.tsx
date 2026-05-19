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
}

export function PresenterToolbar({
  sessionId, channel: _channel, fileId: _fileId, token, mode, context, currentPage, pageCount, onPageChange, onStop,
}: PresenterToolbarProps) {
  const [participantCount, setParticipantCount] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch participant count periodically
  useEffect(() => {
    const fetch_ = () => {
      fetch(`${__API_BASE__}/api/v1/co-viewing/${sessionId}/participants`, {
        headers: { 'X-App-Platform': 'desktop', 'X-Access-Token': token },
      })
        .then(r => r.json())
        .then(d => setParticipantCount(d.joined ?? 0))
        .catch(() => {});
    };
    fetch_();
    const iv = setInterval(fetch_, 10_000);
    return () => clearInterval(iv);
  }, [sessionId]);

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

      {/* Page controls */}
      <button onClick={() => changePage(currentPage - 1)} disabled={currentPage <= 1} style={navBtnStyle(currentPage <= 1)}>‹</button>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' }}>
        {currentPage} / {pageCount}
      </span>
      <button onClick={() => changePage(currentPage + 1)} disabled={currentPage >= pageCount} style={navBtnStyle(currentPage >= pageCount)}>›</button>

      <div style={{ flex: 1 }} />

      {/* Participant count */}
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' }}>
        {participantCount > 0 ? `${participantCount} viewing` : 'Waiting…'}
      </span>

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
