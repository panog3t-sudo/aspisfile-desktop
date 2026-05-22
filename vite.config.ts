import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async ({ mode }) => {
  // @ts-expect-error process is a nodejs global
  const host = process.env.TAURI_DEV_HOST;
  const env = loadEnv(mode, process.cwd(), "");

  // Production builds must have Supabase config — empty strings make
  // createClient() throw at module load and crash the React tree into a
  // silent black screen. Catch that at build time.
  const supabaseUrl = env.VITE_SUPABASE_URL || "";
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || "";
  if (mode !== "development" && (!supabaseUrl || !supabaseAnonKey)) {
    throw new Error(
      "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set for production builds. " +
      "Add them to .env.production (committed) or pass them as build env vars.",
    );
  }

  return {
    plugins: [react()],
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
      watch: { ignored: ["**/src-tauri/**"] },
      proxy: {
        "/api": {
          target: env.VITE_API_BASE || "https://aspisfile.com",
          changeOrigin: true,
        },
      },
    },
    define: {
      // Empty string in dev so all API calls are relative → proxied through Vite to localhost:3000.
      // In production the built app calls the absolute API URL directly.
      __API_BASE__: JSON.stringify(mode === "development" ? "" : (env.VITE_API_BASE || "https://aspisfile.com")),
      __SUPABASE_URL__: JSON.stringify(supabaseUrl),
      __SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
      // Read from npm-set env var (auto-populated when build runs via npm/yarn/pnpm).
      // Used by src/lib/audit.ts to populate the X-App-Version header per Unified
      // Tracking Brief §1.1. Falls back to "0.0.0" if absent (edge case in ad-hoc dev).
      __APP_VERSION__: JSON.stringify(env.npm_package_version ?? "0.0.0"),
    },
  };
});
