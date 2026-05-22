import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';

declare const __API_BASE__: string;
declare const __APP_VERSION__: string;

// Per Unified Tracking Brief §3.1. Native-app telemetry helper — single
// place that handles event batching, retry, and endpoint targeting.
// Parallels lib/audit.ts in the mobile repo (same public API; differs
// only in fetch import, API base, and platform detection).
//
// Telemetry is fire-and-forget: a lost event is acceptable because these
// are observability data, not security controls. Three retries with
// linear backoff, then discard.

const ENDPOINT_PATH          = '/api/v1/audit/event';
const PAGE_BATCH_INTERVAL_MS = 30_000;

export type AccessMethod = 'link' | 'afs_local';

export type AuditEvent = {
  event_type:    'file_opened' | 'session_ended' | 'page_views_batch';
  file_id:       string;
  session_id?:   string;
  access_method: AccessMethod;
  payload?:      Record<string, unknown>;
};

// ─── Module state — viewing-session-scoped ─────────────────────────
// Reset on every startPageTracking call. A single helper instance can
// only track one session at a time (matches the SecureViewer lifecycle —
// closing one viewer to open another always triggers a stopPageTracking
// first).
//
// KNOWN LIMITATION: this state is module-scoped, which means
// simultaneous viewer windows would collide on the shared timer,
// pageQueue, batchSequence, and currentAccessToken globals. The desktop
// app currently only allows one viewer window at a time so this is not
// a live bug — but if Phase B introduces multi-window viewing this
// should be refactored to a session-scoped object (one PageBatcher
// instance per session, keyed by sessionId) so two windows can track
// independently. Tracked as a post-Phase-B follow-up.
let pageQueue: Array<{ page_number: number; viewed_at: string }> = [];
let batchSequence = 0;
let batchTimer: ReturnType<typeof setInterval> | null = null;
let currentAccessToken: string | null = null;

let cachedOsPlatform: string | null = null;
async function getOsPlatform(): Promise<string> {
  // Tauri's get_platform returns "macos" | "windows" | "unknown".
  // Production ships macOS + Windows; "unknown" only appears in dev.
  if (cachedOsPlatform === null) {
    try {
      cachedOsPlatform = await invoke<string>('get_platform');
    } catch {
      cachedOsPlatform = 'unknown';
    }
  }
  return cachedOsPlatform;
}

export function startPageTracking(sessionId: string, fileId: string, accessToken: string): void {
  pageQueue          = [];
  batchSequence      = 0;
  currentAccessToken = accessToken;
  batchTimer         = setInterval(
    () => { void flushPageBatch(sessionId, fileId); },
    PAGE_BATCH_INTERVAL_MS,
  );
}

export function recordPageView(pageNumber: number): void {
  pageQueue.push({ page_number: pageNumber, viewed_at: new Date().toISOString() });
}

export async function stopPageTracking(sessionId: string, fileId: string): Promise<void> {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }
  await flushPageBatch(sessionId, fileId);
  currentAccessToken = null;
}

async function flushPageBatch(sessionId: string, fileId: string): Promise<void> {
  if (pageQueue.length === 0) return;
  const pages = [...pageQueue];
  pageQueue   = [];
  batchSequence++;
  await sendEvent({
    event_type:    'page_views_batch',
    file_id:       fileId,
    session_id:    sessionId,
    access_method: 'afs_local',  // page_views_batch only fires for .afs sessions
    payload:       { pages, batch_sequence: batchSequence },
  });
}

export async function sendEvent(event: AuditEvent, accessToken?: string): Promise<void> {
  const token = accessToken ?? currentAccessToken;
  if (!token) return;  // no auth context → silent drop (telemetry is best-effort)

  const url      = `${__API_BASE__}${ENDPOINT_PATH}`;
  const platform = await getOsPlatform();
  const body     = JSON.stringify({
    ...event,
    client_timestamp: new Date().toISOString(),
    platform,
    app_version:      __APP_VERSION__,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-App-Platform':  'desktop',
          'X-App-Version':   __APP_VERSION__,
          'X-Access-Token':  token,
        },
        body,
      });
      if (res.ok) return;
      // 4xx = client mistake (validation, auth) — no point retrying
      if (res.status >= 400 && res.status < 500) return;
    } catch {
      // network error — fall through to backoff
    }
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}
