import { fetch } from '@tauri-apps/plugin-http';
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
// /tile renders from memory, not durable S3). Toggle for dev/testing
// WITHOUT a rebuild:
//   localStorage.setItem('aspisfile_afs_render','1'); location.reload()
// Default OFF → the viewer streams tiles from durable S3 exactly as today,
// so this cannot affect shipping behaviour until the B6 cutover flips it on.
export function isAfsRenderEnabled(): boolean {
  try { return localStorage.getItem('aspisfile_afs_render') === '1'; }
  catch { return false; }
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

// Fetch the recipient's .afs (B3) then re-supply it (B4 inline / P2 presigned)
// so the server primes the render cache. Returns ok on success; on failure
// the caller falls back to the durable-S3 tile path (still works in the
// transition), so a prime failure never blocks viewing.
export async function primeAfsRender(opts: {
  fileId: string; sessionId: string; fingerprint: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { fileId, sessionId, fingerprint } = opts;
  const h = authHeaders(fingerprint);

  // 1. Fetch the .afs. In the transition the server builds it from the
  //    durable ciphertext + parks a ≤24h relay copy.
  let afs: Uint8Array;
  try {
    const res = await fetch(`${BASE}/api/v1/viewer/${fileId}/afs?session=${sessionId}`, { headers: h });
    if (!res.ok) return { ok: false, error: `afs ${res.status}` };
    afs = new Uint8Array(await res.arrayBuffer());
  } catch (e: any) {
    return { ok: false, error: `afs fetch: ${e?.message ?? e}` };
  }
  if (afs.length === 0) return { ok: false, error: 'empty afs' };

  // 2. Re-supply so the server renders transiently from it.
  try {
    if (afs.length <= MAX_INLINE) {
      const res = await fetch(`${BASE}/api/v1/viewer/${fileId}/supply?session=${sessionId}`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/octet-stream' },
        body: afs,
      });
      if (!res.ok) return { ok: false, error: `supply ${res.status}` };
    } else {
      const pres = await fetch(`${BASE}/api/v1/viewer/${fileId}/supply/presign?session=${sessionId}`, {
        method: 'POST', headers: h,
      });
      if (!pres.ok) return { ok: false, error: `presign ${pres.status}` };
      const { uploadUrl } = (await pres.json()) as { uploadUrl: string };
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'x-amz-server-side-encryption': 'AES256' },
        body: afs,
      });
      if (!put.ok) return { ok: false, error: `relay PUT ${put.status}` };
      const fin = await fetch(`${BASE}/api/v1/viewer/${fileId}/supply?session=${sessionId}`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromRelay: true }),
      });
      if (!fin.ok) return { ok: false, error: `supply(relay) ${fin.status}` };
    }
  } catch (e: any) {
    return { ok: false, error: `re-supply: ${e?.message ?? e}` };
  }

  return { ok: true };
}
