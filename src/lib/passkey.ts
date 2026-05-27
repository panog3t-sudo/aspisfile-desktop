/**
 * src/lib/passkey.ts — Tauri / WebView WebAuthn wrapper.
 *
 * The desktop viewer runs inside Tauri's WKWebView (macOS) / WebView2
 * (Windows). Both expose the standard navigator.credentials WebAuthn
 * API and prompt the platform's native authenticator (Touch ID on
 * macOS, Windows Hello on Windows) when the relying-party domain is
 * properly authorised.
 *
 * Server-side authorisation comes from:
 *   - apple-app-site-association webcredentials section (macOS)
 *   - assetlinks.json (Windows is permissive — relies on rpID matching)
 *
 * Two ceremonies mirror the mobile flow:
 *
 *   registerPasskey       — bootstrap after redeeming an enrollment code
 *   authenticatePasskey   — sign in on every file open / token expiry
 *
 * Same server endpoints as mobile (/api/v1/recipient-passkeys/*).
 * The credential ID + signed assertion bytes are equivalent shape
 * either way, so the server doesn't care which client created them.
 */

import {
  startRegistration,
  startAuthentication,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { saveRecipientSession } from './recipient-session';

declare const __API_BASE__: string;

const BASE = (typeof __API_BASE__ !== 'undefined' && __API_BASE__) || 'https://aspisfile.com';

export type PasskeyErrorKind =
  | 'unsupported'
  | 'cancelled'
  | 'server_rejected'
  | 'network'
  | 'unknown';

export class PasskeyError extends Error {
  constructor(public kind: PasskeyErrorKind, message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

function normaliseWebAuthnError(err: any): PasskeyError {
  const name = String(err?.name ?? '');
  const msg  = String(err?.message ?? err ?? 'Unknown error');
  if (name === 'NotAllowedError' || /cancel/i.test(msg)) {
    return new PasskeyError('cancelled', 'Authentication cancelled.');
  }
  if (name === 'NotSupportedError' || /not supported/i.test(msg)) {
    return new PasskeyError('unsupported', 'This device cannot create passkeys.');
  }
  if (name === 'SecurityError') {
    return new PasskeyError('server_rejected', 'The relying party did not match.');
  }
  return new PasskeyError('unknown', msg);
}

// ── Registration ──────────────────────────────────────

export async function registerPasskey(params: {
  email:             string;
  registrationToken: string;
  deviceLabel:       string;
}): Promise<{ passkeyId: string }> {
  // 1. Options
  let optionsRes: Response;
  try {
    optionsRes = await fetch(`${BASE}/api/v1/recipient-passkeys/register-options`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${params.registrationToken}`,
      },
      body: '{}',
    });
  } catch (err: any) {
    throw new PasskeyError('network', err?.message ?? 'Network error');
  }
  if (!optionsRes.ok) {
    throw new PasskeyError('server_rejected', `register-options ${optionsRes.status}`);
  }
  const options: PublicKeyCredentialCreationOptionsJSON = await optionsRes.json();

  // 2. WebView WebAuthn — Touch ID / Windows Hello prompt
  let credential;
  try {
    credential = await startRegistration({ optionsJSON: options });
  } catch (err: any) {
    throw normaliseWebAuthnError(err);
  }

  // 3. Verify on server
  const platform = (typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)) ? 'macOS' : 'Windows';
  const syncStatus = platform === 'macOS' ? 'icloud_synced' : 'single_device';

  let verifyRes: Response;
  try {
    verifyRes = await fetch(`${BASE}/api/v1/recipient-passkeys/register-verify`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${params.registrationToken}`,
      },
      body: JSON.stringify({
        response:           credential,
        device_label:       params.deviceLabel,
        device_fingerprint: `${platform}|${params.email}|${params.deviceLabel}`,
        sync_status:        syncStatus,
        transports:         credential.response?.transports ?? [],
      }),
    });
  } catch (err: any) {
    throw new PasskeyError('network', err?.message ?? 'Network error');
  }
  const verifyJson = await verifyRes.json().catch(() => ({} as any));
  if (!verifyRes.ok || !verifyJson.success) {
    throw new PasskeyError('server_rejected', verifyJson.error ?? `register-verify ${verifyRes.status}`);
  }

  return { passkeyId: verifyJson.passkey_id };
}

// ── Authentication ──────────────────────────────────────

export async function authenticatePasskey(params: {
  email: string;
}): Promise<{ email: string; passkeyId: string }> {
  const email = params.email.toLowerCase();

  let optionsRes: Response;
  try {
    optionsRes = await fetch(`${BASE}/api/v1/recipient-passkeys/authenticate-options`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email }),
    });
  } catch (err: any) {
    throw new PasskeyError('network', err?.message ?? 'Network error');
  }
  if (!optionsRes.ok) {
    throw new PasskeyError('server_rejected', `authenticate-options ${optionsRes.status}`);
  }
  const options: PublicKeyCredentialRequestOptionsJSON = await optionsRes.json();

  let credential;
  try {
    credential = await startAuthentication({ optionsJSON: options });
  } catch (err: any) {
    throw normaliseWebAuthnError(err);
  }

  let verifyRes: Response;
  try {
    verifyRes = await fetch(`${BASE}/api/v1/recipient-passkeys/authenticate-verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, response: credential }),
    });
  } catch (err: any) {
    throw new PasskeyError('network', err?.message ?? 'Network error');
  }
  const verifyJson = await verifyRes.json().catch(() => ({} as any));
  if (!verifyRes.ok || !verifyJson.success) {
    throw new PasskeyError('server_rejected', verifyJson.error ?? `authenticate-verify ${verifyRes.status}`);
  }

  saveRecipientSession({
    email:     verifyJson.email,
    token:     verifyJson.session_token,
    passkeyId: verifyJson.passkey_id,
    expiresIn: verifyJson.expires_in,
  });

  return { email: verifyJson.email, passkeyId: verifyJson.passkey_id };
}

/** Probe whether passkeys are usable in this WebView. */
export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && typeof (window.PublicKeyCredential as any).isUserVerifyingPlatformAuthenticatorAvailable === 'function';
}
