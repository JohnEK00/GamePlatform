import type {
  ApiErrorCode,
  AuthResponse,
  CloudSave,
  Comment,
  CreateGameInput,
  CreateReportRequest,
  CreatorStats,
  FavoriteResponse,
  FeedPage,
  FeedQuery,
  FollowResponse,
  SuggestedCreator,
  UserRef,
  Game,
  GameAchievement,
  GameStats,
  GameVersion,
  ListReportsQuery,
  PutSaveResponse,
  Report,
  ReportAction,
  UnlockAchievementResponse,
  UserAchievement,
  GameSummary,
  HealthResponse,
  ListGamesQuery,
  LoginRequest,
  Page,
  RelatedGame,
  PageQuery,
  PlayResponse,
  PreviewTokenResponse,
  RatingResponse,
  RegisterRequest,
  Score,
  ScoreSubmitResult,
  Leaderboard,
  LeaderboardPeriod,
  LeaderboardQuery,
  TagCount,
  UpdateGameRequest,
  UpdateMeRequest,
  UploadProgress,
  User,
  UserProfileResponse,
} from "./types";

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  422: "validation",
  429: "rate_limited",
  500: "internal",
  503: "unavailable",
};

/** Parses a Retry-After header (delta-seconds or HTTP date) into whole seconds (>= 1), or undefined. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.max(1, Math.ceil(Number(v)));
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(1, Math.ceil((t - now) / 1000));
}

/** Human message for a 429 response. */
export function rateLimitMessage(retryAfter: number | undefined): string {
  return retryAfter ? `Slow down, try again in ${retryAfter}s.` : "Slow down, try again in a moment.";
}

/** Error thrown by every ApiClient method on a non-2xx response or a network failure. */
export class ApiError extends Error {
  readonly code: ApiErrorCode | (string & {});
  /** HTTP status; 0 for network errors. */
  readonly status: number;
  /** Seconds to wait before retrying (429 `rate_limited` responses with a Retry-After header). */
  readonly retryAfter?: number;

  constructor(code: ApiErrorCode | (string & {}), message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }

  /** `retryAfterHeader` is the raw Retry-After header value, if any. */
  static fromResponse(status: number, body: unknown, statusText = "", retryAfterHeader?: string | null): ApiError {
    const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code =
      err && typeof err.code === "string" ? err.code : STATUS_CODES[status] ?? (status >= 500 ? "internal" : "unknown");
    if (status === 429 || code === "rate_limited") {
      const retryAfter = parseRetryAfter(retryAfterHeader);
      return new ApiError("rate_limited", rateLimitMessage(retryAfter), status, retryAfter);
    }
    const message =
      err && typeof err.message === "string" && err.message
        ? err.message
        : statusText || `Request failed with status ${status}`;
    return new ApiError(code, message, status);
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export type ApiClientOptions = {
  /** API origin, e.g. "http://localhost:8080". Empty string = same origin. */
  baseUrl: string;
  token?: string | null;
  /** Custom fetch implementation (defaults to the global fetch at call time). */
  fetch?: typeof fetch;
};

type Query = Record<string, string | number | boolean | null | undefined>;

/** Builds "?a=1&b=2", skipping undefined/null/"" values. Returns "" if nothing to add. */
export function buildQuery(q: Query | undefined): string {
  if (!q) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Resolves a server-relative URL ("/media/x.png") against an API base URL. Absolute URLs pass through. */
export function resolveApiUrl(baseUrl: string, path: string): string;
export function resolveApiUrl(baseUrl: string, path: string | null | undefined): string | null;
export function resolveApiUrl(baseUrl: string, path: string | null | undefined): string | null {
  if (path == null || path === "") return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return path;
  const base = baseUrl.replace(/\/+$/, "");
  return base + (path.startsWith("/") ? path : `/${path}`);
}

type RequestOptions = {
  method?: string;
  query?: Query;
  json?: unknown;
  signal?: AbortSignal;
  /** Use `fetch` keepalive when the body fits the browser's keepalive quota (see KEEPALIVE_MAX_BODY_BYTES). */
  keepalive?: boolean;
};

/**
 * Largest request body sent with `keepalive: true`. Browsers cap the bodies of all in-flight keepalive
 * requests at 64 KiB; we leave a little room for other keepalive traffic and fall back to a normal fetch above it.
 */
export const KEEPALIVE_MAX_BODY_BYTES = 60 * 1024;

/** Typed client for the WebGameApp REST API (docs/API.md). */
export class ApiClient {
  baseUrl: string;
  token: string | null;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetch;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  /** Resolve a server-relative URL (thumbnailUrl, avatarUrl, playUrl, ...) against baseUrl. */
  url(path: string): string;
  url(path: string | null | undefined): string | null;
  url(path: string | null | undefined): string | null {
    return resolveApiUrl(this.baseUrl, path);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Low-level JSON request. Returns undefined for 204. */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const f = this.fetchImpl ?? globalThis.fetch;
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers: this.headers(opts.json !== undefined ? { "Content-Type": "application/json" } : undefined),
      signal: opts.signal,
    };
    if (opts.json !== undefined) init.body = JSON.stringify(opts.json);
    if (opts.keepalive) {
      const size = typeof init.body === "string" ? new TextEncoder().encode(init.body).length : 0;
      if (size <= KEEPALIVE_MAX_BODY_BYTES) init.keepalive = true;
    }
    let res: Response;
    try {
      res = await f(this.baseUrl + path + buildQuery(opts.query), init);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      throw new ApiError("network", "Could not reach the server. Check your connection.", 0);
    }
    const text = res.status === 204 ? "" : await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError("unknown", "The server sent an invalid response.", res.status);
      }
    }
    if (!res.ok) throw ApiError.fromResponse(res.status, body, res.statusText, res.headers?.get?.("Retry-After"));
    return body as T;
  }

