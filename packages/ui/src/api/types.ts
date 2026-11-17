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
  /**
   * F003: counted non-owner plays in the last 7 UTC days (approximate snapshot).
   * Older servers omit it; treat a missing value as 0.
   */
  playsWeek: number;
  /**
   * F004: RFC3339 UTC of the latest bundle replace made while the game was published; null if none.
   * Older servers omit it; treat a missing value as null.
   */
  lastUpdatedAt?: string | null;
};

/** F003: an item of `GET /api/games/{id}/related`. */
export type RelatedGame = GameSummary & {
  /** "tags": shares >= 1 tag with the source game; "trending": fill-up. */
  reason: "tags" | "trending";
  /** Shared tags in the SOURCE game's tag order; [] when reason is "trending". */
  sharedTags: string[];
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
  /** F004: the current version's history row. Older servers omit it. */
  latestVersion?: GameVersion;
  /**
   * F009: declared controls of the CURRENT version's game.json, normalised, in declared order; [] when absent.
   * Servers older than F009 omit it (treat as []).
   */
  actions?: ControlAction[];
  /** F009: normalised game.json `controls` text (0–300 chars, plain text); "" when absent. Older servers omit it. */
  controlsHint?: string;
  /**
   * F018: the viewer muted notifications about this game (`GET /api/games/{id}` only; false when anonymous).
   * Older servers omit it: hide the mute button.
   */
  notificationsMuted?: boolean;
  /** F020: who can comment and slow mode (the same for every viewer). Older servers omit it: hide the settings UI. */
  commentSettings?: CommentSettings;
};

/** F020: who may post new comments on a game. */
export type CommentMode = "on" | "repliesOnly" | "off";

/** F020: slow-mode interval in seconds; 0 = slow mode off. */
export type SlowModeSecs = 0 | 30 | 60 | 300 | 900 | 3600;

/** F020: `PUT /api/games/{id}/comment-settings` body and response, and `Game.commentSettings`. */
export type CommentSettings = {
  /** "on" by default. */
  mode: CommentMode;
  /** 0 by default. */
  slowModeSecs: SlowModeSecs;
};

/** F020: `CommentListPage.settings`, viewer-specific. */
export type CommentSettingsView = CommentSettings & {
  /** The viewer is the game's current owner or an admin: may change the settings, exempt from mode and slow mode. */
  canManage: boolean;
  /** Whole seconds until the viewer may post again under slow mode (0..slowModeSecs). Relative to the server's clock. */
  waitSecs: number;
};

/** F009: gamepad buttons an action can use (the engine's `GamepadButtons` names without `Home`). */
export type GamepadButtonName =
  | "A"
  | "B"
  | "X"
  | "Y"
  | "LB"
  | "RB"
  | "LT"
  | "RT"
  | "Back"
  | "Start"
  | "LS"
  | "RS"
  | "Up"
  | "Down"
  | "Left"
  | "Right";

/** F009: one declared game action (GAME_FORMAT.md § F009). */
export type ControlAction = {
  /** ^[a-z0-9_-]{1,32}$, unique per game */
  id: string;
  /** 1–40 chars, trimmed, no control or bidi characters. Plain text. */
  name: string;
  /** 0–3 unique bindable codes (KeyboardEvent.code, or Mouse0..2), e.g. "KeyA", "Space". */
  keys: string[];
  /** 0–2 unique; keys.length + gamepad.length >= 1 */
  gamepad: GamepadButtonName[];
};

/** F009: player key overrides: action id → bindable codes (replaces that action's default keys). */
export type ControlOverrides = Record<string, string[]>;

/** F016: player gamepad overrides: action id → gamepad button names (replaces that action's default buttons). */
export type GamepadOverrides = Record<string, GamepadButtonName[]>;

/** F016: a player's control bindings for one game (API.md § F016). */
export type ControlBindings = {
  /** Up to 32 ids; each value 0–3 unique bindable codes (Mouse0..2 allowed). */
  keys: ControlOverrides;
  /** Up to 32 ids; each value 0–2 unique gamepad button names (no `Home`). */
  gamepad: GamepadOverrides;
};

