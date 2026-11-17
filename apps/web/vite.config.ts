import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = process.env.WEBGAME_BACKEND ?? "http://localhost:8080";
const uiSrc = fileURLToPath(new URL("../../packages/ui/src/", import.meta.url));
const webDir = fileURLToPath(new URL("./", import.meta.url));
const uiDir = fileURLToPath(new URL("../../packages/ui/", import.meta.url));
const rootNodeModules = fileURLToPath(new URL("../../node_modules/", import.meta.url));

/**
 * Review 6, M1: LAN exposure is opt-in. `WEBGAME_LAN=1 npm run dev:web` listens on all interfaces; otherwise the dev
 * server binds to localhost only.
 */
const LAN = process.env.WEBGAME_LAN === "1";

/**
 * Review 6, M1: what the dev server may serve from disk (incl. `/@fs/<abs path>`), in both modes. Only the app, the
 * UI package and the dependencies are reachable; dev data (the SQLite DB, `.env*`, keys, Rust build output) never is,
 * even if it ends up inside an allowed folder. Setting `deny` replaces Vite's defaults, so they are repeated here.
 */
const FS_ALLOW = [webDir, uiDir, rootNodeModules];
const FS_DENY = [
  ".env",
  ".env.*",
  "**/.env*",
  "**/.env/**",
  "*.{crt,pem,key}",
  "**/*.{crt,pem,key,p12,pfx}",
  "**/.git/**",
  "**/backend/data/**",
  "**/*.db",
  "**/*.db-*",
  "**/*.sqlite",
  "**/*.sqlite-*",
  "**/*.sqlite3",
  "**/target/**",
];

/** Prints a warning when the dev server starts in LAN mode. */
function lanWarning(): Plugin {
  return {
    name: "webgame:lan-warning",
    apply: "serve",
    configureServer(server) {
      if (!LAN) return;
      server.httpServer?.once("listening", () => {
        const y = (t: string) => `\x1b[33m${t}\x1b[0m`;
        console.warn(
          [
            "",
            y("  ⚠  WEBGAME_LAN=1: the dev server is reachable from every device on your network."),
            y("     Anyone on this network can use the app and its /api proxy against your dev backend and its data."),
            y("     Use test accounts only, and set a real JWT_SECRET for the backend. Gamepad, clipboard and multi-tab"),
            y("     notification sync need a secure context (https or localhost), so they are degraded on LAN addresses."),
            "",
          ].join("\n"),
        );
      });
    },
  };
}

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
  plugins: [react(), moveSourceMapsOutOfDist(), lanWarning()],
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
    // Listen on all interfaces so other devices on the LAN can reach the dev server.
    // Opt-in only (review 6, M1): `WEBGAME_LAN=1`; by default the dev server stays on localhost.
    host: LAN ? true : "localhost",
    fs: { strict: true, allow: FS_ALLOW, deny: FS_DENY },
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
