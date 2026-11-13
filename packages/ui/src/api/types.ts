// Types mirroring docs/API.md (REST API contract v1 + v2 additions). Keep in sync with the contract.

export type UserRef = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type UserRole = "user" | "admin";

export type User = UserRef & {
  bio: string;
  /** RFC3339 */
  createdAt: string;
  /** v2. Admins see the moderation queue. */
  role: UserRole;
};

export type AuthResponse = { token: string; user: User };

export type GameSummary = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  owner: UserRef;
  /** Server-relative path, e.g. "/media/thumbnails/{id}.png?v=3" */
  thumbnailUrl: string | null;
  plays: number;
  ratingAvg: number;
  ratingCount: number;
  published: boolean;
  createdAt: string;
  updatedAt: string;
  /** v2: number of users who favorited the game. */
  favorites: number;
};

export type Game = GameSummary & {
  width: number;
  height: number;
  /** Increments on each bundle upload */
  version: number;
  entry: string;
  /** "/play/{id}" */
  playUrl: string;
  /** Only when authenticated */
  myRating: number | null;
  isOwner: boolean;
  /** v2, only meaningful when authenticated (false when anonymous). */
  isFavorite: boolean;
  /** v2: achievement definitions from the current version's game.json. */
  achievements: AchievementDef[];
};

export type Page<T> = { items: T[]; total: number; page: number; perPage: number };

export type Comment = {
  id: string;
  gameId: string;
  author: UserRef;
  body: string;
  createdAt: string;
};

export type Score = {
  id: string;
  user: UserRef;
  score: number;
  createdAt: string;
  rank: number;
};

export type TagCount = { tag: string; count: number };

export type ApiErrorCode =
  | "bad_request"
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  /** 429, with a Retry-After header (seconds). */
  | "rate_limited"
  | "internal"
  /** 503, e.g. engine runtime not built. */
  | "unavailable"
  /** Client-side: the request never reached the server. */
  | "network"
  /** Client-side: unparseable / unexpected response. */
  | "unknown";

export type ApiErrorBody = { error: { code: string; message: string } };

// ---- Request shapes ----

export type RegisterRequest = { username: string; email: string; password: string };
/** `login` is a username or an email. */
export type LoginRequest = { login: string; password: string };

export type UserProfileResponse = { user: User; games: GameSummary[] };
export type UpdateMeRequest = { displayName?: string; bio?: string };

export type GameSort = "new" | "popular" | "top" | "favorites";

export type ListGamesQuery = {
  q?: string;
  tag?: string;
  /** A username, or "me" for your own games incl. unpublished (requires auth). */
  owner?: string;
  sort?: GameSort;
  page?: number;
  /** max 100 */
  perPage?: number;
};

export type CreateGameInput = {
  /** 1–80 chars */
  title: string;
  /** ≤ 5000 chars */
  description?: string;
  /** ≤ 8 tags, each ≤ 24 chars; sent comma-separated, lowercased by the server */
  tags?: string[];
  /** default true */
  published?: boolean;
  /** zip, ≤ 50MB */
  bundle: Blob;
  /** png/jpg/webp ≤ 2MB */
  thumbnail?: Blob | null;
};

export type UpdateGameRequest = {
  title?: string;
  description?: string;
  tags?: string[];
  published?: boolean;
};

export type PlayResponse = { plays: number };
/** Short-lived (10 min) preview-scoped JWT, only usable for `/play/{id}?token=`. */
export type PreviewTokenResponse = { token: string; expiresAt: string };

export type RatingResponse = { ratingAvg: number; ratingCount: number; myRating: number | null };

export type PageQuery = { page?: number; perPage?: number };

export type HealthResponse = { status: "ok"; version: string };

/** Upload progress callback: `loaded`/`total` in bytes, `fraction` in 0..1. */
export type UploadProgress = (p: { loaded: number; total: number; fraction: number }) => void;

// ---- v2: favorites ----

export type FavoriteResponse = { favorited: boolean; favorites: number };

// ---- v2: achievements ----

export type AchievementDef = {
  id: string;
  name: string;
  description: string;
  /** Server-relative URL or null */
  iconUrl: string | null;
};

export type GameAchievement = AchievementDef & {
  unlockedBy: number;
  /** Only when authenticated: when *you* unlocked it. */
  unlockedAt: string | null;
};

export type UserAchievement = AchievementDef & { gameId: string; gameTitle: string; unlockedAt: string };

export type UnlockAchievementResponse = { achievement: UserAchievement; new: boolean };

// ---- v2: cloud saves ----

export type CloudSave = { data: Record<string, unknown> | null; updatedAt: string | null };
export type PutSaveResponse = { updatedAt: string };

// ---- v2: analytics ----

/** `date` is YYYY-MM-DD (UTC). Always 30 entries, oldest first, zero-filled. */
export type DailyPlays = { date: string; plays: number };

export type CreatorStats = {
  totals: {
    games: number;
    published: number;
    plays: number;
    favorites: number;
    comments: number;
    ratingCount: number;
    /** Weighted across games, 0 if none. */
    ratingAvg: number;
  };
  daily: DailyPlays[];
};

export type GameStats = {
  plays: number;
  favorites: number;
  comments: number;
  /** Distinct users with a score, save or achievement. */
  uniquePlayers: number;
  daily: DailyPlays[];
};

// ---- v2: moderation ----

export type ReportReason = "spam" | "offensive" | "broken" | "copyright" | "other";
export type ReportTargetType = "game" | "comment";
export type ReportStatus = "open" | "resolved";
export type ReportAction = "dismiss" | "unpublish" | "delete";

export type Report = {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  /** Game title or the first 140 chars of the comment. */
  targetPreview: string;
  targetGameId: string;
  reason: ReportReason;
  details: string;
  reporter: UserRef;
  status: ReportStatus;
  resolution: ReportAction | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type CreateReportRequest = {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  /** max 1000 chars */
  details?: string;
};

export type ListReportsQuery = PageQuery & { status?: ReportStatus };
