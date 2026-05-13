import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
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
        target: "https://aspisfile.com",
        changeOrigin: true,
      },
    },
  },
  define: {
    __API_BASE__: JSON.stringify(
      process.env.VITE_API_BASE || "https://aspisfile.com"
    ),
    __SUPABASE_URL__: JSON.stringify(process.env.VITE_SUPABASE_URL || ""),
    __SUPABASE_ANON_KEY__: JSON.stringify(
      process.env.VITE_SUPABASE_ANON_KEY || ""
    ),
  },
}));
