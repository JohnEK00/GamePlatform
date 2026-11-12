/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin, e.g. "http://localhost:8080". Unset/empty = same origin (dev proxy or backend-served SPA). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
