import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { SecureViewer } from "./viewer/SecureViewer";
import { IdleScreen } from "./components/IdleScreen";
import "./App.css";

type Mode = "idle" | "viewer";

type ViewerParams = {
  token: string;
  sig: string | null;
  env: string | null;
};

function extractFromUrl(url: string): ViewerParams | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/access/");
    const token = parts[1]?.split("?")[0]?.split("/")[0];
    if (!token) return null;
    return {
      token,
      sig: parsed.searchParams.get("sig"),
      env: parsed.searchParams.get("env"),
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
    // Check if the app was launched with a share link
    const launchParams = checkLaunchArgs();
    if (launchParams) { openLink(launchParams); return; }

    // Listen for share links opened while running
    const unlistenLink = listen<string>("open-share-link", (event) => {
      const params = extractFromUrl(event.payload);
      if (params) openLink(params);
    });

    // Listen for .afs file opens — placeholder; .afs format TBD
    const unlistenFile = listen<string>("open-afs-file", (event) => {
      console.log("[afs] file opened:", event.payload);
      // TODO: parse .afs bundle and extract token/sig/env
    });

    return () => {
      unlistenLink.then((f) => f());
      unlistenFile.then((f) => f());
    };
  }, []);

  if (mode === "viewer" && viewerParams) {
    return (
      <SecureViewer
        token={viewerParams.token}
        sig={viewerParams.sig}
        env={viewerParams.env}
      />
    );
  }

  return <IdleScreen />;
}
