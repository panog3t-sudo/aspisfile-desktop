import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SecureViewer } from "./viewer/SecureViewer";
import { IdleScreen } from "./components/IdleScreen";
import { LockScreen } from "./components/LockScreen";
import { SetupModal } from "./components/SetupModal";
import { EnrolmentScreen } from "./components/EnrolmentScreen";
import { LockProvider, useLock, BIOMETRIC_FRESH_MS } from "./contexts/LockContext";
import { supabase } from "./lib/supabase";
import { getActiveSessionToken, getRecipientSession, clearAllRecipientState, saveRecipientSession } from "./lib/recipient-session";
import { WrongAccountScreen } from "./components/WrongAccountScreen";
import { authenticatePasskey } from "./lib/passkey";
import { toggleAfsRender } from "./lib/afs-render";
import "./App.css";
import { DebugOverlay } from "./components/DebugOverlay";
import { debugLog } from "./lib/debug-log";
import UpdateBanner from "./components/UpdateBanner";

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

type Mode = "idle" | "viewer" | "enrol" | "wrong_account";

type ViewerParams = {
  token:   string;
  sig:     string | null;
  env:     string | null;
  present: boolean;
  coview:  string | null;
  // Registration token from the bootstrap page when this is a first-time
  // recipient flow. When present and no session exists, the viewer runs
  // Path B enrolment silently (no EnrolmentScreen — recipient sees one
  // Touch ID prompt in the browser, that's it).
  rt:      string | null;
};

type AfsLink = {
  v:           number;
  type:        string;
  token:       string;
  sig?:        string | null;
  env?:        string | null;
  share_url?:  string | null;
  file_name?:  string | null;
  sender_name?: string | null;
};

function extractFromUrl(url: string): ViewerParams | null {
  try {
    let parsed = new URL(url);

    // Email share links arrive as the tracking-redirect form:
    //   https://aspisfile.com/api/v1/track/click/<id>?r=<encoded /access URL>
    // AASA registers both /access/* AND /api/v1/track/click/* as
    // Universal Link paths so macOS launches AspisFile Viewer for
    // either. Unwrap the inner `r` param to get the real access URL
    // before extracting the token — otherwise extractFromUrl returns
    // null, openLink never fires, the app appears to sit idle after
    // the user taps a share link. Same fix pattern as the mobile
    // parseAccessUrl in lib/recipientAuth.ts.
    if (parsed.pathname.includes("/track/click/")) {
      const r = parsed.searchParams.get("r");
      if (r) {
        try { parsed = new URL(r); } catch { /* fall through, original parsed used */ }
      }
    }

    // Three URL shapes to recognise:
    //
    //   /access/<token>?sig=…&env=…
    //     Standard share link. Universal Link or web → browser fallback.
    //
    //   aspisfile://open?token=…&coview=…&rt=…
    //     Custom-scheme deep link, fired by browser-side AppRequiredScreen
    //     or FirstTimeBootstrap once they detect AspisFile is installed.
    //
    //   /coview/<sessionId>?t=<token>
    //     Co-viewing join link. AASA claims /coview/* so macOS hands
    //     this URL straight to AspisFile, bypassing the browser-side
    //     AppRequiredScreen that would otherwise re-shape it into the
    //     aspisfile:// form. Without translation here, openLink never
    //     fires and the recipient sits on IdleScreen (v1.8.11/v1.8.12
    //     trace).
    let token:  string | undefined;
    let coview: string | null = parsed.searchParams.get("coview");
    const coviewParts = parsed.pathname.split("/coview/");
    const accessParts = parsed.pathname.split("/access/");
    if (coviewParts[1]) {
      // Universal Link coview shape: token is in ?t=, session in path.
      coview = coviewParts[1].split("?")[0].split("/")[0];
      token  = parsed.searchParams.get("t") ?? undefined;
    } else if (accessParts[1]) {
      token = accessParts[1].split("?")[0].split("/")[0];
    } else {
      token = parsed.searchParams.get("token") ?? undefined;
    }
    if (!token) return null;

    return {
      token,
      sig:     parsed.searchParams.get("sig"),
      env:     parsed.searchParams.get("env"),
      present: parsed.searchParams.get("present") === "true",
      coview,
      rt:      parsed.searchParams.get("rt"),
    };
  } catch {
    return null;
  }
}

