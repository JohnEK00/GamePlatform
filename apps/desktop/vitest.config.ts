import { defineConfig } from "vitest/config";

// Unit tests for the webview TypeScript (no Tauri runtime: @tauri-apps/api is mocked per test).
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
