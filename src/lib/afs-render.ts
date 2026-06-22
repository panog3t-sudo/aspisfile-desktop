import { fetch } from '@tauri-apps/plugin-http';
import { writeFile, readFile, exists, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs';
import { sessionStore } from './sessionStore';

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== 'undefined' && __API_BASE__) || 'https://aspisfile.com';

// Matches the server's MAX_SUPPLY_BYTES — below this we re-supply inline,
// above it we go via the presigned relay slot (P2) to dodge the ~4.5MB
// Vercel function-body cap.
const MAX_INLINE = 4 * 1024 * 1024;

// Phase B (B5) — flagged + additive. When enabled, the viewer exercises the
// relay/.afs render path: fetch the recipient's .afs, then re-supply it so
// the server renders transiently from it (primes the per-session cache →
// /tile renders from memory, not durable S3).
//
// Phase B B6 Part 1 (2026-06-21): .afs render is now the DEFAULT. The flag is
// a reversible KILL SWITCH — only an explicit '0' disables it (reverts to the
// durable-S3 tile path, which still exists as the /tile fallback). Durable is
// NOT yet retired (that's B6 Part 3, held until B7 re-share exists), so a
// kill-switch flip is fully safe.
//   Revert one device:  localStorage.setItem('aspisfile_afs_render','0'); location.reload()
export function isAfsRenderEnabled(): boolean {
  try { return localStorage.getItem('aspisfile_afs_render') !== '0'; }
  catch { return true; }
}

// Flip the flag (persists in localStorage) and return the new state.
// Release builds ship with NO devtools, so the flag can't be set from a
// console — App wires this to a keyboard combo (Cmd/Ctrl+Shift+A) so it's
// toggleable for testing on a signed build.
export function toggleAfsRender(): boolean {
  const next = !isAfsRenderEnabled();
  try { localStorage.setItem('aspisfile_afs_render', next ? '1' : '0'); } catch { /* ignore */ }
  return next;
}

