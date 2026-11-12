import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri sets TAURI_DEV_HOST when developing on a mobile device / remote host.
const host = process.env.TAURI_DEV_HOST;

// @webgame/ui is resolved from the workspace package's built output (packages/ui/dist via
// node_modules/@webgame/ui) in both dev and build — run `npm run build -w @webgame/ui` first.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  resolve: {
    dedupe: ["react", "react-dom", "react-router-dom"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 (Chromium) on Windows, WebKit on macOS/Linux.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "dist",
    emptyOutDir: true,
  },
});