// Phase 1 post-sprint fix — bring the Tauri window to the foreground
// whenever a deep-link arrives. Without this, the browser-side
// AppRequiredScreen waits 2-8 seconds for `document.hidden` to fire
// as its proxy for "the OS routed to the viewer", but Tauri's
// plugin-deep-link doesn't automatically surface the window — the
// JS callback fires while the window stays in the same focus state.
// On cold-start this usually works because Tauri creates the window
// visible+focused; on warm-start the running window may stay hidden
// or minimised. Calling show + unminimize + setFocus from JS makes
// the browser tab reliably lose visibility, which the web side
// detects as "viewer opened" and suppresses the download modal.
async function bringWindowToFront(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.show();
    await win.unminimize();
    await win.setFocus();
  } catch (err) {
    // Non-fatal — focus is a UX nicety, not a security requirement.
    console.warn("[deep-link] bringWindowToFront failed:", err);
  }
}

// Path B enrolment return — the browser-side /enroll/desktop page
// fires aspisfile://enrol-complete?session_token=…&email=…&passkey
// _id=…&expires_in=… after a successful WebAuthn ceremony. We
// persist the session token via saveRecipientSession() and return
// true so the caller can dismiss EnrolmentScreen and replay any
// pending share-link. Returns false for any other URL shape so
// the caller falls through to OAuth / access-token handling.
function tryHandleEnrolComplete(url: string): { email: string } | null {
  try {
    const u = new URL(url);
    // Tauri's url parsing of `aspisfile://enrol-complete?...` puts
    // "enrol-complete" in the host slot, not the pathname. Be
    // permissive across both interpretations.
    const isComplete =
      u.host === 'enrol-complete' ||
      u.pathname === '/enrol-complete' ||
      u.pathname.endsWith('/enrol-complete');
    if (u.protocol !== 'aspisfile:' || !isComplete) return null;

    const token     = u.searchParams.get('session_token');
    const email     = u.searchParams.get('email');
    const passkeyId = u.searchParams.get('passkey_id');
    const expiresIn = parseInt(u.searchParams.get('expires_in') ?? '28800', 10);

    if (!token || !email || !passkeyId) return null;

    saveRecipientSession({
      email,
      token,
      passkeyId,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 28800,
    });
    return { email };
  } catch {
    return null;
  }
}

// First-time bootstrap: deep link carries a registration token (rt)
// from /access/<token>'s server-rendered bootstrap page. We fetch the
// recipient's email from /access/<token>/meta (the token+rt pair was
// already verified by the bootstrap page that issued rt) and open the
// default browser to /enroll/desktop?email=…&rt=… which runs the
// WebAuthn ceremony and returns a session token via
// aspisfile://enrol-complete. Recipient sees one Touch ID prompt and
// a brief browser-tab bounce — no code entry, no email entry, no
// EnrolmentScreen.
async function startAutoEnrolment(token: string, rt: string): Promise<void> {
  try {
    const metaRes = await fetch(`${BASE}/api/v1/access/${token}/meta`);
    if (!metaRes.ok) {
      console.warn('[auto-enrolment] /meta failed:', metaRes.status);
      return;
    }
    const meta = await metaRes.json() as { recipient_email?: string };
    if (!meta.recipient_email) return;

    const url = new URL(`${BASE}/enroll/desktop`);
    url.searchParams.set('email', meta.recipient_email);
    url.searchParams.set('rt',    rt);
    await openUrl(url.toString());
  } catch (err) {
    console.warn('[auto-enrolment] failed:', err);
  }
}

// Sign in with a passkey ALREADY on this device. The common case the
// viewer previously mishandled: the recipient is enrolled (e.g. an
// iCloud-synced passkey from another Mac, or this same Mac after the
// local session token expired / was never stored — a self-share), but
// has no active session token locally. The old flow assumed "no session
// = must enrol" and forced the fresh-code path, which dead-ended at
// register-verify's already-registered-on-this-device guard.
//
// Here we fetch the recipient_email from /meta, then run a standard
// authentication ceremony (native AS bridge → Touch ID on macOS,
// Windows Hello via WKWebView2 elsewhere). authenticatePasskey saves
// the recipient session on success. Returns true if a session was
// minted, false if no usable passkey is on this device (caller then
// falls back to the fresh-code enrolment path).
async function trySignInWithExistingPasskey(token: string): Promise<boolean> {
  try {
    const metaRes = await fetch(`${BASE}/api/v1/access/${token}/meta`);
    if (!metaRes.ok) return false;
    const meta = await metaRes.json() as { recipient_email?: string };
    if (!meta.recipient_email) return false;
    await authenticatePasskey({ email: meta.recipient_email });
    return true;
  } catch {
    // No discoverable passkey on this device, user cancelled, or the
    // server rejected the assertion — fall back to enrolment.
    return false;
  }
}

