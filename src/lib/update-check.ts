// Desktop viewer update check — "a newer version is available", download and
// reinstall. Deliberately NOT the Tauri auto-updater: that needs a signing
// keypair, per-platform update artifacts and careful ordering against
// notarisation, and it cannot consume the .pkg macOS actually ships. The
// plugin config in tauri.conf.json is inert (placeholder pubkey, nothing calls
// check()) and is left alone so the two mechanisms don't get confused.
//
// Cross-platform: macOS and Windows run identical logic; get_platform() only
// decides which installer URL the server hands back.
//
// Why this exists: v1.9.21 is in the field and can never learn about updates,
// because a version check has to be compiled INTO the client. Shipping this
// now means no future build is ever stranded the same way.

import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

declare const __API_BASE__: string;
declare const __APP_VERSION__: string;

const BASE = (typeof __API_BASE__ !== 'undefined' && __API_BASE__) || 'https://aspisfile.com';

export type UpdateInfo = {
  version: string;
  url: string;
  notes: string;
  /** True when the running build is below the server's min_supported floor. */
  blocking: boolean;
};

/**
 * Numeric-tuple semver compare. Returns >0 when a > b, <0 when a < b, 0 equal.
 * Pre-release suffixes are ignored (we only ship plain x.y.z), and any
 * unparseable segment counts as 0 so a malformed version can never be read as
 * "newer" and nag forever.
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Which installer to advertise. Falls back to the OS-detecting page. */
async function target(): Promise<string> {
  try {
    const p = await invoke<string>('get_platform');
    return p === 'macos' ? 'macos' : p === 'windows' ? 'windows' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Returns update info when the server advertises a NEWER version than this
 * build, else null. Never throws: a failed check must not block a recipient
 * from opening a file, so any error (offline, 500, garbage body) resolves to
 * null and the viewer proceeds exactly as before.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const t = await target();
    const res = await fetch(`${BASE}/api/releases/latest?target=${encodeURIComponent(t)}`);
    if (!res.ok) return null;
    const d = await res.json() as { version?: string; url?: string; notes?: string; min_supported?: string };
    if (!d?.version || !d?.url) return null;

    const current = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
    if (compareVersions(d.version, current) <= 0) return null;   // current or ahead (dev build)

    return {
      version: d.version,
      url: d.url,
      notes: d.notes || '',
      // Reserved: nothing acts on `blocking` yet, but computing it here means
      // enforcement later is a UI change, not another stranded-client problem.
      blocking: !!d.min_supported && compareVersions(d.min_supported, current) > 0,
    };
  } catch {
    return null;
  }
}

/** Open the installer in the user's browser (never in the viewer webview). */
export async function openDownload(url: string): Promise<void> {
  try { await openUrl(url); } catch { /* best-effort — the banner stays up */ }
}
