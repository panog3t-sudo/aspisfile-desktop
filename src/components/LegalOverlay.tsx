import { FileInfo } from "../lib/desktopAuth";

export function LegalOverlay({
  file,
  onAccept,
}: {
  file: FileInfo;
  onAccept: () => void;
}) {
  const senderName = file.sender?.full_name || file.sender?.email || "Someone";

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0F172A",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "#1E293B",
          border: "0.5px solid #334155",
          borderRadius: 10,
          padding: 32,
          maxWidth: 440,
          width: "100%",
          textAlign: "center",
        }}
      >
        <p style={{ fontSize: 16, fontWeight: 500, color: "#E2E8F0", margin: "0 0 6px" }}>
          {file.name}
        </p>
        <p style={{ fontSize: 12, color: "#64748B", margin: "0 0 24px" }}>
          Shared by {senderName}
        </p>

        <div
          style={{
            background: "#0F172A",
            border: "0.5px solid #334155",
            borderRadius: 8,
            padding: "14px 16px",
            marginBottom: 24,
            textAlign: "left",
          }}
        >
          <p style={{ fontSize: 12, color: "#94A3B8", margin: 0, lineHeight: 1.7 }}>
            By opening this file you agree to the following:
          </p>
          <ul style={{ fontSize: 12, color: "#94A3B8", margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
            <li>This file is confidential and intended solely for you.</li>
            <li>You will not screenshot, record, or distribute the contents.</li>
            <li>All access is logged and watermarked.</li>
            {!file.allow_download && <li>Downloading is not permitted.</li>}
          </ul>
        </div>

        <button
          onClick={onAccept}
          style={{
            width: "100%",
            padding: "12px 0",
            borderRadius: 8,
            background: "#2563EB",
            color: "#fff",
            fontSize: 14,
            fontWeight: 500,
            border: "none",
            cursor: "pointer",
          }}
        >
          I agree — open file
        </button>
      </div>
    </div>
  );
}
