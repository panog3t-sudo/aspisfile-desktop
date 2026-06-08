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
  onLock: () => void;
  // Co-viewing page sync — both optional, no behaviour change when unset
  targetPage?: number;
  onCurrentPageChange?: (page: number) => void;
  // Co-viewing presenter entry point. When defined, the toolbar renders
  // a "Present" button (file-owner only — SecureViewer gates the prop on
  // file.is_owner && !presenterSession before passing it in).
  onPresent?: () => void;
  // Co-viewing recipient lockdown. When true, the viewer mirrors the
  // presenter exactly: Prev/Next disabled, zoom disabled, scroll
  // programmatic-only (user mouse/touch blocked). Set by SecureViewer
  // when the recipient is joined to a session AND has chosen Follow.
  followMode?: boolean;
  // Zoom sync — same shape as page sync. targetZoom (controlled by
  // parent) overrides the internal zoomIndex; onCurrentZoomChange
  // reports user interactions back to the parent.
  targetZoom?: number;
  onCurrentZoomChange?: (zoomIndex: number) => void;
  // Scroll sync. Presenter side: onPublishScroll fires (throttled) on
  // local scroll. Recipient side: subscribedScroll, when set, is
  // applied programmatically to the scroll container.
  onPublishScroll?: (s: { v: number; h: number }) => void;
  subscribedScroll?: { v: number; h: number } | null;
  // Sprint 2 — .afs download entry point. SecureViewer passes onDownload
  // only when canDownload is true (file.allow_download && recipient_allow_download
  // && !is_owner && !blobDeleted), so the button is fully hidden in those
  // cases. downloadState drives label + disabled state once the button shows.
  onDownload?:    () => void;
  downloadState?: 'available' | 'in_progress' | 'confirmed';
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