// Same auth surface the tile requests use, so /afs + /supply pass
// validateTileRequest (Bearer session key + device fingerprint + share).
function authHeaders(fingerprint: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${sessionStore.getKey() ?? ''}`,
    'X-App-Platform': 'desktop',
    'X-Device-Fingerprint': fingerprint,
  };
  const ds = sessionStore.getDeviceShare();
  if (ds) h['X-Device-Share'] = ds;
  return h;
}

// ── Local .afs store (B5 step 2) ──
// The recipient HOLDS their .afs. We cache it in the app-data dir so reopens
// re-supply from disk (no server fetch) and — post-B6-cutover, when the
// server keeps no durable copy — it's the only source. Ciphertext only:
// inert without the server's key shares + a live session, so this respects
// no-plaintext-at-rest and no-offline-viewing. Best-effort — fs failures
// fall back to fetching from /afs, so persistence can never block viewing.
const AFS_DIR = 'afs';
const afsFile = (fileId: string) => `${AFS_DIR}/${fileId}.afs`;

async function loadStoredAfs(fileId: string): Promise<Uint8Array | null> {
  try {
    if (!(await exists(afsFile(fileId), { baseDir: BaseDirectory.AppData }))) return null;
    const bytes = await readFile(afsFile(fileId), { baseDir: BaseDirectory.AppData });
    return bytes.length > 0 ? bytes : null;
  } catch { return null; }
}

// Returns true ONLY if the .afs is actually persisted — the caller gates
// confirm-hold on this so a failed write never triggers an early server-side
// source purge that would strand us.
async function storeAfs(fileId: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await mkdir(AFS_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
    await writeFile(afsFile(fileId), bytes, { baseDir: BaseDirectory.AppData });
    return true;
  } catch { return false; /* best-effort cache — non-fatal */ }
}

// Fetch the .afs from the server (B3). In the transition the server builds
// it from durable ciphertext + parks a ≤window relay copy.
// Discriminated result so primeAfsRender can tell a benign-but-recoverable
// "the window elapsed" (410 SOURCE_EXPIRED → guided multi-device message)
// apart from a generic failure.
type FetchAfsResult =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'expired' }
  | { kind: 'failed' };
async function fetchAfs(fileId: string, sessionId: string, h: Record<string, string>): Promise<FetchAfsResult> {
  try {
    const res = await fetch(`${BASE}/api/v1/viewer/${fileId}/afs?session=${sessionId}`, { headers: h });
    if (res.status === 410) return { kind: 'expired' };
    if (!res.ok) return { kind: 'failed' };
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > 0 ? { kind: 'ok', bytes } : { kind: 'failed' };
  } catch { return { kind: 'failed' }; }
}

// Re-supply the .afs so the server renders transiently from it (B4 inline /
// P2 presigned relay for >4MB). Returns ok on success.
async function resupply(
  fileId: string, sessionId: string, h: Record<string, string>, afs: Uint8Array,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (afs.length <= MAX_INLINE) {
      const res = await fetch(`${BASE}/api/v1/viewer/${fileId}/supply?session=${sessionId}`, {
        method: 'POST', headers: { ...h, 'Content-Type': 'application/octet-stream' }, body: afs,
      });
      return res.ok ? { ok: true } : { ok: false, error: `supply ${res.status}` };
    }
    const pres = await fetch(`${BASE}/api/v1/viewer/${fileId}/supply/presign?session=${sessionId}`, {
      method: 'POST', headers: h,
    });
    if (!pres.ok) return { ok: false, error: `presign ${pres.status}` };
    const { uploadUrl } = (await pres.json()) as { uploadUrl: string };
    const put = await fetch(uploadUrl, {
      method: 'PUT', headers: { 'x-amz-server-side-encryption': 'AES256' }, body: afs,
    });
    if (!put.ok) return { ok: false, error: `relay PUT ${put.status}` };
    const fin = await fetch(`${BASE}/api/v1/viewer/${fileId}/supply?session=${sessionId}`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ fromRelay: true }),
    });
    return fin.ok ? { ok: true } : { ok: false, error: `supply(relay) ${fin.status}` };
  } catch (e: any) {
    return { ok: false, error: `re-supply: ${e?.message ?? e}` };
  }
}

// Prime the server-transient render. Prefer the locally-held .afs (no server
// fetch); if it's stale (token rotated / revoked → re-supply rejected) we
// re-fetch, re-store, and retry once. On any failure the caller falls back to
// the durable-S3 tile path, so this never blocks viewing.
export async function primeAfsRender(opts: {
  fileId: string; sessionId: string; fingerprint: string;
}): Promise<{ ok: true; source: 'stored' | 'fetched' } | { ok: false; error: string; reason?: 'source_expired' }> {
  const { fileId, sessionId, fingerprint } = opts;
  const h = authHeaders(fingerprint);

  // 1. Try the held copy first (fast reopen; the only source post-cutover).
  const stored = await loadStoredAfs(fileId);
  if (stored) {
    const r = await resupply(fileId, sessionId, h, stored);
    if (r.ok) return { ok: true, source: 'stored' };
    // stale/rejected → fall through to a fresh fetch.
  }

  // 2. Fetch fresh, persist, re-supply.
  const fresh = await fetchAfs(fileId, sessionId, h);
  if (fresh.kind === 'expired') {
    // B+ — no local copy AND the server window elapsed (post-cutover, no
    // durable). Surface a distinct reason so the viewer shows the guided
    // "open on your other device / ask the sender to re-send" message.
    return { ok: false, reason: 'source_expired', error: 'source expired' };
  }
  if (fresh.kind !== 'ok') return { ok: false, error: 'afs fetch failed' };
  const held = await storeAfs(fileId, fresh.bytes);
  // W3: if we actually hold the .afs locally, confirm hold so the server can
  // purge our relay slot early. (B+: the shared source is NOT purged early — it
  // lives the window so a second device can re-fetch.) Gated on a successful
  // store so a failed write never triggers a purge. Fire-and-forget.
  if (held) confirmHold(fileId, sessionId, h);
  const r2 = await resupply(fileId, sessionId, h, fresh.bytes);
  return r2.ok ? { ok: true, source: 'fetched' } : { ok: false, error: r2.error ?? 're-supply failed' };
}

// ── B+ multi-device helpers (memory `multidevice-recipient-decision`) ──

export type HeldStatus = {
  held_by_recipient: boolean;
  device_count: number;
  is_synced: boolean;
  devices: { label: string; sync_status: string }[];
};

// Device context for the exit-save prompt + guided purged-link message.
// Session-gated server-side (no device labels without a live session). Null on
// any failure → the viewer degrades to a generic message / no prompt.
export async function getHeldStatus(fileId: string, sessionId: string, fingerprint: string): Promise<HeldStatus | null> {
  try {
    const res = await fetch(`${BASE}/api/v1/viewer/${fileId}/afs/held-status?session=${sessionId}`, {
      headers: authHeaders(fingerprint),
    });
    if (!res.ok) return null;
    return (await res.json()) as HeldStatus;
  } catch { return null; }
}

// Whether a held .afs exists locally to export (drives the "Send to another
// device" affordance + the exit-save prompt — only offer if we hold a copy).
export async function hasStoredAfs(fileId: string): Promise<boolean> {
  return (await loadStoredAfs(fileId)) !== null;
}

// Export the held .afs via a Save dialog so the recipient can move it to
// another of THEIR enrolled devices (AirDrop / Files / drive). The .afs is
// inert ciphertext — useless without enrollment + the server + a non-revoked
// token — so saving/sharing it is safe. Returns false if there's no held copy
// or the user cancels.
export async function exportAfs(fileId: string, suggestedName?: string): Promise<boolean> {
  try {
    const bytes = await loadStoredAfs(fileId);
    if (!bytes) return false;
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const base = (suggestedName ?? fileId).replace(/\.afs$/i, '').replace(/[^\w.\- ]+/g, '_');
    const path = await save({
      title: 'Send to another device',
      defaultPath: `${base}.afs`,
      filters: [{ name: 'AspisFile Viewer Document', extensions: ['afs'] }],
    });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  } catch { return false; }
}

// W3 — tell the server we've cached the .afs locally (confirmed hold). Best-
// effort; never blocks viewing. Drives early relay purge (slot + all-held source).
function confirmHold(fileId: string, sessionId: string, h: Record<string, string>): void {
  fetch(`${BASE}/api/v1/viewer/${fileId}/afs/confirm-hold?session=${sessionId}`, { method: 'POST', headers: h })
    .catch(() => { /* best-effort; 7-day lifecycle is the backstop */ });
}
