export function RevokedScreen({ reason }: { reason?: string }) {
  const msg =
    reason === "expired"
      ? "Your session has expired. Please re-open the share link."
      : "Access to this file has been revoked by the sender.";

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
        color: "#fff",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        gap: 12,
        padding: 24,
        textAlign: "center",
      }}
    >
      <p style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>File unavailable</p>
      <p style={{ fontSize: 13, color: "#94A3B8", margin: 0, maxWidth: 320, lineHeight: 1.6 }}>
        {msg}
      </p>
    </div>
  );
}
