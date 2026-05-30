import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { SecureViewer } from "./viewer/SecureViewer";
import { IdleScreen } from "./components/IdleScreen";
import { SetupModal } from "./components/SetupModal";
import { EnrolmentScreen } from "./components/EnrolmentScreen";
import { LockProvider, useLock } from "./contexts/LockContext";
import { supabase } from "./lib/supabase";
import { getActiveSessionToken, saveRecipientSession } from "./lib/recipient-session";
import "./App.css";

type Mode = "idle" | "viewer" | "enrol";

type ViewerParams = {
  token:   string;
  sig:     string | null;
  env:     string | null;
  present: boolean;
  coview:  string | null;
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

    // Token can be in pathname (/access/[token]) for universal links,
    // OR in a query param (?token=...) for aspisfile://open?token=X deep links.
    let token: string | undefined;
    const pathnameParts = parsed.pathname.split("/access/");
    if (pathnameParts[1]) {
      token = pathnameParts[1].split("?")[0].split("/")[0];
    } else {
      token = parsed.searchParams.get("token") ?? undefined;
    }
    if (!token) return null;

    return {
      token,
      sig:     parsed.searchParams.get("sig"),
      env:     parsed.searchParams.get("env"),
      present: parsed.searchParams.get("present") === "true",
      coview:  parsed.searchParams.get("coview"),
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
  const { setupComplete } = useLock();
  const [hasSession, setHasSession] = useState(false);

  async function openLink(params: ViewerParams) {
    // Phase A+ Stage 7 gate (2026-05-29): only enrolled recipients can
    // open files. The server enforces this via BINDING_REQUIRED 403 if
    // no Bearer is present; we do the client-side route here so the
    // un-enrolled user lands on a useful screen (EnrolmentScreen) and
    // can replay the link after entering their enrolment code.
    if (!getActiveSessionToken()) {
      pendingLinkRef.current = params;
      setMode("enrol");
      return;
    }
    setViewerParams(params);
    setMode("viewer");
  }

  // Shared completion path for either (a) the EnrolmentScreen calling
  // back into us with onComplete (used if the future native AS bridge
  // is ever implemented inline) or (b) the aspisfile://enrol-complete
  // deep-link arriving from the browser-redirect enrolment (Path B,
  // active path today). Reads the buffered link from the ref so
  // closure staleness in the once-only deep-link useEffect doesn't
  // matter.
  function completeEnrolment() {
    const replay = pendingLinkRef.current;
    pendingLinkRef.current = null;
    if (replay) {
      openLink(replay);
      return;
    }
    setMode("idle");
  }

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
        if (cancelled || !urls || urls.length === 0) return;
        // Surface the window before any URL processing — gives the
        // browser-side detection a deterministic focus-shift to read.
        await bringWindowToFront();
        // Path B browser-redirect enrolment returning back to us with
        // a fresh session token. Save + complete enrolment + replay
        // any buffered share-link.
        if (tryHandleEnrolComplete(urls[0])) { completeEnrolment(); return; }
        if (await tryHandleOAuthCallback(urls[0])) return;
        const params = extractFromUrl(urls[0]);
        if (params) openLink(params);
      })
      .catch(() => {});

    // Legacy launch-arg path — opening via `aspisfile-desktop ?url=...`
    const launchParams = checkLaunchArgs();
    if (launchParams) openLink(launchParams);

    // Runtime URL deliveries — when the app is already running and a new
    // aspisfile:// URL arrives, the plugin invokes this callback. Same
    // window-focus dance as cold-start: surface before processing.
    const unlistenDeepLinkPromise = onOpenUrl(async (urls) => {
      if (cancelled || urls.length === 0) return;
      await bringWindowToFront();
      if (tryHandleEnrolComplete(urls[0])) { completeEnrolment(); return; }
      if (await tryHandleOAuthCallback(urls[0])) return;
      const params = extractFromUrl(urls[0]);
      if (params) openLink(params);
    });

    // Phase A close-out — .afs file double-click handler. The Rust side
    // parses the v1 link container JSON and emits `open-afs-link` with
    // the structured AfsLink payload (token + sig + env). We convert
    // that to ViewerParams and route through the same openLink() the
    // deep-link pathway uses, so .afs double-click is observationally
    // identical to opening via a share URL.
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
    const unlistenFile = listen<AfsLink>("open-afs-link", async (event) => {
      const link = event.payload;
      if (!link || link.v !== 1 || link.type !== "aspisfile-link" || !link.token) {
        console.warn("[afs] discarded malformed payload:", link);
        return;
      }
      // Bring the window forward — same dance as deep-link arrival.
      await bringWindowToFront();
      const params: ViewerParams = {
        token:   link.token,
        sig:     link.sig ?? null,
        env:     link.env ?? null,
        present: false,
        coview:  null,
      };
      openLink(params);
    });

    return () => {
      cancelled = true;
      unlistenDeepLinkPromise.then((f) => f()).catch(() => {});
      unlistenFile.then((f) => f()).catch(() => {});
    };
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

export default function App() {
  return (
    <LockProvider>
      <AppContent />
    </LockProvider>
  );
}