/** F016: `GET /api/games/{id}/controls`. Both null when the caller never stored bindings for the game. */
export type ControlBindingsResponse = { bindings: ControlBindings | null; updatedAt: string | null };

/** F016: `PUT /api/games/{id}/controls` → the normalised copy that was stored. */
export type PutControlsResponse = { bindings: ControlBindings; updatedAt: string };

/** F004: one row of a game's version history. */
export type GameVersion = {
  /** >= 1 */
  version: number;
  /** Plain text, 0–1000 chars, "
" line breaks; "" = no notes. Never render as HTML. */
  notes: string;
  /** RFC3339 UTC: when this version went live. */
  createdAt: string;
  /** version === the game's current version */
  current: boolean;
};

/** F004: what a (possibly coalesced) gameUpdated feed item covers. */
export type FeedUpdate = {
  /** Lowest version covered; === FeedItem.version when only one. */
  fromVersion: number;
  /** Covered versions with non-empty notes, newest first, at most 3. */
  changes: { version: number; notes: string }[];
};

export type Page<T> = { items: T[]; total: number; page: number; perPage: number };

/**
 * F006 fields (`parentId` … `canDelete`) are on every comment newer servers return. Older servers omit them:
 * read them through `normalizeComment` (null / 0 / false defaults).
 */
export type Comment = {
  id: string;
  gameId: string;
  author: UserRef;
  body: string;
  createdAt: string;
  /** F006: null = top-level; otherwise always the id of a top-level comment (one level of nesting). */
  parentId: string | null;
  /** F006: replies only, the author of the reply that was answered; null otherwise or if that user was deleted. */
  replyTo: UserRef | null;
  /** F006: the author is the game's current owner. */
  isCreator: boolean;
  /** F006: distinct users who hearted this comment. */
  hearts: number;
  /** F006: the viewer hearted it (false when anonymous). */
  myHeart: boolean;
  /** F006: the game's current owner hearted it. */
  creatorHeart: boolean;
  /** F006: the viewer may delete it (author, game owner or admin; false when anonymous). */
  canDelete: boolean;
  /** F017: top-level only, this is the game's pinned comment (always false on replies). Older servers omit it (false). */
  pinned: boolean;
  /** F017: top-level only, the thread is locked against new replies (always false on replies). Older servers omit it (false). */
  locked: boolean;
  /** F017: top-level only, the viewer is the game's current owner or an admin (may pin/lock). Older servers omit it (false). */
  canModerate: boolean;
  /**
   * F018: top-level only, the viewer muted notifications for this thread (false on replies and when anonymous).
   * Older servers omit it: hide the mute button.
   */
  threadMuted?: boolean;
};

/** F017: thread order of `GET /api/games/{id}/comments`. */
export type CommentSort = "new" | "top";

/** F017: `PUT` / `DELETE /api/comments/{id}/pin|lock`. */
export type ThreadState = {
  /** The comment acted on. */
  id: string;
  pinned: boolean;
  locked: boolean;
  /** `PUT …/pin` only: the comment that was pinned before and is now unpinned; else null. */
  unpinnedId: string | null;
};

/** F006: a top-level comment with a preview of its replies. */
export type CommentThread = Comment & {
  /** All replies in the thread. Older servers omit it (treat as 0). */
  replyCount: number;
  /** The oldest replies, oldest first, at most 3. Older servers omit it (treat as []). */
  replies: Comment[];
};

/** F006: `GET /api/games/{id}/comments`. `total` counts top-level comments only. */
export type CommentListPage = Page<CommentThread> & {
  /** Comments + replies on the game. Older servers omit it (treat as `total`). */
  totalAll: number;
  /**
   * F017: the game's pinned thread (never in `items` or `total`), on every page; null when none. Older servers omit
   * it (treat as null).
   */
  pinned: CommentThread | null;
  /**
   * F020: the game's comment settings as seen by the viewer, on every page (read it from page 1). Older servers omit
   * it: read the page through `normalizeCommentListPage` (defaults `on` / 0 / false / 0).
   */
  settings: CommentSettingsView;
};

/** F006: `GET /api/comments/{id}`. `thread.id === comment.id` when the comment is top-level. */
export type CommentContext = { comment: Comment; thread: CommentThread };

