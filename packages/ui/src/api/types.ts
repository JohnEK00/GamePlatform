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
  /** F001: leaderboard semantics from game.json (defaults when absent). */
  leaderboard: LeaderboardConfig;
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

export type UserProfileResponse = {
  user: User;
  /** The user's games (paged server-side: `?page=&perPage=`, default 24). */
  games: GameSummary[];
  /** Total number of games for paging `games` (newer servers only). */
  gamesTotal?: number;
  /** F002: users following this user. */
  followers: number;
  /** F002: users this user follows. */
  following: number;
  /** F002: the viewer follows this user; false when anonymous or viewing yourself. */
  isFollowing: boolean;
};
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

// ---- F001: leaderboards 2.0 ----

export type LeaderboardPeriod = "day" | "week" | "all";

export type LeaderboardConfig = {
  /** "desc": higher is better (default); "asc": lower is better. */
  order: "desc" | "asc";
  /** "time": score is milliseconds. */
  format: "number" | "time";
  /** Column label; "" = UI default. Max 24 chars. */
  label: string;
};

export type Leaderboard = {
  period: LeaderboardPeriod;
  /** RFC3339 UTC, inclusive; null for "all". */
  periodStart: string | null;
  /** RFC3339 UTC, exclusive; null for "all". */
  periodEnd: string | null;
  config: LeaderboardConfig;
  /** Each user's best in the window, best first; rank = rank in this window. */
  entries: Score[];
  totalPlayers: number;
  /** The viewer's best in the window, null if anonymous or no score. */
  me: Score | null;
};

export type LeaderboardQuery = { period?: LeaderboardPeriod; limit?: number };

export type ScoreSubmitResult = Score & {
  personalBest: boolean;
  ranks: { day: number; week: number; all: number };
};

// ---- F002: follows and the activity feed ----

export type FollowResponse = {
  following: boolean;
  /** The target's follower count after the change. */
  followers: number;
};

export type FeedItemKind = "gamePublished" | "gameUpdated" | "personalBest" | "achievementUnlocked";

export type FeedItem = {
  /** Opaque cursor value (decimal string). */
  id: string;
  /** Clients must ignore unknown kinds (more may be added later). */
  kind: FeedItemKind;
  /** The game owner for gamePublished/gameUpdated; the player otherwise. */
  actor: UserRef;
  game: GameSummary;
  /** "favorite": shown only because the viewer favorited the game (gamePublished/gameUpdated only). */
  reason: "following" | "favorite";
  /** RFC3339 UTC; for coalesced items, the latest occurrence. */
  createdAt: string;
  /** gamePublished/gameUpdated: the game version at event time; else null. */
  version: number | null;
  /** personalBest only; else null. */
  score: {
    /** The new best. */
    value: number;
    /** True when it was the actor's first score on this game. */
    first: boolean;
    /** The game's CURRENT config (F001), for formatting. */
    leaderboard: LeaderboardConfig;
  } | null;
  /** achievementUnlocked only. `count`: unlocks by the actor in this game that UTC day (>= 1); the def is the latest. */
  achievement: (AchievementDef & { count: number }) | null;
};

export type FeedPage = { items: FeedItem[]; nextCursor: string | null };

export type FeedQuery = {
  /** A FeedItem.id from a previous page; returns strictly older items. */
  cursor?: string;
  /** 1–50, default 20. */
  limit?: number;
  /** Empty or absent = all kinds. */
  kinds?: FeedItemKind[];
};

export type SuggestedCreator = {
  user: UserRef;
  /** "favorited": owns games the viewer favorited. */
  reason: "favorited" | "popular";
  /** Their published game count (>= 1). */
  games: number;
};
