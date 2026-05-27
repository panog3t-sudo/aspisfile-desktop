/**
 * src/lib/recipient-session.ts — desktop counterpart to the mobile
 * lib/recipient-session.ts. Stores the Phase A+ passkey-bound session
 * token so the desktop viewer can present it as Bearer on subsequent
 * /mobile/access calls.
 *
 * Storage: localStorage in the Tauri WebView. The session_token has
 * an 8-hour TTL and is rotated on every authenticate-verify call, so
 * the blast radius is bounded. File decryption material (session_key
 * from /access/[token]/start) is NEVER stored here — that remains
 * JavaScript memory only per invariant 2 of the master brief.
 *
 * If we need stronger at-rest protection later, swap to
 * tauri-plugin-keychain (macOS Keychain / Windows Credential Manager)
 * — the public API of this module stays unchanged.
 */

const KEY_EMAIL          = 'aspisfile_recipient_email';
const KEY_SESSION_TOKEN  = 'aspisfile_recipient_session_token';
const KEY_SESSION_EXP    = 'aspisfile_recipient_session_exp';
const KEY_PASSKEY_ID     = 'aspisfile_recipient_passkey_id';

export type RecipientSession = {
  email:      string;
  token:      string;
  passkeyId:  string;
  expiresAt:  number;            // seconds since epoch
};

export function saveRecipientSession(params: {
  email:     string;
  token:     string;
  passkeyId: string;
  expiresIn: number;
}): void {
  const expiresAt = Math.floor(Date.now() / 1000) + params.expiresIn;
  localStorage.setItem(KEY_EMAIL,         params.email.toLowerCase());
  localStorage.setItem(KEY_SESSION_TOKEN, params.token);
  localStorage.setItem(KEY_PASSKEY_ID,    params.passkeyId);
  localStorage.setItem(KEY_SESSION_EXP,   String(expiresAt));
}

export function getRecipientSession(): RecipientSession | null {
  const email     = localStorage.getItem(KEY_EMAIL);
  const token     = localStorage.getItem(KEY_SESSION_TOKEN);
  const passkeyId = localStorage.getItem(KEY_PASSKEY_ID);
  const expStr    = localStorage.getItem(KEY_SESSION_EXP);
  if (!email || !token || !passkeyId || !expStr) return null;
  const expiresAt = parseInt(expStr, 10);
  if (Number.isNaN(expiresAt)) return null;
  return { email, token, passkeyId, expiresAt };
}

export function getActiveSessionToken(): string | null {
  const session = getRecipientSession();
  if (!session) return null;
  if (session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return session.token;
}

export function clearSessionTokenOnly(): void {
  localStorage.removeItem(KEY_SESSION_TOKEN);
  localStorage.removeItem(KEY_SESSION_EXP);
}

export function clearAllRecipientState(): void {
  localStorage.removeItem(KEY_EMAIL);
  localStorage.removeItem(KEY_SESSION_TOKEN);
  localStorage.removeItem(KEY_PASSKEY_ID);
  localStorage.removeItem(KEY_SESSION_EXP);
}
