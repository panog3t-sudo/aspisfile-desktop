export function AuthLoadingScreen() {
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
        fontSize: 13,
        gap: 16,
      }}
    >
      {/* @keyframes scoped inline so we don't depend on any global CSS */}
      <style>{`@keyframes aspis-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
      <svg
        width="36"
        height="36"
        viewBox="0 0 50 50"
        style={{ animation: "aspis-spin 0.9s linear infinite" }}
      >
        <circle
          cx="25"
          cy="25"
          r="20"
          fill="none"
          stroke="#1E293B"
          strokeWidth="4"
        />
        <circle
          cx="25"
          cy="25"
          r="20"
          fill="none"
          stroke="#3B82F6"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray="60 200"
        />
      </svg>
      <span>Authenticating…</span>
    </div>
  );
}
