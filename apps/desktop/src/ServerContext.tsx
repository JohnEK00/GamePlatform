import { createContext, useContext } from "react";

export type ServerState = {
  /** Active API server URL (normalized, no trailing slash). */
  server: string;
  /** True when the user never saved a server (using the default). */
  isDefault: boolean;
  /** Persist a new server and re-mount the app against it. `null` resets to the default. */
  setServer: (url: string | null) => void;
};

export const ServerContext = createContext<ServerState | null>(null);

export function useServer(): ServerState {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error("useServer must be used inside <ServerContext.Provider>");
  return ctx;
}
