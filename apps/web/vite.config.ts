import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = process.env.WEBGAME_BACKEND ?? "http://localhost:8080";
const uiSrc = fileURLToPath(new URL("../../packages/ui/src/", import.meta.url));

/** Where the production source maps go: next to dist/, never inside it (so they're never served). Git-ignored. */
const SOURCEMAP_DIR = fileURLToPath(new URL("./sourcemaps/", import.meta.url));

/**
 * Review 5, M1: `build.sourcemap: "hidden"` writes maps without a `//# sourceMappingURL` comment; this plugin then
 * moves every `.map` out of the output directory into `sourcemaps/` (for error-tracker uploads / local debugging),
 * so nothing that ships in dist/ (and the Docker image) exposes the source.
 */
function moveSourceMapsOutOfDist(): Plugin {
  let outDir = "";
  return {
    name: "webgame:move-sourcemaps",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir.startsWith("/") || /^[A-Za-z]:/.test(c.build.outDir) ? c.build.outDir : join(c.root, c.build.outDir);
    },
    writeBundle() {
      rmSync(SOURCEMAP_DIR, { recursive: true, force: true });
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (name.endsWith(".map")) {
            const dest = join(SOURCEMAP_DIR, relative(outDir, full));
            mkdirSync(dirname(dest), { recursive: true });
            renameSync(full, dest);
          }
        }
      };
      walk(outDir);
    },
  };
}

// @webgame/ui resolution:
//  - `vite` (dev server): aliased to packages/ui/src for instant HMR — no need to build the UI package first.
//  - `vite build`: uses the workspace package's built output (packages/ui/dist) via node_modules/@webgame/ui,
//    so run `npm run build -w @webgame/ui` first (the root `npm run build` does this in order).
export default defineConfig(({ command }) => ({
  plugins: [react(), moveSourceMapsOutOfDist()],
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
  // "hidden": maps are generated but not referenced from the bundle, and the plugin above keeps them out of dist/.
  build: { target: "es2022", sourcemap: "hidden" },
}));
