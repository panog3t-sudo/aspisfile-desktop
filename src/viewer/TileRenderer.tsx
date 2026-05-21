import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { sessionStore } from "../lib/sessionStore";
import { FileInfo, RecipientInfo } from "../lib/desktopAuth";

declare const __API_BASE__: string;

async function getDesktopFingerprint(): Promise<string> {
  const platform = await invoke<string>("get_platform");
  const raw = `${platform}:${screen.width}x${screen.height}:${
    Intl.DateTimeFormat().resolvedOptions().timeZone
  }`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Props = {
  sessionId: string;
  fileId: string;
  file: FileInfo;
  recipient?: RecipientInfo;
  totalPages: number;
  onClose: () => void;
  onLock: () => void;
  // Co-viewing page sync — both optional, no behaviour change when unset
  targetPage?: number;
  onCurrentPageChange?: (page: number) => void;
  // Co-viewing presenter entry point. When defined, the toolbar renders
  // a "Present" button (file-owner only — SecureViewer gates the prop on
  // file.is_owner && !presenterSession before passing it in).
  onPresent?: () => void;
};

const ZOOM_STEPS = [50, 75, 100, 125, 150, 175, 200];

const toolbarBtnStyle = (disabled: boolean): React.CSSProperties => ({
  width: 26,
  height: 26,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  border: "0.5px solid #334155",
  background: disabled ? "transparent" : "#0F172A",
  color: disabled ? "#475569" : "#CBD5E1",
  cursor: disabled ? "not-allowed" : "pointer",
  fontSize: 16,
  lineHeight: 1,
  fontFamily: "system-ui",
  flexShrink: 0,
});

export function TileRenderer({ sessionId, fileId, file, totalPages, onClose, onLock, targetPage, onCurrentPageChange, onPresent }: Props) {
  const [currentPage, setCurrentPage] = useState(1);

  // Sync external targetPage (e.g. presenter pushed a page_change) into local state
  useEffect(() => {
    if (targetPage && targetPage >= 1 && targetPage <= totalPages && targetPage !== currentPage) {
      setCurrentPage(targetPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPage, totalPages]);
  const [tileUrls, setTileUrls] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [zoomIndex, setZoomIndex] = useState(2); // 100% default
  const fingerprintRef = useRef<string>("");

  useEffect(() => {
    getDesktopFingerprint().then((fp) => { fingerprintRef.current = fp; });
  }, []);

  // Block all copy / cut / select-all keyboard shortcuts and clipboard events
  useEffect(() => {
    const blockCopy = (e: ClipboardEvent) => e.preventDefault();
    document.addEventListener("copy",  blockCopy);
    document.addEventListener("cut",   blockCopy);
    return () => {
      document.removeEventListener("copy",  blockCopy);
      document.removeEventListener("cut",   blockCopy);
    };
  }, []);

  const fetchTile = useCallback(async (page: number): Promise<string | null> => {
    const key = sessionStore.getKey();
    if (!key) return null;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "X-App-Platform": "desktop",
      "X-Device-Fingerprint": fingerprintRef.current,
    };
    const ds = sessionStore.getDeviceShare();
    if (ds) headers["X-Device-Share"] = ds;

    const res = await fetch(
      `${__API_BASE__}/api/v1/viewer/${fileId}/tile?session=${sessionId}&page=${page}`,
      { headers }
    );

    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }, [sessionId, fileId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchTile(currentPage).then((url) => {
      if (cancelled || !url) return;
      setTileUrls((prev) => ({ ...prev, [currentPage]: url }));
      setLoading(false);
    });

    // Prefetch next page
    if (currentPage < totalPages) {
      fetchTile(currentPage + 1).then((url) => {
        if (cancelled || !url) return;
        setTileUrls((prev) => ({ ...prev, [currentPage + 1]: url }));
      });
    }

    return () => { cancelled = true; };
  }, [currentPage, fetchTile, totalPages]);

  const tileUrl = tileUrls[currentPage];

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#0F172A",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && ["c", "a", "s", "x", "p"].includes(e.key.toLowerCase())) {
          e.preventDefault();
        }
      }}
      tabIndex={-1}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          background: "#1E293B",
          borderBottom: "0.5px solid #334155",
          flexShrink: 0,
          gap: 12,
        }}
      >
        {/* Left: close button + file name */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
          <button
            onClick={() => { sessionStore.clear(); onClose(); }}
            title="Close document"
            style={toolbarBtnStyle(false)}
          >
            ✕
          </button>
          <button
            onClick={onLock}
            title="Lock viewer"
            style={toolbarBtnStyle(false)}
          >
            🔒
          </button>
          <span style={{ fontSize: 13, color: "#94A3B8", fontFamily: "system-ui", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name}
          </span>
        </div>

        {/* Center: zoom controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <button
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
            disabled={zoomIndex === 0}
            title="Zoom out"
            style={toolbarBtnStyle(zoomIndex === 0)}
          >
            −
          </button>
          <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: "system-ui", minWidth: 38, textAlign: "center" }}>
            {ZOOM_STEPS[zoomIndex]}%
          </span>
          <button
            onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            title="Zoom in"
            style={toolbarBtnStyle(zoomIndex === ZOOM_STEPS.length - 1)}
          >
            +
          </button>
        </div>

        {/* Right: Present button (owner-only) + page count.
            Print and download badges removed — see project memory
            'Wire up print + download' — the icons advertised capabilities
            we don't yet implement. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {onPresent && (
            <button
              onClick={onPresent}
              title="Start a co-viewing presentation"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: 26,
                padding: "0 10px",
                borderRadius: 4,
                border: "0.5px solid #1D4ED8",
                background: "#1D4ED8",
                color: "#FFFFFF",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 500,
                lineHeight: 1,
                fontFamily: "system-ui",
                flexShrink: 0,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="2" width="12" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
                <path d="M5 12.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M6 5.5 L9 7 L6 8.5 Z" fill="currentColor" />
              </svg>
              Present
            </button>
          )}
          <span style={{ fontSize: 12, color: "#64748B", fontFamily: "system-ui" }}>
            {currentPage} / {totalPages}
          </span>
        </div>
      </div>

      {/* Tile — outer div is the scroll container, inner div handles
          horizontal centering. The image's width is set as a percentage
          (NOT a transform) so the layout box matches the rendered size
          and the outer scroll container can overflow vertically AND
          horizontally when zoomed in. */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <div
          style={{
            minHeight: "100%",
            display: "flex",
            alignItems: "flex-start", // top-anchor; scroll container handles vertical overflow
            justifyContent: "center",
            padding: 24,
            boxSizing: "border-box",
          }}
        >
          {loading && !tileUrl ? (
            <span style={{ color: "#64748B", fontSize: 13, fontFamily: "system-ui" }}>
              Loading…
            </span>
          ) : tileUrl ? (
            <div
              style={{
                position: "relative",
                lineHeight: 0,
                // Width-based scaling: at 100% the image fills the
                // centering container; >100% overflows the scroll
                // container so scrollbars appear (transform: scale never
                // does this because it doesn't affect the layout box).
                width: `${ZOOM_STEPS[zoomIndex]}%`,
                maxWidth: "none",
                flexShrink: 0,
                transition: "width 0.15s ease",
              }}
            >
              <img
                src={tileUrl}
                alt=""
                draggable={false}
                style={{
                  display: "block",
                  width: "100%",
                  height: "auto",
                  borderRadius: 4,
                  boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
                  pointerEvents: "none",
                  WebkitUserDrag: "none",
                } as React.CSSProperties}
              />
              {/* Transparent overlay — blocks click-to-select and right-click on the image */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  cursor: "default",
                  userSelect: "none",
                  WebkitUserSelect: "none",
                } as React.CSSProperties}
                onContextMenu={(e) => e.preventDefault()}
              />
            </div>
          ) : (
            <span style={{ color: "#EF4444", fontSize: 13, fontFamily: "system-ui" }}>
              Failed to load page.
            </span>
          )}
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: "12px 16px",
            background: "#1E293B",
            borderTop: "0.5px solid #334155",
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setCurrentPage((p) => {
              const next = Math.max(1, p - 1);
              if (next !== p) onCurrentPageChange?.(next);
              return next;
            })}
            disabled={currentPage <= 1}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: "0.5px solid #334155",
              background: currentPage <= 1 ? "#0F172A" : "#1E293B",
              color: currentPage <= 1 ? "#475569" : "#E2E8F0",
              cursor: currentPage <= 1 ? "not-allowed" : "pointer",
              fontSize: 13,
              fontFamily: "system-ui",
            }}
          >
            ‹ Prev
          </button>
          <button
            onClick={() => setCurrentPage((p) => {
              const next = Math.min(totalPages, p + 1);
              if (next !== p) onCurrentPageChange?.(next);
              return next;
            })}
            disabled={currentPage >= totalPages}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: "0.5px solid #334155",
              background: currentPage >= totalPages ? "#0F172A" : "#1E293B",
              color: currentPage >= totalPages ? "#475569" : "#E2E8F0",
              cursor: currentPage >= totalPages ? "not-allowed" : "pointer",
              fontSize: 13,
              fontFamily: "system-ui",
            }}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
