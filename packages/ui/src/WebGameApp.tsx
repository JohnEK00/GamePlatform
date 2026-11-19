import type { ReactNode } from "react";
import { BrowserRouter, HashRouter, Route, Routes } from "react-router-dom";
import type { ApiClient } from "./api/client";
import { AuthProvider } from "./context/auth";
import { ConfigProvider, type WebGameConfig } from "./context/config";
import { ToastProvider } from "./context/toast";
import { NotificationsProvider } from "./context/notifications";
import type { TabDeps } from "./notificationsTabs";
import { Layout, RequireAuth } from "./components/Layout";
import { FavoritesProvider } from "./components/Favorite";
import { FollowProvider } from "./components/Follow";
import { HomePage } from "./pages/HomePage";
import { GamePage } from "./pages/GamePage";
import { UploadPage } from "./pages/UploadPage";
import { EditGamePage } from "./pages/EditGamePage";
import { DashboardPage } from "./pages/DashboardPage";
import { MyProfileRedirect, ProfilePage } from "./pages/ProfilePage";
import { ProfileGamesTab, ProfileOverview, ProfilePostsTab, ProfileScreenshotsTab } from "./pages/ProfileSections";
import { PostPage } from "./pages/PostPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { DocsPage } from "./pages/DocsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { GameStatsPage } from "./pages/GameStatsPage";
import { AdminPage } from "./pages/AdminPage";
import { StudioPage } from "./pages/StudioPage";
import { FeedPage } from "./pages/FeedPage";
import { FollowListPage } from "./pages/FollowListPage";
import { CreatorsPage } from "./pages/CreatorsPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { CollectionPage } from "./pages/CollectionPage";
import { MyCollectionsRedirect, UserCollectionsPage } from "./pages/UserCollectionsPage";

/**
 * Config + ApiClient + Auth + Toast providers, without a router. `notificationTabs` (F018) overrides the tab
 * coordination APIs of the notifications provider (tests); omit it in production.
 */
export function WebGameProviders({
  config,
  client,
  notificationTabs,
  children,
}: {
  config: WebGameConfig;
  client?: ApiClient;
  notificationTabs?: TabDeps;
  children: ReactNode;
}) {
  return (
    <ConfigProvider config={config} client={client}>
      <AuthProvider>
        <ToastProvider>
          <NotificationsProvider tabs={notificationTabs}>
            <FavoritesProvider>
              <FollowProvider>{children}</FollowProvider>
            </FavoritesProvider>
          </NotificationsProvider>
        </ToastProvider>
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
        <Route
          path="games/:id/stats"
          element={
            <RequireAuth>
              <GameStatsPage />
            </RequireAuth>
          }
        />
        <Route
          path="favorites"
          element={
            <RequireAuth>
              <FavoritesPage />
            </RequireAuth>
          }
        />
        <Route
          path="admin"
          element={
            <RequireAuth>
              <AdminPage />
            </RequireAuth>
          }
        />
        <Route path="studio" element={<StudioPage />} />
        <Route
          path="feed"
          element={
            <RequireAuth>
              <FeedPage />
            </RequireAuth>
          }
        />
        <Route
          path="notifications"
          element={
            <RequireAuth>
              <NotificationsPage />
            </RequireAuth>
          }
        />
        <Route
          path="collections"
          element={
            <RequireAuth>
              <MyCollectionsRedirect />
            </RequireAuth>
          }
        />
        <Route path="c/:id" element={<CollectionPage />} />
        <Route path="p/:id" element={<PostPage />} />
        <Route path="u/:username" element={<ProfilePage />}>
          <Route index element={<ProfileOverview />} />
          <Route path="posts" element={<ProfilePostsTab />} />
          <Route path="games" element={<ProfileGamesTab />} />
          <Route path="screenshots" element={<ProfileScreenshotsTab />} />
          <Route path="collections" element={<UserCollectionsPage />} />
        </Route>
        <Route
          path="me"
          element={
            <RequireAuth>
              <MyProfileRedirect />
            </RequireAuth>
          }
        />
        <Route path="u/:username/followers" element={<FollowListPage mode="followers" />} />
        <Route path="u/:username/following" element={<FollowListPage mode="following" />} />
        <Route path="creators" element={<CreatorsPage />} />
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