export function TileRenderer({
  sessionId, fileId, file, totalPages, onLock,
  targetPage, onCurrentPageChange, onPresent, followMode,
  targetZoom, onCurrentZoomChange, onPublishScroll, subscribedScroll,
  onDownload, downloadState,
}: Props) {
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
  const fingerprintRef    = useRef<string>("");
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Follow-mode scroll lock — attach wheel + touchmove as non-passive
  // native listeners. React 17+ treats JSX onWheel / onTouchMove as
  // passive by default, so preventDefault() in a synthetic handler is
  // silently ignored by Chromium/WebKit. Tauri 2 ships a strict
  // WebKit; without explicit { passive: false }, the recipient can
  // scroll their viewport in follow mode and breaks page sync. Fix
  // confirmed against the v1.4.x → v1.5.0 regression report.
  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node || !followMode) return;
    const block = (e: Event) => e.preventDefault();
    node.addEventListener('wheel',     block, { passive: false });
    node.addEventListener('touchmove', block, { passive: false });
    return () => {
      node.removeEventListener('wheel',     block);
      node.removeEventListener('touchmove', block);
    };
  }, [followMode]);

  // Sync external targetZoom (presenter pushed zoom_change) into local state
  useEffect(() => {
    if (typeof targetZoom !== 'number') return;
    if (targetZoom < 0 || targetZoom >= ZOOM_STEPS.length) return;
    if (targetZoom !== zoomIndex) setZoomIndex(targetZoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetZoom]);

  // Apply subscribedScroll programmatically (recipient side). Percentages
  // → pixels using the container's current scroll dimensions, so the
  // recipient ends up at the same relative position even if their
  // viewport size differs from the presenter's.
  useEffect(() => {
    if (!subscribedScroll || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current;
    const maxV = el.scrollHeight - el.clientHeight;
    const maxH = el.scrollWidth  - el.clientWidth;
    if (maxV > 0) el.scrollTop  = subscribedScroll.v * maxV;
    if (maxH > 0) el.scrollLeft = subscribedScroll.h * maxH;
  }, [subscribedScroll]);

  // Throttled scroll publish (presenter side). Trailing-edge timer so the
  // final position lands within ~80ms even after a fast scroll-then-stop.
  // No publish when onPublishScroll is undefined (recipient side).
  const lastPublishedScrollRef = useRef<{ v: number; h: number } | null>(null);
  const scrollPendingRef       = useRef<{ v: number; h: number } | null>(null);
  const scrollTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushScroll = useCallback(() => {
    scrollTimerRef.current = null;
    const pending = scrollPendingRef.current;
    if (!pending || !onPublishScroll) return;
    const last = lastPublishedScrollRef.current;
    if (last && Math.abs(last.v - pending.v) < 0.001 && Math.abs(last.h - pending.h) < 0.001) return;
    lastPublishedScrollRef.current = pending;
    onPublishScroll(pending);
    scrollPendingRef.current = null;
  }, [onPublishScroll]);
  const onScrollEvent = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!onPublishScroll) return; // recipient side: no publish
    const el = e.currentTarget;
    const maxV = el.scrollHeight - el.clientHeight;
    const maxH = el.scrollWidth  - el.clientWidth;
    const v = maxV > 0 ? el.scrollTop  / maxV : 0;
    const h = maxH > 0 ? el.scrollLeft / maxH : 0;
    scrollPendingRef.current = { v, h };
    if (!scrollTimerRef.current) {
      scrollTimerRef.current = setTimeout(flushScroll, 80);
    }
  }, [onPublishScroll, flushScroll]);

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
        // 100% so the flex-row parent in SecureViewer can size this
        // (RHS participant panel takes 320px; document gets the rest).
        // The flex parent has height: 100vh, so we still fill the
        // viewport vertically.
        height: "100%",
        width:  "100%",
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
        {/* Left: lock button + file name.
            Doc-level close (X) removed — the native window close
            button does the same thing (unmounts SecureViewer, fires
            /close, terminates the viewer_session) and having two
            close affordances was confusing recipients. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
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

        {/* Center: zoom controls (hidden in follow mode — recipient
            mirrors the presenter exactly) */}
        {!followMode && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <button
              onClick={() => setZoomIndex((i) => {
                const next = Math.max(0, i - 1);
                if (next !== i) onCurrentZoomChange?.(next);
                return next;
              })}
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
              onClick={() => setZoomIndex((i) => {
                const next = Math.min(ZOOM_STEPS.length - 1, i + 1);
                if (next !== i) onCurrentZoomChange?.(next);
                return next;
              })}
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              title="Zoom in"
              style={toolbarBtnStyle(zoomIndex === ZOOM_STEPS.length - 1)}
            >
              +
            </button>
          </div>
        )}

        {/* Right: Download button (recipient-only, gated by SecureViewer),
            Present button (owner-only), and page count. The Download
            button is fully hidden when onDownload prop is absent —
            SecureViewer omits it when the user can't or shouldn't
            download (owner, blob deleted, allow_download false). */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {onDownload && downloadState && (
            <button
              onClick={downloadState === 'available' ? onDownload : undefined}
              disabled={downloadState !== 'available'}
              title={
                downloadState === 'confirmed'
                  ? 'Already downloaded'
                  : downloadState === 'in_progress'
                  ? 'Download in progress'
                  : 'Download this file'
              }
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                height: 26, padding: '0 10px',
                borderRadius: 4,
                border: `0.5px solid ${downloadState === 'confirmed' ? '#3B6D11' : '#334155'}`,
                background: downloadState === 'confirmed' ? '#1A2E10' : 'transparent',
                color: downloadState === 'available' ? '#F1F5F9' : '#94A3B8',
                cursor: downloadState === 'available' ? 'pointer' : 'default',
                fontSize: 12, fontWeight: 500, lineHeight: 1,
                fontFamily: 'system-ui',
                flexShrink: 0,
                opacity: downloadState === 'in_progress' ? 0.6 : 1,
              }}
            >
              {downloadState === 'available'   && <>↓ Download</>}
              {downloadState === 'in_progress' && <>↓ Downloading…</>}
              {downloadState === 'confirmed'   && <>✓ Downloaded</>}
            </button>
          )}
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

      {/* Tile — outer div is the scroll container. Image width is a
          percentage (NOT a transform) so the layout box matches the
          rendered size and the scroll container overflows correctly
          when zoomed in.
          Follow mode: still overflow:auto so programmatic scroll
          (subscribedScroll → scrollTop/scrollLeft) works, but user
          input is blocked via onWheel preventDefault + touch-action:
          none. The presenter's onScroll publishes scroll position via
          the ref + throttle so recipients in follow mode mirror it.
          Centering note: previously used display:flex + justify-content:
          center on the inner wrapper. That breaks horizontal scroll
          above 100% zoom — the centered overflowing item gets a
          negative starting x-coordinate and scrollLeft can't go
          negative, so the left half becomes unreachable. Using
          margin: 0 auto on the image box instead: collapses to 0 when
          the box is wider than the parent (so image left-aligns and
          horizontal scroll naturally exposes the right side), centers
          when narrower. */}
      <div
        ref={scrollContainerRef}
        onScroll={onScrollEvent}
        // onWheel / onTouchMove are NOT specified here as JSX synthetic
        // handlers — React makes those passive by default and
        // preventDefault() is a no-op. The native listeners attached via
        // the useEffect above (keyed on followMode) carry { passive:
        // false } so the scroll-lock actually fires. touch-action:none
        // is the CSS-level belt-and-braces for touch scrolling.
        style={{
          flex:       1,
          overflow:   'auto',
          touchAction: followMode ? 'none' : 'auto',
        }}
      >
        <div
          style={{
            minHeight: "100%",
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
                marginLeft: "auto",
                marginRight: "auto",
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

      {/* Pagination — hidden in follow mode (recipient mirrors the
          presenter; their own page navigation is disabled). */}
      {totalPages > 1 && !followMode && (
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