/** F006: `PUT` / `DELETE /api/comments/{id}/heart`. */
export type HeartResponse = { hearted: boolean; hearts: number; creatorHeart: boolean };

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
  /** F020: 429 on `POST …/comments` while the poster waits under slow mode; with Retry-After (seconds). */
  | "slow_mode"
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

export type GameSort = "new" | "popular" | "top" | "favorites" | "trending";

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
  /** F004: version 1's release notes (sent only when non-empty after trim). */
  notes?: string;
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
/** F017: `GET /api/games/{id}/comments` (`sort` is sent only when given). */
export type CommentListQuery = PageQuery & { sort?: CommentSort };

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
/** F005: "screenshot" added; F008: "collection" added. Render unknown types with Dismiss only. */
export type ReportTargetType = "game" | "comment" | "screenshot" | "collection";
export type ReportStatus = "open" | "resolved";
export type ReportAction = "dismiss" | "unpublish" | "delete";

export type Report = {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  /**
   * Game title, the first 140 chars of the comment, (F005) the screenshot caption / "Screenshot by {name}", or (F008)
   * the first 140 chars of the collection title at report time.
   */
  targetPreview: string;
  /** F008: null for "collection" reports; a game id for every other type. */
  targetGameId: string | null;
  reason: ReportReason;
  details: string;
  reporter: UserRef;
  status: ReportStatus;
  resolution: ReportAction | null;
  createdAt: string;
  resolvedAt: string | null;
  /**
   * F005: the screenshot's thumbUrl while it exists (server-relative); null for other target types and deleted
   * screenshots. Older servers omit it; treat a missing value as null.
   */
  targetImageUrl: string | null;
  /**
   * Review 3 (L7): the screenshot's full-size imageUrl while it exists (server-relative); null for other target
   * types and deleted screenshots. Older servers omit it; fall back to `targetImageUrl`.
   */
  targetImageFullUrl: string | null;
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

/** F021 adds "collectionUpdated"; F015 adds "screenshotPosted". */
export type FeedItemKind = "gamePublished" | "gameUpdated" | "personalBest" | "achievementUnlocked" | "collectionUpdated" | "screenshotPosted";

/** F021: one game of a `collectionUpdated` item. */
export type FeedCollectionGame = {
  game: GameSummary;
  /** The curator's current note (plain text, 0–140 chars, single line); "" = none. Never render as HTML. */
  note: string;
};

/** F021: the collection of a `collectionUpdated` item. */
export type FeedCollection = {
  /** Collection id (UUID v4). */
  id: string;
  /** The collection's CURRENT title (plain text). */
  title: string;
  /** "/c/{id}" */
  path: string;
  /** 1–4 entries, newest added first. */
  games: FeedCollectionGame[];
  /** All games of the item (>= games.length >= 1). */
  gameCount: number;
};

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
  /** F004: gameUpdated only; missing on older servers (treat as null). */
  update?: FeedUpdate | null;
  /** F021: collectionUpdated only; null for every other kind. Older servers omit it (treat as null). */
  collection?: FeedCollection | null;
  /** F015: screenshotPosted only; null for every other kind. Older servers omit it (treat as null). */
  screenshots?: FeedScreenshots | null;
};

