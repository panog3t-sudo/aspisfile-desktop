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

// The OFFICIAL app-icon SVG (AFile Brand + Logos/App Icon/AspisFile App
// Icon.svg), copied verbatim — Pano 2026-09-08: header logos must match the
// standard icon exactly, no redrawn approximations.
import appIcon from "../assets/aspisfile-icon.svg";

export function BrandLogo({ size = 56 }: { size?: number }) {
  return (
    <img
      src={appIcon}
      alt="AspisFile"
      width={size}
      height={size}
      style={{ boxShadow: "0 6px 18px rgba(30,58,138,0.5)", display: "block", borderRadius: Math.round(size * 0.25) }}
    />
  );
}
