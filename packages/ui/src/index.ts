// App shell
export { WebGameApp, WebGameProviders, WebGameRoutes } from "./WebGameApp";
export type { WebGameAppProps } from "./WebGameApp";

// API
export { ApiClient, ApiError, isApiError, buildQuery, resolveApiUrl } from "./api/client";
export type { ApiClientOptions } from "./api/client";
export type * from "./api/types";

// Contexts / hooks
export { ConfigProvider, useConfig, usePlatform, useApi, useResolveUrl } from "./context/config";
export type { WebGameConfig, PlatformConfig } from "./context/config";
export { AuthProvider, useAuth, TOKEN_STORAGE_KEY, readStoredToken } from "./context/auth";
export type { AuthState } from "./context/auth";
export { ToastProvider, useToast } from "./context/toast";
export type { ToastApi, ToastInput, ToastKind } from "./context/toast";

// Components
export {
  GamePlayer,
  GAME_IFRAME_SANDBOX,
  GAME_SAVE_MAX_BYTES,
  gameSaveKey,
  readGameSave,
  writeGameSave,
  clearGameSave,
  hasGameSave,
} from "./components/GamePlayer";
export type { GamePlayerProps, GamePlayerGame } from "./components/GamePlayer";
export { GameCard, GameCardSkeleton, GameGrid } from "./components/GameCard";
export { StarRating } from "./components/StarRating";
export type { StarRatingProps } from "./components/StarRating";
export { Leaderboard } from "./components/Leaderboard";
export { Comments } from "./components/Comments";
export { FileDrop } from "./components/FileDrop";
export type { FileDropProps } from "./components/FileDrop";
export { Layout, Header, Footer, Logo, RequireAuth } from "./components/Layout";
export {
  Alert,
  Avatar,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FallbackArt,
  Pagination,
  ProgressBar,
  Skeleton,
  Spinner,
  StarsDisplay,
  TagChip,
  Thumbnail,
  UserLink,
} from "./components/common";

// Pages
export { HomePage } from "./pages/HomePage";
export { GamePage } from "./pages/GamePage";
export { UploadPage } from "./pages/UploadPage";
export { EditGamePage } from "./pages/EditGamePage";
export { DashboardPage } from "./pages/DashboardPage";
export { ProfilePage } from "./pages/ProfilePage";
export { SettingsPage } from "./pages/SettingsPage";
export { LoginPage, RegisterPage } from "./pages/AuthPages";
export { DocsPage } from "./pages/DocsPage";
export { NotFoundPage } from "./pages/NotFoundPage";

// Utils
export { formatCount, formatDate, timeAgo, errorMessage, looksLikeZip } from "./util";
