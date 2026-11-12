import type {
  ApiErrorCode,
  AuthResponse,
  Comment,
  CreateGameInput,
  Game,
  GameSummary,
  HealthResponse,
  ListGamesQuery,
  LoginRequest,
  Page,
  PageQuery,
  PlayResponse,
  PreviewTokenResponse,
  RatingResponse,
  RegisterRequest,
  Score,
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
  500: "internal",
  503: "unavailable",
};

/** Error thrown by every ApiClient method on a non-2xx response or a network failure. */
export class ApiError extends Error {
  readonly code: ApiErrorCode | (string & {});
  /** HTTP status; 0 for network errors. */
  readonly status: number;

  constructor(code: ApiErrorCode | (string & {}), message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }

  static fromResponse(status: number, body: unknown, statusText = ""): ApiError {
    const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code =
      err && typeof err.code === "string" ? err.code : STATUS_CODES[status] ?? (status >= 500 ? "internal" : "unknown");
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
};

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
    if (!res.ok) throw ApiError.fromResponse(res.status, body, res.statusText);
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
          reject(ApiError.fromResponse(xhr.status, body, xhr.statusText));
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
  getUser(username: string): Promise<UserProfileResponse> {
    return this.request(`/api/users/${encodeURIComponent(username)}`);
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
    return this.upload("POST", "/api/games", form, onProgress);
  }
  updateGame(id: string, body: UpdateGameRequest): Promise<Game> {
    return this.request(`/api/games/${encodeURIComponent(id)}`, { method: "PATCH", json: body });
  }
  replaceBundle(id: string, bundle: Blob, onProgress?: UploadProgress): Promise<Game> {
    const form = new FormData();
    form.append("bundle", bundle, fileName(bundle, "bundle.zip"));
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
  listScores(id: string, limit?: number): Promise<Score[]> {
    return this.request(`/api/games/${encodeURIComponent(id)}/scores`, { query: { limit } });
  }
  submitScore(id: string, score: number): Promise<Score> {
    return this.request(`/api/games/${encodeURIComponent(id)}/scores`, { method: "POST", json: { score } });
  }
  listTags(): Promise<TagCount[]> {
    return this.request("/api/tags");
  }
  health(): Promise<HealthResponse> {
    return this.request("/api/health");
  }
}

function fileName(b: Blob, fallback: string): string {
  const n = (b as File).name;
  return typeof n === "string" && n ? n : fallback;
}
