import { useCallback, useMemo, useState } from "react";
import { WebGameApp, type WebGameConfig } from "@webgame/ui";
import { OfflineBanner } from "./OfflineBanner";
import { pickFile } from "./platform";
import { DEFAULT_SERVER, readSavedServer, saveServer } from "./server";
import { ServerContext, type ServerState } from "./ServerContext";
import { ServerSettings } from "./ServerForm";

export function App() {
  const [saved, setSaved] = useState<string | null>(() => readSavedServer());
  const server = saved ?? DEFAULT_SERVER;

  const setServer = useCallback((url: string | null) => {
    saveServer(url);
    setSaved(url);
  }, []);

  const serverState = useMemo<ServerState>(() => ({ server, isDefault: saved === null, setServer }), [server, saved, setServer]);

  const config = useMemo<WebGameConfig>(
    () => ({
      apiBaseUrl: server,
      routerMode: "hash",
      platform: { name: "Desktop", pickFile, extraSettings: <ServerSettings /> },
    }),
    [server],
  );

  return (
    <ServerContext.Provider value={serverState}>
      <OfflineBanner key={server} />
      {/* key: switching servers re-mounts the whole app (fresh API client, auth state, caches). */}
      <WebGameApp key={server} config={config} />
    </ServerContext.Provider>
  );
}