/** F015: the screenshots of a `screenshotPosted` item (computed at read time). */
export type FeedScreenshots = {
  /** All of the actor's screenshots of this game on the item's UTC day; 1–20, >= items.length. */
  count: number;
  /** 1–4 entries, newest first (createdAt desc, then id asc); canDelete per viewer. */
  items: Screenshot[];
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

// ---- F005: screenshots ----

export type Screenshot = {
  id: string;
  gameId: string;
  author: UserRef;
  /** Plain text, 0–140 chars, single line; "" = none. Never render as HTML. */
  caption: string;
  /** "/media/screenshots/{id}.png" or ".jpg" (server-relative). */
  imageUrl: string;
  /** "/media/screenshots/{id}_t.jpg", fits in 480×480. */
  thumbUrl: string;
  /** Of imageUrl, 64–4096. */
  width: number;
  height: number;
  /** The game's version when it was posted. */
  gameVersion: number;
  /** RFC3339 UTC */
  createdAt: string;
  /** The viewer is the author, the game owner or an admin; false when anonymous. */
  canDelete: boolean;
};

export type ScreenshotPage = Page<Screenshot>;

/** F015: the game of a profile screenshot. */
export type ScreenshotGameRef = { id: string; title: string };
/** F015: an item of `GET /api/users/{username}/screenshots`. */
export type UserScreenshot = Screenshot & { game: ScreenshotGameRef };

// ---- F007: in-app notifications ----

/** F018 adds "pinned"; F021 adds "addedToCollection"; F024 adds "screenshotPosted". */
export type NotificationKind =
  | "comment"
  | "reply"
  | "heart"
  | "follow"
  | "gamePublished"
  | "pinned"
  | "addedToCollection"
  | "screenshotPosted";

/** F024: the newest remaining screenshot of a `screenshotPosted` notification. */
export type NotificationScreenshot = {
  /** Screenshot id (UUID v4). */
  id: string;
  /** "/media/screenshots/{id}_t.jpg"; resolve against the API base. */
  thumbUrl: string;
};

/** F021: the collection of an `addedToCollection` notification. */
export type NotificationCollection = {
  id: string;
  /** The collection's CURRENT title (plain text written by another user). */
  title: string;
  /** "/c/{id}" */
  path: string;
};

export type NotificationGame = { id: string; title: string; thumbnailUrl: string | null };

export type Notification = {
  /** Decimal string; stable for the row's lifetime. */
  id: string;
  /** Clients must ignore unknown kinds (see `isKnownNotification`). */
  kind: NotificationKind;
  /** 1–3 most recent distinct actors, newest first. */
  actors: UserRef[];
  /** Distinct actors in the group, >= 1. */
  actorCount: number;
  /** Events in the group, >= actorCount (comment/reply: comments posted; else = actorCount). */
  eventCount: number;
  /** Null only for "follow". */
  game: NotificationGame | null;
  /** comment: the newest comment; reply: the newest reply; heart: the hearted comment; else null. */
  commentId: string | null;
  /** First 140 chars of commentId's current body; plain text (render as text only); null when commentId is null. */
  excerpt: string | null;
  /** reply: the recipient wrote the thread's top-level comment; false otherwise. */
  ownsThread: boolean;
  /** heart: the game's current owner is among the actors; false otherwise. */
  creatorHeart: boolean;
  read: boolean;
  /** RFC3339 millis Z, first event of the group. */
  createdAt: string;
  /** RFC3339 millis Z, latest event of the group (the ordering key). */
  updatedAt: string;
  /** In-app route to open. */
  path: string;
  /**
   * F018: reply → the thread's top-level comment; heart → the top-level comment of the hearted comment's thread;
   * pinned → the pinned comment; else null. Older servers omit it (treat as null).
   */
  threadId?: string | null;
  /** F021: addedToCollection only; null for every other kind. Older servers omit it (treat as null). */
  collection?: NotificationCollection | null;
  /** F024: screenshotPosted only; null for every other kind. Older servers omit it (treat as null). */
  screenshot?: NotificationScreenshot | null;
};

export type NotificationPage = {
  /** updatedAt desc, then id desc. */
  items: Notification[];
  /** Opaque; null when there are no more items. */
  nextCursor: string | null;
  /** Same value as UnreadCount.unread. */
  unread: number;
};

export type UnreadCount = {
  /** Visible unread notifications, capped at 100 (show "99+" at 100). */
  unread: number;
  /** updatedAt of the newest visible unread notification; null when unread = 0. */
  latestAt: string | null;
  /** Suggested delay before the next poll. */
  pollAfterSecs: number;
};

/** All default to true. */
export type NotificationSettings = {
  /** "comment" kind */
  comments: boolean;
  /** "reply" kind */
  replies: boolean;
  /** "heart" kind */
  hearts: boolean;
  /** "follow" kind */
  follows: boolean;
  /** "gamePublished" kind */
  newGames: boolean;
  /** F018: "pinned" kind. Older servers omit it: hide the switch. */
  pins?: boolean;
  /** F021: "addedToCollection" kind. Older servers omit it: hide the switch. */
  collections?: boolean;
  /** F024: "screenshotPosted" kind. Older servers omit it: hide the switch. */
  screenshots?: boolean;
};

// ---- F018: notification mutes ----

export type MuteTarget = "game" | "thread";

export type NotificationMute = {
  target: MuteTarget;
  /** The game (for threads: the thread's game). */
  game: NotificationGame;
  /** thread: the top-level comment id; game: null. */
  threadId: string | null;
  /** thread: first 80 chars of the top-level comment's current body (plain text); game: null. */
  excerpt: string | null;
  /** game: "/games/{gameId}"; thread: "/games/{gameId}?comment={threadId}". */
  path: string;
  /** RFC3339 millis Z, when it was muted. */
  createdAt: string;
};

export type NotificationMuteList = {
  /** createdAt desc; only mutes whose game is visible to the caller. */
  items: NotificationMute[];
  /** items.length (no paging). */
  total: number;
};

export type MuteState = {
  /** The state after the request. */
  muted: boolean;
  /** UnreadCount.unread after the request (mutes mark matching notifications read). */
  unread: number;
};

export type MarkReadRequest = {
  /** 1–100 notification ids; absent = every unread notification of the caller. */
  ids?: string[];
  /** RFC3339; only rows with updatedAt <= upTo are marked (race guard). */
  upTo: string;
};

export type MarkReadResponse = { unread: number };

export type NotificationListQuery = {
  /** A `nextCursor` from a previous page (opaque). */
  cursor?: string;
  /** 1–50, default 20. */
  limit?: number;
  /** true = unread only. */
  unread?: boolean;
};

// ---- F008: collections ----

export type CollectionVisibility = "public" | "private";

export type CollectionSummary = {
  /** UUID v4 */
  id: string;
  /** 1–60 chars, single line. Plain text. */
  title: string;
  /** 0–500 chars, may contain "
" (at most 8 lines); "" = none. Plain text. */
  description: string;
  visibility: CollectionVisibility;
  owner: UserRef;
  /** Items whose game is visible to the viewer. */
  gameCount: number;
  /** 0–4 thumbnail URLs (server-relative) of the first visible games with a thumbnail, in collection order. */
  coverUrls: string[];
  /** RFC3339 UTC */
  createdAt: string;
  /** RFC3339 UTC; bumped by every successful change. */
  updatedAt: string;
  /** "/c/{id}" (in-app route) */
  path: string;
};

export type CollectionItem = {
  gameId: string;
  /** null: the game is not visible to the viewer (only ever returned to the collection's owner). */
  game: GameSummary | null;
  /** 0–140 chars, single line; "" = none. Plain text. */
  note: string;
  /** RFC3339 UTC */
  addedAt: string;
};

export type Collection = CollectionSummary & {
  /** Collection order; all items (max 100), not paged. */
  items: CollectionItem[];
  /** The viewer owns the collection (false when anonymous). */
  isOwner: boolean;
  /** The viewer is the owner or an admin (false when anonymous). */
  canDelete: boolean;
};

export type MyCollection = CollectionSummary & {
  /** The `gameId` query game is in this collection; false without `gameId`. */
  containsGame: boolean;
  /** All items including unavailable ones (what the 100 cap counts). */
  itemCount: number;
};

export type GameCollectionsPage = {
  items: CollectionSummary[];
  /** Public collections containing the game. */
  total: number;
};

export type CollectionItemResponse = {
  /** true: newly inserted; false: already present (note updated if given). */
  added: boolean;
  item: CollectionItem;
  /** After the change, as the owner sees it. */
  gameCount: number;
  /** The collection's updatedAt after the change. */
  updatedAt: string;
};

export type CollectionRemoveResponse = { removed: boolean; gameCount: number; updatedAt: string };

export type CreateCollectionRequest = {
  title: string;
  description?: string;
  /** default "public" */
  visibility?: CollectionVisibility;
  /** Becomes the first item (empty note). */
  gameId?: string;
};

export type UpdateCollectionRequest = { title?: string; description?: string; visibility?: CollectionVisibility };

/** An absent `note` keeps the stored note. */
export type PutCollectionGameRequest = { note?: string };

export type ReorderCollectionRequest = { gameIds: string[] };
