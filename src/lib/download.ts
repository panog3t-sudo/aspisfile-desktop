import { fetch } from '@tauri-apps/plugin-http';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

declare const __API_BASE__: string;

// Sprint 2 — Download Management Brief §1.2 viewer-side state machine.
// Orchestrates the three-call sequence:
//   1) POST /api/v1/files/[id]/download           → signed S3 URL
//   2) fetch URL + dialog.save + fs.writeFile     → bytes hit disk
//   3) POST /api/v1/files/[id]/download-confirmed → audit + grace-period timer
//
// Confirmation in step 3 fires AUTOMATICALLY on successful write. The
// "File has been saved" modal that follows is a passive UI notification;
// dismissing it does not trigger a network call.
//
// All 4xx responses surface as typed errors so the caller can branch on
// the error_code field to render the correct UX (BLOB_DELETED screen,
// generic banner, in-progress state sync, etc.).

export type DownloadErrorCode =
  | 'NATIVE_APP_REQUIRED'           // can't happen — we ARE the native app
  | 'INVALID_TOKEN'                 // re-auth required
  | 'FILE_NOT_AVAILABLE'            // file revoked / destroyed / unknown
  | 'BLOB_DELETED'                  // S3 cleanup already ran — dedicated screen
  | 'DOWNLOAD_DISABLED'             // file-level
  | 'DOWNLOAD_DISABLED_FOR_RECIPIENT'
  | 'RECIPIENT_REVOKED'
  | 'ALREADY_DOWNLOADED'            // race: someone else confirmed first
  | 'DOWNLOAD_IN_PROGRESS'          // race: in-progress lock held
  | 'USER_CANCELLED'                // dialog.save returned null
  | 'WRITE_FAILED'                  // local file write failed
  | 'NETWORK_FAILED'                // signed-URL fetch failed
  | 'CONFIRM_FAILED'                // /download-confirmed POST failed
  | 'FORBIDDEN'                     // confirm endpoint 403
  | 'UNKNOWN';

export class DownloadError extends Error {
  constructor(public code: DownloadErrorCode, message: string) {
    super(message);
  }
}

type InitiateResponse = {
  download_url:    string;
  file_name:       string;
  expires_in_secs: number;
};

export async function runDownload(fileId: string, accessToken: string): Promise<void> {
  // Step 1: ask server for a signed S3 URL.
  const initRes = await fetch(`${__API_BASE__}/api/v1/files/${fileId}/download`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-App-Platform':  'desktop',
      'X-Access-Token':  accessToken,
    },
  });

  if (!initRes.ok) {
    const body = await initRes.json().catch(() => ({}));
    throw new DownloadError(
      (body.error as DownloadErrorCode) ?? 'UNKNOWN',
      `Download initiation failed (${initRes.status})`,
    );
  }

  const init = (await initRes.json()) as InitiateResponse;

  // Step 2a: fetch the encrypted .afs bytes from S3.
  let bytes: Uint8Array;
  try {
    const blobRes = await fetch(init.download_url);
    if (!blobRes.ok) throw new Error(`S3 fetch ${blobRes.status}`);
    const buf = await blobRes.arrayBuffer();
    bytes = new Uint8Array(buf);
  } catch (e) {
    throw new DownloadError('NETWORK_FAILED', `S3 fetch failed: ${(e as Error).message}`);
  }

  // Step 2b: save dialog. Default to Downloads (matches fs scope). Capability
  // allowlist `fs:scope-download-recursive` keeps writes inside ~/Downloads/**.
  const path = await save({
    defaultPath: init.file_name,
    filters: [{ name: 'AspisFile', extensions: ['afs'] }],
  });
  if (!path) throw new DownloadError('USER_CANCELLED', 'Save cancelled');

  // Step 2c: write bytes to disk. A path outside the scoped allowlist will
  // surface a permission error here — translated to WRITE_FAILED.
  try {
    await writeFile(path, bytes);
  } catch (e) {
    throw new DownloadError('WRITE_FAILED', `Write failed: ${(e as Error).message}`);
  }

  // Step 3: confirm. Audit + grace-period timer + notification all fire here.
  const confirmRes = await fetch(`${__API_BASE__}/api/v1/files/${fileId}/download-confirmed`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-App-Platform':  'desktop',
      'X-Access-Token':  accessToken,
    },
  });
  if (!confirmRes.ok) {
    const body = await confirmRes.json().catch(() => ({}));
    throw new DownloadError(
      (body.error as DownloadErrorCode) ?? 'CONFIRM_FAILED',
      `Confirm failed (${confirmRes.status})`,
    );
  }
}
