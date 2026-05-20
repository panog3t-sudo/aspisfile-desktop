import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { SecureViewer } from "./viewer/SecureViewer";
import { IdleScreen } from "./components/IdleScreen";
import "./App.css";

type Mode = "idle" | "viewer";

type ViewerParams = {
  token:   string;
  sig:     string | null;
  env:     string | null;
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
      present: parsed.searchParams.get("present") === "true",
      coview:  parsed.searchParams.get("coview"),
    };
  } catch {
    return null;
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

export default function App() {
  const [mode, setMode] = useState<Mode>("idle");
  const [viewerParams, setViewerParams] = useState<ViewerParams | null>(null);

  function openLink(params: ViewerParams) {
    setViewerParams(params);
    setMode("viewer");
  }

  useEffect(() => {
    let cancelled = false;

    // Cold-start URL: pull directly from the plugin instead of relying on the
    // Rust side's emit racing the React mount. on_open_url events fired during
    // app setup arrive before this listener is registered and are lost.
    getCurrent()
      .then((urls) => {
        if (cancelled || !urls || urls.length === 0) return;
        const params = extractFromUrl(urls[0]);
        if (params) openLink(params);
      })
      .catch(() => {});

    // Legacy launch-arg path — opening via `aspisfile-desktop ?url=...`
    const launchParams = checkLaunchArgs();
    if (launchParams) openLink(launchParams);

    // Runtime URL deliveries — when the app is already running and a new
    // aspisfile:// URL arrives, the plugin invokes this callback.
    const unlistenDeepLinkPromise = onOpenUrl((urls) => {
      if (cancelled || urls.length === 0) return;
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
    );
  }

  return <IdleScreen onLink={(url) => { const p = extractFromUrl(url); if (p) openLink(p); }} />;
}
