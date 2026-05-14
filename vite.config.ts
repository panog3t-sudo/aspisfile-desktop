import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async ({ mode }) => {
  // @ts-expect-error process is a nodejs global
  const host = process.env.TAURI_DEV_HOST;
  const env = loadEnv(mode, process.cwd(), "");

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
      __SUPABASE_URL__: JSON.stringify(env.VITE_SUPABASE_URL || ""),
      __SUPABASE_ANON_KEY__: JSON.stringify(env.VITE_SUPABASE_ANON_KEY || ""),
    },
  };
});
