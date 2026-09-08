// Brand shield watermark + logo block for the dark security screens
// (approved mockup 2026-09-08). Geometry is the site's Mark (brand manual
// v04) — one large shield, faint, drifting off the right edge, exactly the
// aspisfile.com hero treatment translated to the black stage.

export function BrandWatermark({ fixed = false }: { fixed?: boolean } = {}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 280 280"
      style={{
        position: fixed ? "fixed" : "absolute",
        right: "-14%",
        top: "50%",
        transform: "translateY(-50%)",
        width: "min(78vh, 62vw)",
        opacity: 0.055,
        pointerEvents: "none",
      }}
    >
      <g transform="translate(140 140)">
        <circle r="128" fill="none" stroke="#E2E8F0" strokeWidth="6" />
        <circle r="106" fill="#E2E8F0" />
        <path d="M -52 58 L -16 -58 L 16 -58 L 52 58 L 28 58 L 4 -18 L -4 -18 L -28 58 Z" fill="#0F172A" />
      </g>
    </svg>
  );
}

// Rounded-square gradient logo tile (the app-icon look) for screen headers.
export function BrandLogo({ size = 56 }: { size?: number }) {
  return (
    <span
      aria-label="AspisFile"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.24),
        background: "linear-gradient(145deg,#4F79E8,#2743A8)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 6px 18px rgba(30,58,138,0.5)",
      }}
    >
      <svg width={Math.round(size * 0.64)} height={Math.round(size * 0.64)} viewBox="0 0 280 280" aria-hidden="true">
        <g transform="translate(140 140)">
          <circle r="125" fill="#fff" />
          <circle r="106" fill="#1B3AA8" />
          <path d="M -52 58 L -16 -58 L 16 -58 L 52 58 L 28 58 L 4 -18 L -4 -18 L -28 58 Z" fill="#fff" />
        </g>
      </svg>
    </span>
  );
}
