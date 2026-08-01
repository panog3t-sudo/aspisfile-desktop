/**
 * Friendly translations for server-side access + auth error codes.
 * Mirror of /aspisfile-mobile/lib/access-errors.ts — keep in sync.
 *
 * Server returns shapes like `{ error: 'RECIPIENT_MISMATCH' }` from
 * /api/v1/access/[token]/start and /mobile/access. The viewer used to
 * pass body.error through verbatim, leaving the user with cryptic
 * codes. This module centralises code → sentence mapping so every
 * access path renders the same friendly text.
 */

export type FriendlyAccessError = {
  title: string;
  body:  string;
  code:  string;
};

const MAP: Record<string, { title: string; body: string }> = {
  // Token / link state
  'NO_TOKEN':                       { title: 'Link incomplete',     body: "This link is incomplete. Open the share link directly from your email — don't retype it." },
  'Invalid link':                   { title: "We can't find this share", body: 'The link may have been deleted by the sender. Ask them to resend it.' },
  'Link expired':                   { title: 'Link expired',        body: 'This link has expired. Ask the sender to resend.' },
  'link_already_used':              { title: 'Link already used',   body: 'This single-use link has already been opened. Ask the sender for a fresh one.' },
  'Already viewed':                 { title: 'Already viewed',      body: 'This file was set to view once and has already been opened.' },
  'File unavailable':               { title: 'File unavailable',    body: 'This file is no longer available.' },
  'Access revoked':                 { title: 'Access revoked',      body: 'The sender revoked your access to this file.' },

  // Wrong recipient
  'RECIPIENT_MISMATCH':             { title: 'Different email',     body: 'This file was shared with a different email address. Sign in with the email the sender used (check the original email).' },
  // This device's own enrolment is stale (passkey revoked/removed) — the viewer
  // self-heals by clearing + re-enrolling, so this fallback text only shows on
  // builds that don't yet self-heal.
  'ENROLMENT_INVALID':              { title: 'Set up again',        body: 'Your access on this device needs to be set up again. Reopen the file to continue.' },

  // Auth / binding
  'BINDING_REQUIRED':               { title: 'Session timed out',   body: 'Your secure session timed out. Reopen the file from your email to sign in again.' },
  'INVALID_SESSION_TOKEN':          { title: 'Session expired',     body: 'Your session expired. Reopen the file from your email to sign in again.' },
  'Not authenticated':              { title: 'Sign in needed',      body: 'Open the file from your email to sign in and view it.' },
  'Forbidden':                      { title: 'This is your file',   body: 'You sent this file. Manage it from the AspisFile website.' },

  // Approval / coherence
  'coherence_blocked':              { title: "Couldn't verify this attempt", body: "We couldn't confirm this was you. Reopen the file from your email; if it keeps happening, contact the sender." },
  'APP_REQUIRED':                   { title: 'Open in the app',     body: 'This file can only be opened in the AspisFile viewer app, not a browser.' },
  'already_open':                   { title: 'Open in another viewer', body: 'This file is open in another viewer. Close it on your other device first, then try again.' },
  'ALREADY_OPEN':                   { title: 'Open in another viewer', body: 'This file is open in another viewer. Close it on your other device first, then try again.' },

  // Integrity / internal
  'FILE_INTEGRITY_CHECK_FAILED':    { title: 'File withdrawn',      body: 'This file failed an integrity check and was withdrawn. Ask the sender to upload it again.' },
  'INTEGRITY_VERIFICATION_FAILED':  { title: 'Verification problem', body: "We couldn't verify this file. Reopen the link in a moment; if it persists, ask the sender to re-upload." },
  'INVALID_FINGERPRINT':            { title: 'Device changed',      body: 'This device looks different from when you enrolled. Reopen the file from your email to refresh access.' },

  // Client-side conditions surfaced by the desktop viewer fetch wrapper.
  'TIMEOUT':                        { title: 'Taking too long',     body: 'The server didn\'t respond in time. Check your connection and try opening the file again.' },
};

export function translateAccessError(raw: unknown): FriendlyAccessError {
  const code = typeof raw === 'string' ? raw : String((raw as any)?.message ?? raw ?? '');
  const hit  = MAP[code];
  if (hit) return { ...hit, code };
  return {
    title: "Can't open this file",
    body:  'Something went wrong opening this file. Please try again, or contact the sender.',
    code,
  };
}
