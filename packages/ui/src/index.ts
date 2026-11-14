// App shell
export { WebGameApp, WebGameProviders, WebGameRoutes } from "./WebGameApp";
export type { WebGameAppProps } from "./WebGameApp";

// API
export { ApiClient, ApiError, isApiError, buildQuery, resolveApiUrl, parseRetryAfter, rateLimitMessage, KEEPALIVE_MAX_BODY_BYTES } from "./api/client";
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
  discardPendingCloudSave,
  CLOUD_LOAD_TIMEOUT_MS,
  CLOUD_SAVE_DEBOUNCE_MS,
  GAME_LEADERBOARD_CACHE_MS,
} from "./components/GamePlayer";
export { FavoritesProvider, FavoriteButton, useFavorites } from "./components/Favorite";
export type { FavoriteButtonProps, FavoriteState, FavoritesApi } from "./components/Favorite";
export { FollowProvider, FollowButton, useFollows } from "./components/Follow";
export type { FollowButtonProps, FollowState, FollowsApi } from "./components/Follow";
export { FeedItem, FeedItemSkeleton, FEED_ITEM_KINDS, isKnownFeedItem, feedScoreDisplay } from "./components/FeedItem";
export { AchievementIcon, GameAchievements, RecentAchievements } from "./components/Achievements";
export { ReportDialog, ReportButton, REPORT_REASONS } from "./components/Report";
export type { ReportDialogProps } from "./components/Report";
export { PlaysChart, niceMax } from "./components/PlaysChart";
export type { PlaysChartProps } from "./components/PlaysChart";

// Studio
export { createZip, createZipAsync, canDeflateRaw, crc32 } from "./studio/zip";
export type { ZipFiles, ZipInput, CreateZipOptions, CreateZipAsyncOptions, DeflateRawSync } from "./studio/zip";
export {
  buildBundleZip,
  buildBundleZipAsync,
  validateProject,
  validateBundlePaths,
  projectSize,
  checkBundleSize,
  resolveProjectFile,
  MAX_BUNDLE_COMPRESSED_BYTES,
  MAX_BUNDLE_UNCOMPRESSED_BYTES,
  projectFromFileList,
  serializeProject,
  deserializeProject,
  STUDIO_STORAGE_KEY,
  leaderboardOf,
  withLeaderboard,
} from "./studio/project";
export type { StudioProject, StudioManifest, StudioAchievement, StudioLeaderboard } from "./studio/project";
export { STUDIO_TEMPLATES } from "./studio/templates";
export type { StudioTemplate } from "./studio/templates";
export { StudioPreview, STUDIO_READY_TIMEOUT_MS } from "./studio/StudioPreview";
export type { StudioPreviewProps, StudioConsoleEntry, StudioConsoleLevel } from "./studio/StudioPreview";
export { CodeEditor } from "./studio/CodeEditor";
export type { CodeEditorHandle, CodeEditorProps } from "./studio/CodeEditor";
export type { GamePlayerProps, GamePlayerGame } from "./components/GamePlayer";
export { GameCard, GameCardSkeleton, GameGrid } from "./components/GameCard";
export type { GameCardProps, GameCardHighlight } from "./components/GameCard";
export { RelatedGames, RELATED_GAMES_LIMIT } from "./components/RelatedGames";
export { VersionHistory } from "./components/VersionHistory";
export type { VersionHistoryProps } from "./components/VersionHistory";
export { ReleaseNotesField } from "./components/ReleaseNotesField";
export type { ReleaseNotesFieldProps } from "./components/ReleaseNotesField";
export type { RelatedGamesProps } from "./components/RelatedGames";
export { StarRating } from "./components/StarRating";
export type { StarRatingProps } from "./components/StarRating";
export { Leaderboard, LEADERBOARD_PERIOD_KEY } from "./components/Leaderboard";
export type { LeaderboardProps } from "./components/Leaderboard";
export {
  LEADERBOARD_PERIODS,
  DEFAULT_LEADERBOARD_CONFIG,
  normalizeLeaderboardConfig,
  toLeaderboardView,
  toScoreResultView,
  sampleLeaderboardView,
} from "./leaderboard";
export type { LeaderboardView, LeaderboardViewEntry, ScoreResultView } from "./leaderboard";
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
  LoadError,
  Pagination,
  ProgressBar,
  Skeleton,
  Spinner,
  StarsDisplay,
  TagChip,
  Thumbnail,
  UserLink,
} from "./components/common";
export { useModal } from "./components/useModal";
export type { UseModalOptions } from "./components/useModal";

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
export { FavoritesPage } from "./pages/FavoritesPage";
export { GameStatsPage } from "./pages/GameStatsPage";
export { AdminPage } from "./pages/AdminPage";
export { StudioPage, STUDIO_OPEN_FOLDER_EVENT } from "./pages/StudioPage";
export { FeedPage, FEED_TAB_KEY } from "./pages/FeedPage";
export type { FeedTab } from "./pages/FeedPage";
export { FollowListPage } from "./pages/FollowListPage";
export type { FollowListMode } from "./pages/FollowListPage";

// Utils
export {
  formatCount,
  formatDate,
  timeAgo,
  errorMessage,
  looksLikeZip,
  formatScore,
  formatTimeUntil,
  UPDATED_BADGE_MS,
  isRecentlyUpdated,
  RELEASE_NOTES_MAX,
  gameVersionsPath,
} from "./util";
