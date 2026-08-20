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
import { invoke } from '@tauri-apps/api/core';
import { saveRecipientSession } from './recipient-session';

// Native AS bridge — macOS only. On Windows the WKWebView2 path still
// works via simplewebauthn (we don't have an equivalent native bridge).
// On macOS the in-WebView ceremony is broken (Code=1004 + nil
// credential) so we route through the AuthenticationServices framework
// directly via passkey_register / passkey_authenticate commands.
async function isMacBridge(): Promise<boolean> {
  try {
    const platform = await invoke<string>('get_platform');
    return platform === 'macos';
  } catch {
    return false;
  }
}

async function bridgeRegister(
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<any> {
  const responseJson = await invoke<string>('passkey_register', {
    optionsJson: JSON.stringify(options),
  });
  return JSON.parse(responseJson);
}

async function bridgeAuthenticate(
  options: PublicKeyCredentialRequestOptionsJSON,
): Promise<any> {
  const responseJson = await invoke<string>('passkey_authenticate', {
    optionsJson: JSON.stringify(options),
  });
  return JSON.parse(responseJson);
}

declare const __API_BASE__: string;

const BASE = (typeof __API_BASE__ !== 'undefined' && __API_BASE__) || 'https://aspisfile.com';

// Fire-and-forget telemetry for the NATIVE bridge (macOS AS bridge) outcome.
// Until now only the browser ceremony (/enroll/desktop) reported outcomes, so we
// had no data on how often the native bridge succeeds/fails — needed to decide
// whether a worst-case fallback is required (see docs/native-signin-design.md).
// source='native_bridge' distinguishes these from the browser telemetry.
function reportNativeOutcome(
  step: 'register' | 'authenticate',
  outcome: 'success' | 'failed',
  email?: string,
  errorName?: string,
  durationMs?: number,
) {
  try {
    void fetch(`${BASE}/api/v1/recipient-passkeys/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome, step, source: 'native_bridge', has_platform_auth: true,
        error_name: errorName?.slice(0, 80), duration_ms: durationMs ?? null, email,
      }),
    }).catch(() => {});
  } catch { /* never let telemetry affect the ceremony */ }
}

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
  // Cancel detection (Layer A of the native consolidation): the browser path
  // throws NotAllowedError; the native macOS AS bridge returns a "CANCELLED:"
  // prefixed string (ASAuthorizationError.canceled / code 1001). Both mean the
  // USER backed out — the caller must NOT escape to the browser on this.
  if (name === 'NotAllowedError' || /^CANCELLED\b/.test(msg) || /cancel/i.test(msg)) {
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

  // 2. WebAuthn ceremony — native AS bridge on macOS (in-window
  //    Touch ID), simplewebauthn elsewhere (Windows Hello via WKWebView2).
  let credential;
  const useBridge = await isMacBridge();
  const t0 = Date.now();
  try {
    credential = useBridge
      ? await bridgeRegister(options)
      : await startRegistration({ optionsJSON: options });
    if (useBridge) reportNativeOutcome('register', 'success', params.email, undefined, Date.now() - t0);
  } catch (err: any) {
    const normalised = normaliseWebAuthnError(err);
    if (useBridge) reportNativeOutcome('register', 'failed', params.email, `${normalised.kind}:${err?.name ?? err?.message ?? 'unknown'}`, Date.now() - t0);
    throw normalised;
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

  // Server returns a session token alongside the new passkey id, so
  // the caller doesn't have to run a second authentication ceremony
  // (and trigger a second Touch ID prompt) just to mint a session.
  if (verifyJson.session_token) {
    saveRecipientSession({
      email:     verifyJson.email,
      token:     verifyJson.session_token,
      passkeyId: verifyJson.passkey_id,
      expiresIn: verifyJson.expires_in,
    });
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
  const useBridge = await isMacBridge();
  const t0 = Date.now();
  try {
    credential = useBridge
      ? await bridgeAuthenticate(options)
      : await startAuthentication({ optionsJSON: options });
    if (useBridge) reportNativeOutcome('authenticate', 'success', params.email, undefined, Date.now() - t0);
  } catch (err: any) {
    const normalised = normaliseWebAuthnError(err);
    if (useBridge) reportNativeOutcome('authenticate', 'failed', params.email, `${normalised.kind}:${err?.name ?? err?.message ?? 'unknown'}`, Date.now() - t0);
    throw normalised;
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