  /** Multipart upload via XMLHttpRequest (for upload progress). */
  upload<T>(method: "POST" | "PUT", path: string, form: FormData, onProgress?: UploadProgress): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, this.baseUrl + path);
      const headers = this.headers();
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          const total = e.lengthComputable ? e.total : 0;
          onProgress({ loaded: e.loaded, total, fraction: total ? e.loaded / total : 0 });
        };
      }
      xhr.onerror = () => reject(new ApiError("network", "Upload failed: could not reach the server.", 0));
      xhr.onabort = () => reject(new ApiError("network", "Upload aborted.", 0));
      xhr.onload = () => {
        let body: unknown = undefined;
        if (xhr.responseText) {
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            /* ignore */
          }
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.({ loaded: 1, total: 1, fraction: 1 });
          resolve(body as T);
        } else {
          let retryAfter: string | null = null;
          try {
            retryAfter = xhr.getResponseHeader("Retry-After");
          } catch {
            /* header not exposed */
          }
          reject(ApiError.fromResponse(xhr.status, body, xhr.statusText, retryAfter));
        }
      };
      xhr.send(form);
    });
  }

  // ---------- Auth ----------
  register(body: RegisterRequest): Promise<AuthResponse> {
    return this.request("/api/auth/register", { method: "POST", json: body });
  }
  login(body: LoginRequest): Promise<AuthResponse> {
    return this.request("/api/auth/login", { method: "POST", json: body });
  }
  me(): Promise<User> {
    return this.request("/api/auth/me");
  }

  // ---------- Users ----------
  /** `query` pages the profile's `games` list (server default 24 per page). */
  getUser(username: string, query: PageQuery = {}): Promise<UserProfileResponse> {
    return this.request(`/api/users/${encodeURIComponent(username)}`, { query: { page: query.page, perPage: query.perPage } });
  }
  updateMe(body: UpdateMeRequest): Promise<User> {
    return this.request("/api/users/me", { method: "PATCH", json: body });
  }
  uploadAvatar(avatar: Blob, onProgress?: UploadProgress): Promise<User> {
    const form = new FormData();
    form.append("avatar", avatar, fileName(avatar, "avatar"));
    return this.upload("PUT", "/api/users/me/avatar", form, onProgress);
  }

  // ---------- Games ----------
  listGames(query: ListGamesQuery = {}, signal?: AbortSignal): Promise<Page<GameSummary>> {
    return this.request("/api/games", { query, signal });
  }
  /** F003: "More like this" for a game (`limit` 1–24 server-side, default 8). */
  getRelatedGames(id: string, query: { limit?: number } = {}, signal?: AbortSignal): Promise<RelatedGame[]> {
    return this.request(`/api/games/${encodeURIComponent(id)}/related`, { query: { limit: query.limit }, signal });
  }
  getGame(id: string): Promise<Game> {
    return this.request(`/api/games/${encodeURIComponent(id)}`);
  }
  createGame(input: CreateGameInput, onProgress?: UploadProgress): Promise<Game> {
    const form = new FormData();
    form.append("title", input.title);
    form.append("description", input.description ?? "");
    form.append("tags", (input.tags ?? []).join(","));
    form.append("published", input.published === false ? "false" : "true");
    form.append("bundle", input.bundle, fileName(input.bundle, "bundle.zip"));
    if (input.thumbnail) form.append("thumbnail", input.thumbnail, fileName(input.thumbnail, "thumbnail"));
    if (input.notes && input.notes.trim()) form.append("notes", input.notes);
    return this.upload("POST", "/api/games", form, onProgress);
  }
  updateGame(id: string, body: UpdateGameRequest): Promise<Game> {
    return this.request(`/api/games/${encodeURIComponent(id)}`, { method: "PATCH", json: body });
  }
  /**
   * F004: `opts.notes` (sent when non-empty after trim) and `opts.expectedVersion` (the version the page was
   * based on; a mismatch returns 409 `conflict`).
   */
  replaceBundle(
    id: string,
    bundle: Blob,
    onProgress?: UploadProgress,
    opts: { notes?: string; expectedVersion?: number } = {},
  ): Promise<Game> {
    const form = new FormData();
    form.append("bundle", bundle, fileName(bundle, "bundle.zip"));
    if (opts.notes && opts.notes.trim()) form.append("notes", opts.notes);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== null) {
      form.append("expectedVersion", String(Math.trunc(opts.expectedVersion)));
    }
    return this.upload("PUT", `/api/games/${encodeURIComponent(id)}/bundle`, form, onProgress);
  }
  replaceThumbnail(id: string, thumbnail: Blob, onProgress?: UploadProgress): Promise<Game> {
    const form = new FormData();
    form.append("thumbnail", thumbnail, fileName(thumbnail, "thumbnail"));
    return this.upload("PUT", `/api/games/${encodeURIComponent(id)}/thumbnail`, form, onProgress);
  }
  deleteGame(id: string): Promise<void> {
    return this.request(`/api/games/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  recordPlay(id: string): Promise<PlayResponse> {
    return this.request(`/api/games/${encodeURIComponent(id)}/play`, { method: "POST" });
  }
  /** Owner-only: mint a short-lived preview token for an unpublished game. Never put the session token in an iframe URL. */
  createPreviewToken(id: string): Promise<PreviewTokenResponse> {
    return this.request(`/api/games/${encodeURIComponent(id)}/preview-token`, { method: "POST" });
  }
  rateGame(id: string, score: number): Promise<RatingResponse> {
    return this.request(`/api/games/${encodeURIComponent(id)}/rating`, { method: "PUT", json: { score } });
  }
  clearRating(id: string): Promise<RatingResponse> {
    return this.request(`/api/games/${encodeURIComponent(id)}/rating`, { method: "DELETE" });
  }
  listComments(id: string, query: PageQuery = {}): Promise<Page<Comment>> {
    return this.request(`/api/games/${encodeURIComponent(id)}/comments`, { query });
  }
  postComment(id: string, body: string): Promise<Comment> {
    return this.request(`/api/games/${encodeURIComponent(id)}/comments`, { method: "POST", json: { body } });
  }
  deleteComment(commentId: string): Promise<void> {
    return this.request(`/api/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
  }
  listScores(id: string, limit?: number, period?: LeaderboardPeriod): Promise<Score[]> {
    return this.request(`/api/games/${encodeURIComponent(id)}/scores`, { query: { limit, period } });
  }
  /** F001: per-period leaderboard with the viewer's own row and a player count. */
  getLeaderboard(id: string, query: LeaderboardQuery = {}, signal?: AbortSignal): Promise<Leaderboard> {
    return this.request(`/api/games/${encodeURIComponent(id)}/leaderboard`, {
      query: { period: query.period, limit: query.limit },
      signal,
    });
  }
  /** F001: returns a ScoreSubmitResult (a superset of Score). */
  submitScore(id: string, score: number): Promise<ScoreSubmitResult> {
    return this.request(`/api/games/${encodeURIComponent(id)}/scores`, { method: "POST", json: { score } });
  }
  listTags(): Promise<TagCount[]> {
    return this.request("/api/tags");
  }
  health(): Promise<HealthResponse> {
    return this.request("/api/health");
  }

  // ---------- v2: Favorites ----------
  favoriteGame(id: string): Promise<FavoriteResponse> {
    return this.request(`/api/games/${encodeURIComponent(id)}/favorite`, { method: "PUT" });
  }
  unfavoriteGame(id: string): Promise<FavoriteResponse> {
    return this.request(`/api/games/${encodeURIComponent(id)}/favorite`, { method: "DELETE" });
  }
  /** Convenience: PUT or DELETE depending on `favorite`. */
  setFavorite(id: string, favorite: boolean): Promise<FavoriteResponse> {
    return favorite ? this.favoriteGame(id) : this.unfavoriteGame(id);
  }
  listMyFavorites(query: PageQuery = {}): Promise<Page<GameSummary>> {
    return this.request("/api/users/me/favorites", { query });
  }

  // ---------- v2: Achievements ----------
  listGameAchievements(id: string): Promise<GameAchievement[]> {
    return this.request(`/api/games/${encodeURIComponent(id)}/achievements`);
  }
  unlockAchievement(id: string, achievementId: string): Promise<UnlockAchievementResponse> {
    return this.request(`/api/games/${encodeURIComponent(id)}/achievements/${encodeURIComponent(achievementId)}`, { method: "POST" });
  }
  listUserAchievements(username: string, limit?: number): Promise<UserAchievement[]> {
    return this.request(`/api/users/${encodeURIComponent(username)}/achievements`, { query: { limit } });
  }

  // ---------- v2: Cloud saves ----------
  getSave(id: string, signal?: AbortSignal): Promise<CloudSave> {
    return this.request(`/api/games/${encodeURIComponent(id)}/save`, { signal });
  }
  /**
   * `opts.keepalive`: send with `fetch(…, { keepalive: true })` so the request survives the page being closed
   * (use it for the pagehide / unmount flush). Bodies over {@link KEEPALIVE_MAX_BODY_BYTES} can't use keepalive
   * (browser quota) and go out as a normal request instead.
   */
  putSave(id: string, data: Record<string, unknown>, opts: { keepalive?: boolean } = {}): Promise<PutSaveResponse> {
    return this.request(`/api/games/${encodeURIComponent(id)}/save`, { method: "PUT", json: { data }, keepalive: opts.keepalive });
  }
  deleteSave(id: string): Promise<void> {
    return this.request(`/api/games/${encodeURIComponent(id)}/save`, { method: "DELETE" });
  }

  // ---------- v2: Analytics ----------
  getMyStats(): Promise<CreatorStats> {
    return this.request("/api/users/me/stats");
  }
  getGameStats(id: string): Promise<GameStats> {
    return this.request(`/api/games/${encodeURIComponent(id)}/stats`);
  }

  // ---------- v2: Moderation ----------
  createReport(body: CreateReportRequest): Promise<Report> {
    return this.request("/api/reports", { method: "POST", json: body });
  }
  listReports(query: ListReportsQuery = {}): Promise<Page<Report>> {
    return this.request("/api/admin/reports", { query });
  }
  resolveReport(reportId: string, action: ReportAction): Promise<Report> {
    return this.request(`/api/admin/reports/${encodeURIComponent(reportId)}/resolve`, { method: "POST", json: { action } });
  }

  // ---------- F002: Follows & feed ----------
  followUser(username: string): Promise<FollowResponse> {
    return this.request(`/api/users/${encodeURIComponent(username)}/follow`, { method: "PUT" });
  }
  unfollowUser(username: string): Promise<FollowResponse> {
    return this.request(`/api/users/${encodeURIComponent(username)}/follow`, { method: "DELETE" });
  }
  /** Convenience: PUT or DELETE depending on `follow`. */
  setFollowing(username: string, follow: boolean): Promise<FollowResponse> {
    return follow ? this.followUser(username) : this.unfollowUser(username);
  }
  listFollowers(username: string, query: PageQuery = {}): Promise<Page<UserRef>> {
    return this.request(`/api/users/${encodeURIComponent(username)}/followers`, { query: { page: query.page, perPage: query.perPage } });
  }
  listFollowing(username: string, query: PageQuery = {}): Promise<Page<UserRef>> {
    return this.request(`/api/users/${encodeURIComponent(username)}/following`, { query: { page: query.page, perPage: query.perPage } });
  }
  /** Newest first. `kinds` is sent comma-separated and omitted when empty. */
  getFeed(query: FeedQuery = {}, signal?: AbortSignal): Promise<FeedPage> {
    const kinds = query.kinds && query.kinds.length > 0 ? query.kinds.join(",") : undefined;
    return this.request("/api/feed", { query: { cursor: query.cursor, limit: query.limit, kinds }, signal });
  }
  getFeedSuggestions(): Promise<SuggestedCreator[]> {
    return this.request("/api/feed/suggestions");
  }

  // ---------- F004: Version history ----------
  /** Highest version first; server default 20 per page (max 100). */
  listGameVersions(id: string, query: PageQuery = {}): Promise<Page<GameVersion>> {
    return this.request(`/api/games/${encodeURIComponent(id)}/versions`, { query: { page: query.page, perPage: query.perPage } });
  }
  /** Owner-only: fix a version's release notes. */
  updateVersionNotes(id: string, version: number, notes: string): Promise<GameVersion> {
    return this.request(`/api/games/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}`, {
      method: "PATCH",
      json: { notes },
    });
  }
}

function fileName(b: Blob, fallback: string): string {
  const n = (b as File).name;
  return typeof n === "string" && n ? n : fallback;
}
