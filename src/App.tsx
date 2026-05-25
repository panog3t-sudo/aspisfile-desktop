import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { SecureViewer } from "./viewer/SecureViewer";
import { IdleScreen } from "./components/IdleScreen";
import { SetupModal } from "./components/SetupModal";
import { LockProvider, useLock } from "./contexts/LockContext";
import { supabase } from "./lib/supabase";
import "./App.css";

type Mode = "idle" | "viewer";

type ViewerParams = {
  token:   string;
  sig:     string | null;
  env:     string | null;
  // Phase 1 Day 9 — magic-link token_hash carried on the share URL by
  // Day 2's email-embed work. Extracted here so the deep-link handler
  // can call supabase.auth.verifyOtp before the SecureViewer mounts.
  // Establishes the Supabase session that the resolve-* endpoints
  // require via Bearer.
  otp:     string | null;
  present: boolean;
  coview:  string | null;
};

function extractFromUrl(url: string): ViewerParams | null {
  try {
    const parsed = new URL(url);

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
      otp:     parsed.searchParams.get("otp"),
      present: parsed.searchParams.get("present") === "true",
      coview:  parsed.searchParams.get("coview"),
    };
  } catch {
    return null;
  }
}

// Phase 1 Day 9 — establish the Supabase session from the share URL's
// magic-link token before we hand off to SecureViewer. Best-effort:
// missing or expired tokens just leave the recipient unsigned-in,
// which still works for clean-tier access (the existing /mobile/access
// flow doesn't require a Supabase session for envelope-validated
// recipients). Step-up paths will fail without a session and the
// StepUpScreen will surface that.
async function tryVerifyMagicLink(otp: string): Promise<void> {
  try {
    await supabase.auth.verifyOtp({
      token_hash: otp,
      type:       "magiclink",
    });
  } catch (err) {
    console.warn("[deep-link] verifyOtp failed:", err);
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
  const { setupComplete } = useLock();
  const [hasSession, setHasSession] = useState(false);

  async function openLink(params: ViewerParams) {
    if (params.otp) {
      await tryVerifyMagicLink(params.otp);
    }
    setViewerParams(params);
    setMode("viewer");
  }

  // Track Supabase session presence so SetupModal renders only when
  // the recipient is actually signed in (post-magic-link verifyOtp).
  // Clean-tier accesses without a magic-link still work — they just
  // don't trigger setup, which is fine for Phase 1.
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
        if (await tryHandleOAuthCallback(urls[0])) return;
        const params = extractFromUrl(urls[0]);
        if (params) openLink(params);
      })
      .catch(() => {});

    // Legacy launch-arg path — opening via `aspisfile-desktop ?url=...`
    const launchParams = checkLaunchArgs();
    if (launchParams) openLink(launchParams);

    // Runtime URL deliveries — when the app is already running and a new
    // aspisfile:// URL arrives, the plugin invokes this callback.
    const unlistenDeepLinkPromise = onOpenUrl(async (urls) => {
      if (cancelled || urls.length === 0) return;
      if (await tryHandleOAuthCallback(urls[0])) return;
      const params = extractFromUrl(urls[0]);
      if (params) openLink(params);
    });

    // .afs file opens — placeholder; .afs format TBD
    const unlistenFile = listen<string>("open-afs-file", (event) => {
      console.log("[afs] file opened:", event.payload);
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

  return <IdleScreen onLink={(url) => { const p = extractFromUrl(url); if (p) openLink(p); }} />;
}

export default function App() {
  return (
    <LockProvider>
      <AppContent />
    </LockProvider>
  );
}
