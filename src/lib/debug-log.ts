// Tiny pub-sub log buffer for the in-app debug overlay.
// Used to trace bugs on user machines without devtools or unified-log
// access (WKWebView's console.log doesn't reach `log show` in Tauri).
//
// Usage:
//   import { debugLog } from '@/lib/debug-log';
//   debugLog('co-view', 'openLink', { token, coview });
//
// DebugOverlay renders the most recent lines floating at the bottom
// of the screen. Toggle via window.__aspisDebug = true (default true
// in v1.8.11+ until the co-view bug is resolved).

type LogLine = { ts: string; tag: string; msg: string; data?: unknown };

const buffer: LogLine[] = [];
const listeners = new Set<(lines: LogLine[]) => void>();
const MAX_LINES = 60;

export function debugLog(tag: string, msg: string, data?: unknown): void {
  const line: LogLine = {
    ts: new Date().toISOString().slice(11, 19),
    tag,
    msg,
    data,
  };
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.shift();
  for (const fn of listeners) {
    try { fn([...buffer]); } catch { /* listener exception is not our problem */ }
  }
  // Best-effort console too, in case anyone's reading via the inspector.
  try { console.log(`[${tag}]`, msg, data ?? ''); } catch {}
}

export function subscribeDebugLog(fn: (lines: LogLine[]) => void): () => void {
  listeners.add(fn);
  fn([...buffer]);
  return () => { listeners.delete(fn); };
}

export function clearDebugLog(): void {
  buffer.length = 0;
  for (const fn of listeners) {
    try { fn([]); } catch {}
  }
}

export type { LogLine };
