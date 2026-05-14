import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  fileName: string;
  onUnlock: () => void;
};

export function LockScreen({ fileName, onUnlock }: Props) {
  const [status, setStatus] = useState<"idle" | "verifying" | "error">("idle");
  const inProgressRef = useRef(false);

  async function attempt() {
    if (inProgressRef.current) return;
    inProgressRef.current = true;
    setStatus("verifying");
    try {
      await invoke("authenticate_biometric");
      onUnlock();
    } catch {
      setStatus("error");
    } finally {
      inProgressRef.current = false;
    }
  }

  // Prompt when the user returns to the window (focus), not on mount
  useEffect(() => {
    const handleFocus = () => attempt();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      onClick={attempt}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#000",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        userSelect: "none",
        WebkitUserSelect: "none",
        cursor: status === "verifying" ? "default" : "pointer",
      } as React.CSSProperties}
    >
      <span style={{ fontSize: 44, lineHeight: 1 }}>🔒</span>

      <p style={{ color: "#F1F5F9", fontSize: 15, fontWeight: 500, margin: 0 }}>
        Viewer locked
      </p>

      <p
        style={{
          color: "#475569",
          fontSize: 12,
          margin: 0,
          maxWidth: 280,
          textAlign: "center",
          lineHeight: 1.5,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {fileName}
      </p>

      <p style={{ color: "#334155", fontSize: 12, margin: "4px 0 0" }}>
        {status === "idle"      && "Click to unlock"}
        {status === "verifying" && "Waiting for authentication…"}
        {status === "error"     && (
          <span style={{ color: "#EF4444" }}>Authentication failed — click to try again</span>
        )}
      </p>
    </div>
  );
}
