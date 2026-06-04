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
  'Invalid link':                   { title: "We can't find this share", body: 'The link may have been deleted by the sender.' },
  'Link expired':                   { title: 'Link expired',        body: 'This link has expired. Ask the sender to resend.' },
  'link_already_used':              { title: 'Link already used',   body: 'This single-use link has already been opened. Ask the sender for a fresh one.' },
  'Already viewed':                 { title: 'Already viewed',      body: 'This file was set to view once and has already been opened.' },
  'File unavailable':               { title: 'File unavailable',    body: 'This file is no longer available.' },
  'Access revoked':                 { title: 'Access revoked',      body: 'The sender revoked your access to this file.' },

  // Wrong recipient
  'RECIPIENT_MISMATCH':             { title: 'Different email',     body: 'This file was shared with a different email address. Sign in with the email the sender used (check the original email).' },

  // Auth / binding
  'BINDING_REQUIRED':               { title: 'Session timed out',   body: 'Sign in again with Touch ID to continue.' },
  'INVALID_SESSION_TOKEN':          { title: 'Session expired',     body: 'Your session is no longer valid. Sign in again.' },
  'Not authenticated':              { title: 'Sign in needed',      body: 'Sign in to AspisFile to open this file.' },
  'Forbidden':                      { title: 'This is your file',   body: "You're signed in as the sender of this file. Use the dashboard to manage it." },

  // Approval / coherence
  'coherence_blocked':              { title: "Couldn't verify this attempt", body: 'Something looked unusual about this access attempt. Please try again from your usual device and location.' },
  'APP_REQUIRED':                   { title: 'Open in the app',     body: 'This file can only be opened in the AspisFile viewer app, not a browser.' },
  'already_open':                   { title: 'Already open',        body: 'This file is already open in another window. Close it before opening here.' },

  // Integrity / internal
  'FILE_INTEGRITY_CHECK_FAILED':    { title: 'File withdrawn',      body: 'This file failed an integrity check and was withdrawn. Ask the sender to upload it again.' },
  'INTEGRITY_VERIFICATION_FAILED':  { title: 'Verification problem', body: "We couldn't verify this file. Please try again in a moment." },
  'INVALID_FINGERPRINT':            { title: 'Device changed',      body: 'This device looks different from when you enrolled. Sign in again to refresh.' },
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
