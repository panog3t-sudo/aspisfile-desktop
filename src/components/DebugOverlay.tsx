import { useEffect, useState } from 'react';
import { subscribeDebugLog, clearDebugLog, type LogLine } from '../lib/debug-log';

// Floating debug log panel. Always rendered while we trace the
// co-view IdleScreen bug. Bottom-right, semi-transparent so it
// doesn't fully cover the underlying UI but is always readable.
// Andrew can screenshot it when he hits the bug.
export function DebugOverlay() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => subscribeDebugLog(setLines), []);

  const containerStyle: React.CSSProperties = {
    position:      'fixed',
    bottom:        12,
    right:         12,
    width:         collapsed ? 90 : 460,
    maxHeight:     collapsed ? 30 : 320,
    overflow:      'auto',
    background:    'rgba(15,23,42,0.92)',
    color:         '#E2E8F0',
    border:        '0.5px solid rgba(96,165,250,0.5)',
    borderRadius:  6,
    padding:       collapsed ? '4px 8px' : 8,
    fontSize:      10,
    fontFamily:    'Menlo, Monaco, monospace',
    lineHeight:    1.45,
    zIndex:        9999,
    boxShadow:     '0 4px 16px rgba(0,0,0,0.5)',
  };

  if (collapsed) {
    return (
      <div style={containerStyle} onClick={() => setCollapsed(false)} title="Show debug log">
        debug ({lines.length})
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 6 }}>
        <span style={{ fontWeight: 600, color: '#93C5FD' }}>debug-log</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => clearDebugLog()}
            style={btnStyle}
          >clear</button>
          <button
            onClick={() => setCollapsed(true)}
            style={btnStyle}
          >hide</button>
        </div>
      </div>
      {lines.length === 0 ? (
        <div style={{ color: '#64748B' }}>no events yet</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} style={{ marginBottom: 2 }}>
            <span style={{ color: '#64748B' }}>{line.ts}</span>{' '}
            <span style={{ color: '#FBBF24' }}>[{line.tag}]</span>{' '}
            <span>{line.msg}</span>
            {line.data !== undefined && (
              <span style={{ color: '#94A3B8' }}> {JSON.stringify(line.data)}</span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  fontSize:     9,
  padding:      '1px 6px',
  borderRadius: 3,
  background:   'rgba(255,255,255,0.08)',
  border:       '0.5px solid rgba(255,255,255,0.15)',
  color:        '#E2E8F0',
  cursor:       'pointer',
  fontFamily:   'inherit',
};
