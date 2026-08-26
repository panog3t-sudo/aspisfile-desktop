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
import { getCurrentWindow } from '@tauri-apps/api/window';
import { saveRecipientSession } from './recipient-session';

// Native passkey bridge — macOS (AuthenticationServices) AND Windows (Win32
// WebAuthn / webauthn.dll). Both run the OS's own passkey dialog IN-WINDOW via
// the passkey_register / passkey_authenticate commands, so no browser and no
// per-browser variance. The in-WebView2 simplewebauthn path can't be used
// (WebView2's tauri.localhost origin ≠ our aspisfile.com RP), which is exactly
// why each OS gets a native bridge. Only Linux/other falls back to the browser.
async function hasNativeBridge(): Promise<boolean> {
  try {
    const platform = await invoke<string>('get_platform');
    return platform === 'macos' || platform === 'windows';
  } catch {
    return false;
  }
}

// Surface the viewer window before the native passkey dialog so the OS prompt
// (Windows Hello / Touch ID) opens IN FRONT — not behind other windows or a
// background/auto-locked viewer (reported: Hello prompt hidden behind Outlook,
// Kobus 2026-08-26). Best-effort — focus is a UX nicety, never a hard gate.
async function bringViewerToFront(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch { /* focus is a nicety; ignore */ }
}

async function bridgeRegister(
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<any> {
  await bringViewerToFront();
  const responseJson = await invoke<string>('passkey_register', {
    optionsJson: JSON.stringify(options),
  });
  return JSON.parse(responseJson);
}

async function bridgeAuthenticate(
  options: PublicKeyCredentialRequestOptionsJSON,
): Promise<any> {
  await bringViewerToFront();
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

// Fire-and-forget sign-in PATH telemetry — which flow the viewer committed to
// and how it ended. Complements the per-ceremony reportNativeOutcome + the
// server verify-path telemetry: this is the FLOW view for monitoring sign-up/
// sign-in (recovery rate, browser-fallback rate, drop-off by path).
export function reportSigninPath(
  path: 'first_open_register' | 'returning_authenticate' | 'cold_signin' | 'recovery_reenroll' | 'browser_fallback',
  outcome: 'started' | 'success' | 'cancelled' | 'failed' | 'reenroll',
  extra?: { platform?: string; errorName?: string; email?: string },
) {
  const url = `${BASE}/api/v1/recipient-passkeys/telemetry`;
  const payload = JSON.stringify({
    event: 'signin_path', path, outcome,
    platform: extra?.platform, error_name: extra?.errorName?.slice(0, 80), email: extra?.email,
  });
  // sendBeacon survives the native passkey dialog taking over the webview — a
  // plain fire-and-forget fetch fired right before it gets dropped. A string
  // body is a text/plain "simple" request (no CORS preflight); the telemetry
  // route's req.json() parses it regardless of the content-type header.
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        && navigator.sendBeacon(url, payload)) return;
  } catch { /* fall through to fetch */ }
  try {
    void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
  } catch { /* never let telemetry affect sign-in */ }
}

export type PasskeyErrorKind =
  | 'unsupported'
  | 'cancelled'
  | 'credential_not_found'   // WS2a — server no longer holds this device's credential (revoked/orphaned)
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
  const useBridge = await hasNativeBridge();
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
  const useBridge = await hasNativeBridge();
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
    // WS2a — the server no longer holds the credential this device signed with
    // (revoked / orphaned). Surface a distinct kind so the caller routes to a
    // fresh code→register sign-in instead of a dead end.
    if (verifyJson.error === 'CREDENTIAL_NOT_FOUND') {
      throw new PasskeyError('credential_not_found', "This device's passkey is no longer registered.");
    }
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
