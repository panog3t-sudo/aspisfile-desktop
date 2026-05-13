export function IdleScreen() {
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
        gap: 12,
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 4 }}>🔒</div>
      <p style={{ fontSize: 15, fontWeight: 500, color: "#E2E8F0", margin: 0 }}>
        AspisFile Viewer
      </p>
      <p style={{ fontSize: 13, margin: 0 }}>
        Open a secure file link or double-click a .afs file to begin.
      </p>
    </div>
  );
}
