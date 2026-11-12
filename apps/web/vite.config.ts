import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const BACKEND = process.env.WEBGAME_BACKEND ?? "http://localhost:8080";
const uiSrc = fileURLToPath(new URL("../../packages/ui/src/", import.meta.url));

// @webgame/ui resolution:
//  - `vite` (dev server): aliased to packages/ui/src for instant HMR — no need to build the UI package first.
//  - `vite build`: uses the workspace package's built output (packages/ui/dist) via node_modules/@webgame/ui,
//    so run `npm run build -w @webgame/ui` first (the root `npm run build` does this in order).
export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom", "react-router-dom"],
    alias:
      command === "serve" && process.env.WEBGAME_UI_DIST !== "1"
        ? [
            { find: /^@webgame\/ui\/style\.css$/, replacement: uiSrc + "styles.css" },
            { find: /^@webgame\/ui$/, replacement: uiSrc + "index.ts" },
          ]
        : [],
  },
  server: {
    port: 5173,
    strictPort: true,
    // Keep Host as localhost:5173 (changeOrigin: false) so the backend's player page references
    // {ORIGIN}=http://localhost:5173 and engine/bundle requests also flow through this proxy.
    // Only /games/{id}/files/* is proxied: /games/{id} itself is an SPA route.
    proxy: Object.fromEntries(
      ["/api", "/play", "/runtime", "^/games/[^/]+/files/", "/media"].map((p) => [p, { target: BACKEND, changeOrigin: false }]),
    ),
  },
  preview: { port: 4173 },
  build: { target: "es2022", sourcemap: true },
}));
