// "A newer version is available" banner. Dismissible, non-blocking, and
// deliberately unobtrusive: a recipient opening a document under time pressure
// must never be stopped by a version nag. Clicking Download opens the
// installer in the default browser; the user quits and reinstalls.
//
// Dismissal is remembered PER VERSION (localStorage), so declining 1.9.26
// doesn't also silence 1.9.27.

import { useEffect, useState } from "react";
import { checkForUpdate, openDownload, type UpdateInfo } from "../lib/update-check";

const DISMISS_KEY = "ax_update_dismissed_version";

export default function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Delay past launch so the check never competes with opening a file —
    // the viewer's own startup (lock, deep-link drain, session) comes first.
    const t = setTimeout(() => {
      checkForUpdate().then(u => {
        if (cancelled || !u) return;
        let dismissed: string | null = null;
        try { dismissed = localStorage.getItem(DISMISS_KEY); } catch { /* private mode */ }
        // A blocking update ignores a previous dismissal — reserved for when
        // min_supported is actually raised.
        if (!u.blocking && dismissed === u.version) return;
        setInfo(u);
      });
    }, 3000);
    return () => { cancelled = true; clearTimeout(t); };
  }, []);

  if (!info) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, info.version); } catch { /* ignore */ }
    setInfo(null);
  };

  return (
    <div
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 9999,
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 14px",
        background: "rgba(15,23,42,0.96)",
        borderTop: "0.5px solid rgba(255,255,255,0.16)",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
      }}
    >
      <span style={{ fontSize: 13, flexShrink: 0 }}>⬆️</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "#E2E8F0", fontWeight: 500 }}>
          Version {info.version} is available
        </p>
        {info.notes && (
          <p style={{ margin: "1px 0 0", fontSize: 11, color: "#94A3B8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {info.notes}
          </p>
        )}
      </div>
      <button
        onClick={() => openDownload(info.url)}
        style={{
          flexShrink: 0, fontSize: 11.5, fontWeight: 500, padding: "6px 12px",
          borderRadius: 5, border: "none", background: "#2E55D4", color: "#fff",
          cursor: "pointer", fontFamily: "inherit",
        }}
      >Download</button>
      {!info.blocking && (
        <button
          onClick={dismiss}
          style={{
            flexShrink: 0, fontSize: 11.5, padding: "6px 10px", borderRadius: 5,
            border: "0.5px solid rgba(255,255,255,0.22)", background: "transparent",
            color: "#94A3B8", cursor: "pointer", fontFamily: "inherit",
          }}
        >Later</button>
      )}
    </div>
  );
}
