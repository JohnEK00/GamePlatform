// Vite library entry: pulls in the stylesheet (extracted to dist/ui.css) and re-exports the public API.
// Types are emitted from index.ts so the published .d.ts has no CSS side-effect import.
import "./styles.css";
export * from "./index";