// Phase 1 Day 12.5 — recognise OAuth callbacks (aspisfile://auth/
// callback?code=…) coming back from the external browser after
// StepUpScreen launches a Google/Microsoft/Apple sign-in. Returns
// true when the URL was handled (caller skips access-token routing).
async function tryHandleOAuthCallback(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const isCallback =
      (u.host === "auth" && u.pathname === "/callback") ||
      // Some URL parsers route the path differently for custom schemes
      u.pathname.endsWith("/auth/callback");
    if (!isCallback) return false;

    const code = u.searchParams.get("code");
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) console.warn("[oauth-cb] exchangeCodeForSession failed:", error.message);
    }
    // StepUpScreen's window-focus listener picks up the new session
    // from the Supabase client and calls /resolve-oauth itself —
    // App.tsx just owns the code exchange, not the approval lifecycle.
    return true;
  } catch (err) {
    console.warn("[oauth-cb] handler threw:", err);
    return false;
  }
}

function checkLaunchArgs(): ViewerParams | null {
  // Tauri passes the URL as a launch argument when opened via deep link
  const args = window.location.search;
  if (!args) return null;
  const params = new URLSearchParams(args);
  const url = params.get("url");
  if (url) return extractFromUrl(url);
  return null;
}

function AppContent() {
  const [mode, setMode] = useState<Mode>("idle");
  const [viewerParams, setViewerParams] = useState<ViewerParams | null>(null);
  // Set when a deep-link's file recipient doesn't match the viewer's bound
  // identity — drives the WrongAccountScreen (deliberate switch, never silent).
  const [wrongAccount, setWrongAccount] = useState<{ fileRecipient: string; boundEmail: string; params: ViewerParams } | null>(null);
  // pendingLink: a deep-link arrived while the recipient wasn't enrolled.
  // Buffer it, route to EnrolmentScreen, replay it once enrolment completes.
  // Without this gate the server returns BINDING_REQUIRED 403 from
  // /api/v1/mobile/access and the user sees a generic "Session start
  // failed (403)" error in the viewer instead of a recoverable flow.
  //
  // Ref-only (no companion state) because no part of the UI needs to
  // re-render when it changes — only the deep-link useEffect closure
  // and completeEnrolment() read it. State here would trip TS6133
  // because nothing references the reactive value.
  const pendingLinkRef = useRef<ViewerParams | null>(null);
  // Cold-start: counts per-file-biometric mutex retries so a deep link isn't
  // dropped while the LockScreen's unlock biometric is still settling.
  const bioRetryRef = useRef(0);
  const { setupComplete, lastBiometricAt, recordBiometric, locked: appLocked, initialised: lockInitialised, tryBeginBiometric, endBiometric } = useLock();
  const [hasSession, setHasSession] = useState(false);

  // openLink as a ref so deferred callbacks (Tauri event listeners,
  // cold-start drains) read the LATEST closure each call. openLink is
  // redeclared every render; useEffect-captured copies otherwise see
  // appLocked / lastBiometricAt from first render only — which made
  // .afs cold-start route to IdleScreen instead of the file because
  // the stale closure said "appLocked=false" while reality said true.
  const openLinkRef = useRef<((p: ViewerParams) => void) | null>(null);
  // Once-only guard for the cold-start .afs drain — without it, every
  // subsequent app-lock cycle would re-fire take_pending_afs and the
  // user would see their file re-opened on every unlock.
  const drainedAfsRef = useRef(false);

  async function openLink(params: ViewerParams) {
    debugLog('coview', 'openLink', {
      token: params.token?.slice(0,8),
      coview: params.coview?.slice(0,8) ?? null,
      rt: params.rt ? 'present' : null,
      present: params.present,
      hasSession: !!getActiveSessionToken(),
      appLocked,
      lockInitialised,
    });
    // Launch beacon — tell the web Inbox the viewer received this link, the
    // instant we get it (before auth / Touch ID / the file loads), so it can
    // confirm "the viewer opened" without guessing and drop its get-the-viewer
    // prompt. Fire-and-forget; recipient (non-owner) tokens only.
    if (params.token && !params.present) {
      fetch(`${BASE}/api/v1/viewer/launching`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: params.token }),
      }).catch(() => { /* best-effort */ });
    }
    // Wait for LockProvider to finish reading setupComplete from
    // local storage. On cold-start the deep-link arrives before
    // LockProvider initialises — appLocked is still its default
    // false, so openLink falls through to the per-file biometric
    // gate and fires Touch ID #1. Half a second later LockProvider
    // sets appLocked=true and LockScreen renders over the viewer,
    // demanding Touch ID #2. Stash here and let the lock-replay
    // effect re-fire once initialisation is done; the freshly-
    // recorded biometric from LockScreen will dedup the per-file
    // gate so the user sees ONE prompt instead of two.
    if (!lockInitialised) {
      pendingLinkRef.current = params;
      debugLog('coview', 'openLink !lockInitialised → stashed', { coview: params.coview?.slice(0,8) ?? null });
      return;
    }
    // ── SECURITY INVARIANT (memory: feedback-viewer-identity-binding) ──
    // The file's recipient MUST match the identity this viewer is signed in
    // as. NEVER silently re-authenticate as a different recipient (that's the
    // c41da75 regression). If a bound identity exists and the file is for a
    // different recipient, block and require an explicit account switch.
    // Owner/present tokens are exempt — the owner has no recipient row for
    // their own file. Only fetch /meta when a bound identity exists, so a
    // fresh/unbound viewer (first enrolment) is unaffected.
    if (!params.present) {
      const boundEmail = getRecipientSession()?.email?.toLowerCase() ?? null;
      if (boundEmail) {
        let fileRecipient: string | null = null;
        try {
          const metaRes = await fetch(`${BASE}/api/v1/access/${params.token}/meta`);
          if (metaRes.ok) {
            const m = await metaRes.json() as { recipient_email?: string };
            fileRecipient = m.recipient_email?.toLowerCase() ?? null;
          }
        } catch { /* network — fall through; the server still enforces binding */ }
        if (fileRecipient && fileRecipient !== boundEmail) {
          pendingLinkRef.current = null;
          setWrongAccount({ fileRecipient, boundEmail, params });
          setMode('wrong_account');
          return;
        }
      }
    }
    // Phase A+ Stage 7 gate (2026-05-29): only enrolled recipients can
    // open files. The server enforces this via BINDING_REQUIRED 403 if
    // no Bearer is present; we do the client-side route here so the
    // un-enrolled user lands on a useful screen (EnrolmentScreen) and
    // can replay the link after entering their enrolment code.
    //
    // Owner-token flows (present=true from "Present this file" on the
    // dashboard) are exempt — the X-Access-Token header IS the auth,
    // and the /mobile/access route skips the binding check when
    // is_owner_token=true. Without this exemption, a presenter whose
    // recipient session has expired hits enrolment instead of mounting
    // the viewer for their own file.
    if (!params.present && !getActiveSessionToken()) {
      pendingLinkRef.current = params;
      debugLog('coview', 'openLink no session → stashed pendingLinkRef', { coview: params.coview?.slice(0,8) ?? null });
      // First-time bootstrap path A — deep link carries a registration
      // token (rt) from /access/<token>'s server-rendered bootstrap
      // page. Skip EnrolmentScreen entirely.
      if (params.rt) {
        startAutoEnrolment(params.token, params.rt);
        return;
      }
      // First-time bootstrap path B — Universal Link bypassed the
      // browser bootstrap page entirely (AASA claims /access/* for
      // AspisFile so macOS hands the URL straight to us without rt).
      // Try to fetch a fresh registration_token from the server.
      //   - Server returns rt → first-time recipient → silent enrol
      //   - Server returns 404 → already-enrolled but passkey isn't
      //     on this device (different iCloud account / Windows /
      //     different ecosystem). Auto-call request-fresh-code so
      //     the recipient gets a fresh enrolment code email, and
      //     drop them into EnrolmentScreen with the email pre-filled
      //     so they can enter the code without typing the email.
      fetch(`${BASE}/api/v1/access/${params.token}/registration-token`)
        .then(r => r.ok ? r.json() : null)
        .then(async (j: { registration_token?: string } | null) => {
          const rt = j?.registration_token;
          if (rt) {
            startAutoEnrolment(params.token, rt);
            return;
          }
          // Already enrolled, but no local session. Before forcing a
          // fresh enrolment code, try to SIGN IN with a passkey already
          // on this device (iCloud-synced / Windows Hello / same-device
          // expired-session). This is the path the viewer was missing —
          // authenticatePasskey was never called anywhere, so every
          // session-less open went to enrolment and dead-ended on
          // register-verify's already-registered guard.
          const signedIn = await trySignInWithExistingPasskey(params.token);
          if (signedIn) {
            // The passkey ceremony just proved presence — dedup the
            // per-file native biometric gate, clear the buffered link,
            // and replay so openLink mounts the viewer (session now set).
            recordBiometric();
            pendingLinkRef.current = null;
            openLinkRef.current?.(params);
            return;
          }
          // No usable passkey on this device — auto-request a fresh code
          // and drop into EnrolmentScreen. Best-effort: even if the
          // fresh-code call fails, the EnrolmentScreen still works (user
          // can ask the sender for a code or use an old one if valid).
          fetch(`${BASE}/api/v1/access/${params.token}/request-fresh-code`, { method: 'POST' })
            .catch(() => {});
          setMode("enrol");
        })
        .catch(() => setMode("enrol"));
      return;
    }
    // Per-file biometric gate (2026-05-30): every file open requires a
    // fresh Touch ID / Windows Hello prompt. The Tauri command wraps
    // macOS LocalAuthentication.evaluatePolicy / Windows Hello —
    // native dialogs, not WebAuthn, so this is unaffected by the
    // WKWebView WebAuthn limitation that broke in-window enrolment.
    //
    // App-level lock takes precedence: if LockScreen is currently
    // showing, defer the deep-link until it dismisses. The unlock
    // sets lastBiometricAt; the deferred replay below sees the fresh
    // timestamp and skips its own prompt. Mirrors the mobile
    // access/[token] gate. Without this, two concurrent
    // authenticate_biometric calls overlap → SIGABRT (confirmed via
    // mobile crash log AspisFile-2026-05-30-213211.ips).
    if (appLocked) {
      pendingLinkRef.current = params;
      return;
    }

    // Dedup: skip the prompt if the user just biometrically unlocked
    // the app within the last 30s (BIOMETRIC_FRESH_MS). That single
    // verification proves presence for both "unlock the app" and
    // "open this file" as one logical action — no double Touch ID.
    const sinceLast = Date.now() - lastBiometricAt;
    debugLog('coview', 'per-file gate', {
      lastBiometricAt,
      sinceLast,
      freshMs: BIOMETRIC_FRESH_MS,
      dedupPass: sinceLast < BIOMETRIC_FRESH_MS,
    });
    if (sinceLast < BIOMETRIC_FRESH_MS) {
      bioRetryRef.current = 0;
      setViewerParams(params);
      setMode("viewer");
      return;
    }

    // Hard mutex — defends against the rare race where appLocked is
    // false but LockScreen's still-fading attemptBiometric is in
    // flight. Without this, openLink could fire authenticate_biometric
    // concurrent with LockScreen's, same crash scenario as mobile.
    if (!tryBeginBiometric()) {
      // COLD-START FIX: the LockScreen's just-finished unlock biometric is
      // still settling, so the per-file mutex is briefly held. The old code
      // returned here and DROPPED the deep link (the replay had already
      // cleared pendingLinkRef) — leaving the user stuck on "Opening…" with
      // nothing mounted, needing a manual retry. Instead, re-fire shortly
      // until the mutex frees, capped to avoid a loop.
      debugLog('coview', 'per-file gate: tryBeginBiometric busy → retry', { attempt: bioRetryRef.current });
      if (bioRetryRef.current < 6) {
        bioRetryRef.current += 1;
        window.setTimeout(() => openLinkRef.current?.(params), 300);
      } else {
        bioRetryRef.current = 0;   // give up after ~1.8s; a fresh open recovers
      }
      return;
    }
    debugLog('coview', 'per-file gate: invoking authenticate_biometric');
    try {
      await invoke<void>("authenticate_biometric");
      recordBiometric();
      debugLog('coview', 'per-file gate: biometric ok');
    } catch (err) {
      debugLog('coview', 'per-file gate: biometric err', { err: String(err) });
      return;
    } finally {
      endBiometric();
    }
    bioRetryRef.current = 0;
    setViewerParams(params);
    setMode("viewer");
  }
  // Update the ref every render so deferred callbacks call the
  // latest openLink (with current appLocked / lastBiometricAt).
  openLinkRef.current = openLink;

  // Replay any deep-link buffered while app-level lock was active.
  // openLink() above stashes params into pendingLinkRef when
  // appLocked is true; we re-fire openLink once the LockScreen
  // dismisses (locked → false). pendingLinkRef is ALSO used by the
  // enrolment flow (different cause, same buffering pattern) —
  // completeEnrolment handles that branch.
  useEffect(() => {
    debugLog('coview', 'lock-replay effect fired', {
      appLocked,
      lockInitialised,
      hasPending: !!pendingLinkRef.current,
      pendingCoview: pendingLinkRef.current?.coview?.slice(0,8) ?? null,
      hasSession: !!getActiveSessionToken(),
      lastBiometricAt,
    });
    if (!lockInitialised) return;
    if (appLocked) return;
    const replay = pendingLinkRef.current;
    if (!replay) return;
    // Always re-run openLink with the buffered params. It handles all
    // three cases itself:
    //   - has session                → mount the viewer
    //   - no session, recipient link → kick off the auto-enrolment
    //                                  flow (request fresh code →
    //                                  setMode('enrol'))
    //   - present=true               → per-file biometric → viewer
    //
    // Previously this effect short-circuited when getActiveSessionToken
    // returned null, which trapped first-time recipients (or any
    // recipient with an expired session) on the IdleScreen — openLink
    // had stashed pendingLinkRef during !lockInitialised, lock-replay
    // bailed because no session, and the enrolment branch inside
    // openLink never ran. completeEnrolment's pendingLinkRef = null
    // before it re-runs openLink already prevents the racing-with-
    // completeEnrolment scenario the old guard was guarding against.
    pendingLinkRef.current = null;
    debugLog('coview', 'lock-replay → openLink');
    openLink(replay);
    // openLink is intentionally not a useCallback — capturing here
    // for replay is fine, no stale-closure risk because openLink
    // reads lastBiometricAt at call time from the LockContext.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appLocked, lockInitialised]);

  // Auto-resume after a sender approval granted while away. Cold-
  // start path: recipient has a valid session, no deep-link being
  // processed, no buffered link from the lock replay. Check the
  // server for any approved-but-unviewed pending_approvals and
  // open the most recent one automatically. Mirrors the recipient
  // email "your access was approved" — they relaunch the app and
  // the file is just there.
  const autoResumedRef = useRef(false);
  useEffect(() => {
    if (autoResumedRef.current) return;
    if (!lockInitialised || appLocked) return;
    if (pendingLinkRef.current) return; // a deep-link is already being handled
    if (mode !== "idle") return;        // already in viewer or enrol
    const session = getActiveSessionToken();
    if (!session) return;
    autoResumedRef.current = true;

    fetch(`${BASE}/api/v1/recipient/pending-opens`, {
      headers: { Authorization: `Bearer ${session}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const first = data?.pending?.[0] as
          | { access_token: string; file_name: string }
          | undefined;
        if (!first) return;
        openLinkRef.current?.({
          token:   first.access_token,
          sig:     null,
          env:     null,
          present: false,
          coview:  null,
          rt:      null,
        });
      })
      .catch(() => {});
  }, [lockInitialised, appLocked, mode]);
  // back into us with onComplete (used if the future native AS bridge
  // is ever implemented inline) or (b) the aspisfile://enrol-complete
  // deep-link arriving from the browser-redirect enrolment (Path B,
  // active path today). Reads the buffered link from the ref so
  // closure staleness in the once-only deep-link useEffect doesn't
  // matter.
  function completeEnrolment() {
    const replay = pendingLinkRef.current;
    pendingLinkRef.current = null;
    debugLog('coview', 'completeEnrolment', {
      hasReplay: !!replay,
      replayCoview: replay?.coview?.slice(0,8) ?? null,
      replayToken: replay?.token?.slice(0,8) ?? null,
    });
    if (replay) {
      // The user just finished a WebAuthn ceremony in the browser
      // (Path B). Bump lastBiometricAt so the per-file biometric gate
      // in openLink() dedups instead of firing a second native Touch
      // ID prompt. Same proof of presence — no reason to re-prompt
      // within seconds.
      recordBiometric();
      // Route via openLinkRef so we get the LATEST openLink closure
      // (with current lockInitialised, lastBiometricAt). Direct
      // openLink(replay) here captures the mount-time closure of the
      // deep-link useEffect that invokes us — at mount, lockInitialised
      // was false, so the call would just re-stash.
      openLinkRef.current?.(replay);
      return;
    }
    debugLog('coview', 'completeEnrolment no replay → setMode(idle)');
    setMode("idle");
  }

  // Dev/test toggle for the Phase B .afs render path. Release builds have
  // no devtools, so the localStorage flag can't be set from a console —
  // Cmd/Ctrl+Shift+A flips it + reloads. Capture phase so viewer key
  // handlers don't swallow it. (Harmless in prod; does nothing unless used.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        const on = toggleAfsRender();
        // eslint-disable-next-line no-alert
        window.alert(`AspisFile: .afs render ${on ? "ENABLED" : "disabled"} — reloading`);
        window.location.reload();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Track Supabase session presence so SetupModal renders only when
  // the recipient is actually signed in. Phase A+ recipients are
  // passkey-enrolled via lib/passkey.ts; older sender-side sign-ins
  // (QR pair / signin) also produce a Supabase session.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setHasSession(!!session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasSession(!!session);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Cold-start URL: pull directly from the plugin instead of relying on the
    // Rust side's emit racing the React mount. on_open_url events fired during
    // app setup arrive before this listener is registered and are lost.
    getCurrent()
      .then(async (urls) => {
        debugLog('coview', 'getCurrent resolved', { urls: urls?.map(u => String(u).slice(0,80)) });
        if (cancelled || !urls || urls.length === 0) return;
        // Surface the window before any URL processing — gives the
        // browser-side detection a deterministic focus-shift to read.
        await bringWindowToFront();
        // Path B browser-redirect enrolment returning back to us with
        // a fresh session token. Save + complete enrolment + replay
        // any buffered share-link.
        if (tryHandleEnrolComplete(urls[0])) { debugLog('coview', 'getCurrent: matched enrol-complete'); completeEnrolment(); return; }
        if (await tryHandleOAuthCallback(urls[0])) return;
        const params = extractFromUrl(urls[0]);
        if (params) { debugLog('coview', 'getCurrent → openLink', { coview: params.coview?.slice(0,8) ?? null }); openLinkRef.current?.(params); }
      })
      .catch(() => {});

    // Legacy launch-arg path — opening via `aspisfile-desktop ?url=...`
    const launchParams = checkLaunchArgs();
    if (launchParams) openLink(launchParams);

    // Runtime URL deliveries — when the app is already running and a new
    // aspisfile:// URL arrives, the plugin invokes this callback. Same
    // window-focus dance as cold-start: surface before processing.
    const unlistenDeepLinkPromise = onOpenUrl(async (urls) => {
      debugLog('coview', 'onOpenUrl', { urls: urls.map(u => String(u).slice(0,80)) });
      if (cancelled || urls.length === 0) return;
      await bringWindowToFront();
      if (tryHandleEnrolComplete(urls[0])) { debugLog('coview', 'onOpenUrl: matched enrol-complete'); completeEnrolment(); return; }
      if (await tryHandleOAuthCallback(urls[0])) return;
      const params = extractFromUrl(urls[0]);
      if (params) { debugLog('coview', 'onOpenUrl → openLink', { coview: params.coview?.slice(0,8) ?? null }); openLinkRef.current?.(params); }
    });

    // Phase A close-out — .afs file double-click runtime handler. Only
    // the warm-start path is here; cold-start drain lives in its own
    // useEffect below so it can wait for LockProvider initialisation.
    // Routes through openLinkRef so a lock state change between mount
    // and event delivery doesn't trip a stale-closure read.
    const unlistenFile = listen<AfsLink>("open-afs-link", async (event) => {
      const link = event.payload;
      if (!link || link.v !== 1 || link.type !== "aspisfile-link" || !link.token) return;
      await bringWindowToFront();
      openLinkRef.current?.({
        token:   link.token,
        sig:     link.sig ?? null,
        env:     link.env ?? null,
        present: false,
        coview:  null,
        rt:      null,
      });
    });

    return () => {
      cancelled = true;
      unlistenDeepLinkPromise.then((f) => f()).catch(() => {});
      unlistenFile.then((f) => f()).catch(() => {});
    };
  }, []);

  // Cold-start .afs drain — gated on LockProvider init so we don't
  // race against the cold-start lock decision. Sequence on cold-start
  // for an enrolled recipient:
  //   1. App mounts → locked=false (initialised=false hides real value)
  //   2. LockProvider's init() resolves → setLocked(true) + setInitialised(true)
  //   3. User Touch IDs the LockScreen → locked=false
  //   4. THIS effect now sees lockInitialised && !appLocked → drains
  //   5. openLinkRef.current() sees fresh state (biometric just recorded,
  //      so the per-file gate skips its own prompt) → setMode("viewer")
  // If no cold-start lock applies, lockInitialised flips true with
  // appLocked already false → drains immediately. drainedAfsRef
  // guards against re-draining on subsequent lock cycles.
  useEffect(() => {
    if (drainedAfsRef.current) return;
    if (!lockInitialised || appLocked) { debugLog('afs', `drain waiting: lockInit=${lockInitialised} appLocked=${appLocked}`); return; }
    drainedAfsRef.current = true;
    invoke<AfsLink | null>("take_pending_afs")
      .then(async (link) => {
        // DIAGNOSTIC: what did the cold-start drain get?
        debugLog('afs', `drain take_pending_afs → ${link ? `link v=${link.v} type=${link.type} token=${(link.token||'').slice(0,8)}…` : 'NULL'}`);
        if (!link || link.v !== 1 || link.type !== "aspisfile-link" || !link.token) { debugLog('afs', 'drain: link rejected by guard → no open'); return; }
        await bringWindowToFront();
        debugLog('afs', 'drain → openLink');
        openLinkRef.current?.({
          token:   link.token,
          sig:     link.sig ?? null,
          env:     link.env ?? null,
          present: false,
          coview:  null,
          rt:      null,
        });
      })
      .catch((e) => debugLog('afs', `drain error: ${String(e)}`));
  }, [lockInitialised, appLocked]);

  // DIAGNOSTIC (v1.9.35): surface the Rust .afs-open steps in the debug overlay.
  useEffect(() => {
    const un = listen<string>("afs-debug", (e) => debugLog('afs', `[rust] ${e.payload}`));
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);

  if (mode === "viewer" && viewerParams) {
    return (
      <>
        <SecureViewer
          // key forces a clean unmount + remount when a new deep link arrives
          // while the viewer is already open. Without this, React reuses the
          // existing SecureViewer instance and a stale startedRef would
          // prevent the new session from starting — the viewer would render
          // the new file metadata but stay stuck on the AuthLoadingScreen.
          key={viewerParams.token}
          token={viewerParams.token}
          sig={viewerParams.sig}
          env={viewerParams.env}
          onClose={() => { setMode("idle"); setViewerParams(null); }}
          present={viewerParams.present}
          coviewSessionId={viewerParams.coview}
        />
        {/* Phase 1 Day 9 — setup modal blocks the viewer until the
            recipient picks a lock mechanism (or skips). Mounts only
            once per session because markSetupComplete persists to
            localStorage. */}
        {hasSession && !setupComplete && <SetupModal />}
      </>
    );
  }

  if (mode === "wrong_account" && wrongAccount) {
    return (
      <WrongAccountScreen
        fileRecipient={wrongAccount.fileRecipient}
        boundEmail={wrongAccount.boundEmail}
        onSwitch={async () => {
          // Deliberate identity switch: drop the current recipient identity
          // entirely, then replay the link as a fresh viewer so it re-enrols
          // / re-authenticates as the file's recipient.
          const replay = wrongAccount.params;
          clearAllRecipientState();
          try { await supabase.auth.signOut({ scope: "local" }); } catch { /* best-effort */ }
          setWrongAccount(null);
          setMode("idle");
          openLinkRef.current?.(replay);
        }}
        onCancel={() => { setWrongAccount(null); setMode("idle"); }}
      />
    );
  }

  if (mode === "enrol") {
    return (
      <EnrolmentScreen
        // Path B: onComplete is only fired if a future inline-enrolment
        // implementation triggers it. With the browser-redirect path
        // currently active, the aspisfile://enrol-complete deep-link
        // handler is what reaches completeEnrolment(). Wire both to
        // the same function so future swap-back is a no-op.
        onComplete={completeEnrolment}
        onCancel={() => {
          pendingLinkRef.current = null;
          setMode("idle");
        }}
      />
    );
  }

  return (
    <IdleScreen
      onLink={(url) => { const p = extractFromUrl(url); if (p) openLink(p); }}
      onEnrol={() => setMode("enrol")}
    />
  );
}

// App-level LockScreen overlay. LockContext defaults locked=true on
// cold-start if the user has any enrolled credential (sender
// setupComplete or Phase A+ recipient session token). Renders ABOVE
// AppContent so the user can't reach IdleScreen / viewer until they
// prove presence via Touch ID / Windows Hello.
//
// SecureViewer has its own internal LockScreen for the per-file
// idle-timeout lock (60s blur via useLockGuard). That's separate and
// continues to work — but it only fires when a file is actively
// being viewed.
function AppWithLockOverlay() {
  const { locked, unlock } = useLock();
  // DebugOverlay is wired and ready but hidden by default. To turn on
  // for cross-platform / cross-user testing, open devtools and run:
  //   localStorage.setItem('aspisfile_debug_overlay', '1'); location.reload();
  // To turn off again: localStorage.removeItem('aspisfile_debug_overlay').
  // Keep the import + debugLog call sites in source — no rebuild needed
  // to flip the flag during a live test session.
  // DIAGNOSTIC (v1.9.35): overlay ON by default to trace the Windows .afs
  // double-click stop point. Set localStorage aspisfile_debug_overlay='0' to
  // hide. REVERT this default once the .afs bug is confirmed + fixed.
  const showDebug = (() => {
    try { return localStorage.getItem('aspisfile_debug_overlay') !== '0'; }
    catch { return true; }
  })();
  return (
    <>
      <AppContent />
      {/* Update nag — app-level so it's seen regardless of how the viewer was
          entered (a recipient who always double-clicks a .afs may never sit on
          IdleScreen). Hidden while locked so it can't sit over the Touch ID /
          Windows Hello prompt, and never blocking: a recipient opening a
          document must always be able to dismiss it and carry on. */}
      {!locked && <UpdateBanner />}
      {locked && <LockScreen onUnlock={unlock} />}
      {showDebug && <DebugOverlay />}
    </>
  );
}

export default function App() {
  return (
    <LockProvider>
      <AppWithLockOverlay />
    </LockProvider>
  );
}
