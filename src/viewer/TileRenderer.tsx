import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
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
};

export function TileRenderer({ sessionId, fileId, file, totalPages }: Props) {
  const [currentPage, setCurrentPage] = useState(1);
  const [tileUrls, setTileUrls] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const fingerprintRef = useRef<string>("");

  useEffect(() => {
    getDesktopFingerprint().then((fp) => { fingerprintRef.current = fp; });
  }, []);

  const fetchTile = useCallback(async (page: number): Promise<string | null> => {
    const key = sessionStore.get();
    if (!key) return null;

    const res = await fetch(
      `${__API_BASE__}/api/v1/viewer/${fileId}/tile?session=${sessionId}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${key}`,
          "X-App-Platform": "desktop",
          "X-Device-Fingerprint": fingerprintRef.current,
        },
      }
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
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          background: "#1E293B",
          borderBottom: "0.5px solid #334155",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, color: "#94A3B8", fontFamily: "system-ui" }}>
          {file.name}
        </span>
        <span style={{ fontSize: 12, color: "#64748B", fontFamily: "system-ui" }}>
          {currentPage} / {totalPages}
        </span>
      </div>

      {/* Tile */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "auto",
          padding: 24,
        }}
      >
        {loading && !tileUrl ? (
          <span style={{ color: "#64748B", fontSize: 13, fontFamily: "system-ui" }}>
            Loading…
          </span>
        ) : tileUrl ? (
          <img
            src={tileUrl}
            alt={`Page ${currentPage}`}
            draggable={false}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              borderRadius: 4,
              boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
              pointerEvents: "none",
            }}
          />
        ) : (
          <span style={{ color: "#EF4444", fontSize: 13, fontFamily: "system-ui" }}>
            Failed to load page.
          </span>
        )}
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
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
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
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
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
