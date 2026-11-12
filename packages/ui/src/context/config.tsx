import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ApiClient } from "../api/client";

export type PlatformConfig = {
  /** Shown in the footer, e.g. "Desktop". */
  name?: string;
  /** Native file picker. `accept` is an <input accept> string, e.g. ".zip,application/zip". Return null if cancelled. */
  pickFile?: (accept: string) => Promise<File | null>;
  /** Extra content rendered at the bottom of the Settings page. */
  extraSettings?: ReactNode;
};

export type WebGameConfig = {
  /** API origin, e.g. "http://localhost:8080". Empty string = same origin. */
  apiBaseUrl: string;
  routerMode: "browser" | "hash";
  /** Optional router basename (browser mode). */
  basename?: string;
  platform?: PlatformConfig;
};

const ConfigContext = createContext<WebGameConfig | null>(null);
const ApiContext = createContext<ApiClient | null>(null);

export function ConfigProvider({
  config,
  client,
  children,
}: {
  config: WebGameConfig;
  /** Optionally inject a client (tests, custom fetch). */
  client?: ApiClient;
  children: ReactNode;
}) {
  const api = useMemo(() => client ?? new ApiClient({ baseUrl: config.apiBaseUrl }), [client, config.apiBaseUrl]);
  return (
    <ConfigContext.Provider value={config}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </ConfigContext.Provider>
  );
}

export function useConfig(): WebGameConfig {
  const c = useContext(ConfigContext);
  if (!c) throw new Error("useConfig must be used inside <WebGameApp> / <WebGameProviders>");
  return c;
}

export function usePlatform(): PlatformConfig {
  return useConfig().platform ?? {};
}

/** The shared ApiClient (carries the current auth token). */
export function useApi(): ApiClient {
  const c = useContext(ApiContext);
  if (!c) throw new Error("useApi must be used inside <WebGameApp> / <WebGameProviders>");
  return c;
}

/** Resolve server-relative URLs (thumbnailUrl, avatarUrl, playUrl) against apiBaseUrl. */
export function useResolveUrl(): (path: string | null | undefined) => string | null {
  const api = useApi();
  return (p) => api.url(p);
}
