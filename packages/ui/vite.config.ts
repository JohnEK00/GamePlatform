import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Library build: dist/ui.js (ESM) + dist/ui.css. React & router are peer-style externals
// supplied by the host app (apps/web, apps/desktop) so there is exactly one React instance.
const external = [/^react(\/.*)?$/, /^react-dom(\/.*)?$/, /^react-router(-dom)?(\/.*)?$/];

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/entry.ts",
      formats: ["es"],
      fileName: () => "ui.js",
      cssFileName: "ui",
    },
    rollupOptions: { external },
    sourcemap: true,
    emptyOutDir: true,
    target: "es2022",
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/__tests__/setup.ts"],
    css: false,
  },
});
