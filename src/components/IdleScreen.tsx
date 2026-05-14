import { useState } from "react";

type Props = { onLink: (url: string) => void };

export function IdleScreen({ onLink }: Props) {
  const [input, setInput] = useState("");

  function handleOpen() {
    const val = input.trim();
    if (val) onLink(val);
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0F172A",
        color: "#94A3B8",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        gap: 16,
        padding: 32,
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 4 }}>🔒</div>
      <p style={{ fontSize: 15, fontWeight: 500, color: "#E2E8F0", margin: 0 }}>
        AspisFile Viewer
      </p>
      <p style={{ fontSize: 13, margin: 0, color: "#64748B" }}>
        Open a secure file link or double-click a .afs file to begin.
      </p>

      {/* Dev-mode URL input — paste a share link to test without deep link */}
      {import.meta.env.DEV && (
        <div
          style={{
            marginTop: 24,
            width: "100%",
            maxWidth: 480,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1 }}>
            Dev — paste share link
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleOpen()}
              placeholder="http://localhost:3000/access/TOKEN?sig=...&env=..."
              style={{
                flex: 1,
                padding: "9px 12px",
                borderRadius: 6,
                border: "0.5px solid #334155",
                background: "#1E293B",
                color: "#E2E8F0",
                fontSize: 12,
                fontFamily: "monospace",
                outline: "none",
              }}
            />
            <button
              onClick={handleOpen}
              disabled={!input.trim()}
              style={{
                padding: "9px 16px",
                borderRadius: 6,
                border: "none",
                background: input.trim() ? "#2563EB" : "#1E293B",
                color: input.trim() ? "#fff" : "#475569",
                fontSize: 13,
                cursor: input.trim() ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              Open
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
