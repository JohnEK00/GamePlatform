import type { ReactNode } from "react";
import { BrowserRouter, HashRouter, Route, Routes } from "react-router-dom";
import type { ApiClient } from "./api/client";
import { AuthProvider } from "./context/auth";
import { ConfigProvider, type WebGameConfig } from "./context/config";
import { ToastProvider } from "./context/toast";
import { Layout, RequireAuth } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { GamePage } from "./pages/GamePage";
import { UploadPage } from "./pages/UploadPage";
import { EditGamePage } from "./pages/EditGamePage";
import { DashboardPage } from "./pages/DashboardPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { DocsPage } from "./pages/DocsPage";
import { NotFoundPage } from "./pages/NotFoundPage";

/** Config + ApiClient + Auth + Toast providers, without a router. */
export function WebGameProviders({ config, client, children }: { config: WebGameConfig; client?: ApiClient; children: ReactNode }) {
  return (
    <ConfigProvider config={config} client={client}>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </ConfigProvider>
  );
}

/** All application routes (must be rendered inside a router + WebGameProviders). */
export function WebGameRoutes({ extraRoutes }: { extraRoutes?: ReactNode }) {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="games/:id" element={<GamePage />} />
        <Route
          path="games/:id/edit"
          element={
            <RequireAuth>
              <EditGamePage />
            </RequireAuth>
          }
        />
        <Route
          path="upload"
          element={
            <RequireAuth>
              <UploadPage />
            </RequireAuth>
          }
        />
        <Route
          path="dashboard"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route path="u/:username" element={<ProfilePage />} />
        <Route
          path="settings"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="docs" element={<DocsPage />} />
        {extraRoutes}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export type WebGameAppProps = {
  config: WebGameConfig;
  /** Optional pre-built client (custom fetch, tests). */
  client?: ApiClient;
  /** Extra <Route> elements rendered inside the main layout (e.g. desktop-only pages). */
  extraRoutes?: ReactNode;
};

/** The complete Pixelforge Arcade application: router + providers + layout + pages. */
export function WebGameApp({ config, client, extraRoutes }: WebGameAppProps) {
  const Router = config.routerMode === "hash" ? HashRouter : BrowserRouter;
  return (
    <WebGameProviders config={config} client={client}>
      <Router basename={config.basename}>
        <WebGameRoutes extraRoutes={extraRoutes} />
      </Router>
    </WebGameProviders>
  );
}
