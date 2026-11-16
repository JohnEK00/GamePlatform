import { useCallback, useEffect, useMemo, useState } from "react";
import { WebGameApp, type WebGameConfig } from "@webgame/ui";
import { OfflineBanner } from "./OfflineBanner";
import { installNativeIntegrations } from "./nativeMenu";
import { OsNotificationSetting } from "./OsNotificationSetting";
import { isTauri, openLocalProject, osNotifications, pickFile, reloadLocalProject, saveFile } from "./platform";
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
      platform: {
        name: "Desktop",
        pickFile,
        extraSettings: (
          <>
            <ServerSettings />
            <OsNotificationSetting />
          </>
        ),
        // Desktop only: in a plain browser the Studio uses <input webkitdirectory> and <a download>.
        // osNotifications.isEnabled() is false in a plain browser and the setting renders nothing there.
        ...(isTauri() ? { openLocalProject, reloadLocalProject, saveFile, osNotifications } : {}),
      },
    }),
    [server],
  );

  // Native menu events + F11 (no-op in a plain browser).
  useEffect(() => installNativeIntegrations(), []);

  return (
    <ServerContext.Provider value={serverState}>
      <OfflineBanner key={server} />
      {/* key: switching servers re-mounts the whole app (fresh API client, auth state, caches). */}
      <WebGameApp key={server} config={config} />
    </ServerContext.Provider>
  );
}
