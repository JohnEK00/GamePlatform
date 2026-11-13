# REST API contract (v1)

Base URL: `{API}` (default `http://localhost:8080`). All JSON endpoints live under `/api`. JSON bodies, `camelCase` field names.
Auth: `Authorization: Bearer <jwt>` (HS256, 7-day expiry). 🔒 = auth required, 🔓 = auth optional (adds personalised fields).

## Errors
Non-2xx responses: `{ "error": { "code": "string", "message": "human readable" } }`
Codes: `bad_request` 400, `validation` 422, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `payload_too_large` 413, `internal` 500, `unavailable` 503 (e.g. engine runtime not built).

## Types
```ts
type UserRef   = { id: string; username: string; displayName: string; avatarUrl: string | null }
type User      = UserRef & { bio: string; createdAt: string /*RFC3339*/ }
type AuthResponse = { token: string; user: User }

type GameSummary = {
  id: string; title: string; description: string; tags: string[];
  owner: UserRef; thumbnailUrl: string | null;   // absolute path e.g. "/media/thumbnails/{id}.png?v=3"
  plays: number; ratingAvg: number; ratingCount: number;
  published: boolean; createdAt: string; updatedAt: string;
}
type Game = GameSummary & {
  width: number; height: number;   // from game.json
  version: number;                 // increments on each bundle upload
  entry: string;                   // from game.json
  playUrl: string;                 // "/play/{id}"
  myRating: number | null;         // 🔓 only when authed
  isOwner: boolean;                // 🔓
}
type Page<T> = { items: T[]; total: number; page: number; perPage: number }
type Comment = { id: string; gameId: string; author: UserRef; body: string; createdAt: string }
type Score   = { id: string; user: UserRef; score: number; createdAt: string; rank: number }
type TagCount = { tag: string; count: number }
```
IDs are UUID v4 strings. Usernames: 3–24 chars `[a-zA-Z0-9_]`, unique case-insensitive. Password ≥ 8 chars.

## Auth
| Method | Path | Body | Response |
|---|---|---|---|
| POST | /api/auth/register | `{username, email, password}` | 201 `AuthResponse` (409 if taken) |
| POST | /api/auth/login | `{login /*username or email*/, password}` | 200 `AuthResponse` (401 on bad creds) |
| GET 🔒 | /api/auth/me | – | `User` |

## Users
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/users/{username} | – | `{ user: User, games: GameSummary[] }` (published only unless it's you) |
| PATCH 🔒 | /api/users/me | `{displayName?, bio?}` | `User` |
| PUT 🔒 | /api/users/me/avatar | multipart `avatar` (png/jpg/webp ≤ 2MB) | `User` |

## Games
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET 🔓 | /api/games | `?q=&tag=&owner=&sort=new\|popular\|top&page=1&perPage=24` (perPage max 100) | `Page<GameSummary>` (published only; `owner=me` → your games incl. unpublished) |
| GET 🔓 | /api/games/{id} | – | `Game` (unpublished → 404 unless owner) |
| POST 🔒 | /api/games | multipart: `title` (1–80), `description` (≤ 5000), `tags` (comma-separated, ≤ 8, each ≤ 24, lowercased), `published` ("true"/"false", default true), `bundle` (zip, required, ≤ 50MB), `thumbnail` (optional png/jpg/webp ≤ 2MB) | 201 `Game` |
| PATCH 🔒 owner | /api/games/{id} | `{title?, description?, tags?: string[], published?}` | `Game` |
| PUT 🔒 owner | /api/games/{id}/bundle | multipart `bundle` | `Game` (version+1) |
| PUT 🔒 owner | /api/games/{id}/thumbnail | multipart `thumbnail` | `Game` |
| DELETE 🔒 owner | /api/games/{id} | – | 204 (removes files too) |
| POST 🔒 owner | /api/games/{id}/preview-token | – | `{ token, expiresAt }` — JWT valid 10 min, claims `{scope:"preview", gid:id, sub}`; ONLY usable for `/play/{id}?token=` |
| POST | /api/games/{id}/play | – | `{ plays: number }` |
| PUT 🔒 | /api/games/{id}/rating | `{ score: 1..5 }` | `{ ratingAvg, ratingCount, myRating }` |
| DELETE 🔒 | /api/games/{id}/rating | – | `{ ratingAvg, ratingCount, myRating: null }` |
| GET | /api/games/{id}/comments | `?page=&perPage=` | `Page<Comment>` newest first |
| POST 🔒 | /api/games/{id}/comments | `{ body }` (1–2000) | 201 `Comment` |
| DELETE 🔒 | /api/comments/{id} | – (comment author or game owner) | 204 |
| GET | /api/games/{id}/scores | `?limit=10` (max 100) | `Score[]` best score per user, desc |
| POST 🔒 | /api/games/{id}/scores | `{ score: number }` (finite, integer-ish i64) | 201 `Score` |
| GET | /api/tags | – | `TagCount[]` top 50 |
| GET | /api/health | – | `{ status: "ok", version }` |

## Non-API routes (all with `Access-Control-Allow-Origin: *`)
| Path | What |
|---|---|
| GET /play/{id} | Player HTML page (see GAME_FORMAT.md). `?v=` ignored. Unpublished games → 404 unless `?token=` is a valid **preview-scoped** token for this game id (session tokens are rejected there, so the owner's real JWT never enters the untrusted iframe). |
| GET /runtime/engine.js | Built engine (`packages/engine/dist/engine.js`, path from env `ENGINE_DIST`) |
| GET /games/{id}/files/{*path} | Extracted bundle files of the current version, correct MIME types, `Cache-Control: no-cache`, `CSP: sandbox`, `nosniff`. Served without auth even for unpublished games (the preview iframe can't send credentials); ids are unguessable UUIDs. |
| GET /media/thumbnails/{file}, /media/avatars/{file} | Uploaded images |

When `WEB_DIST` is set, any GET not matched above (including `/games/{id}` and `/games/{id}/edit`, which are SPA routes) falls back to `index.html`. Only `/games/{id}/files/*` is backend-owned under `/games`.

## CORS
`/api/*`: allow any origin listed in env `CORS_ORIGINS` (comma list; default `http://localhost:5173,http://localhost:1420,http://tauri.localhost,tauri://localhost`), methods GET/POST/PUT/PATCH/DELETE, headers Authorization + Content-Type.

## Backend env
`PORT` (8080), `DATABASE_URL` (`sqlite://data/webgame.db?mode=rwc`), `DATA_DIR` (`data`), `JWT_SECRET` (dev default with a warning), `ENGINE_DIST` (`../packages/engine/dist`), `WEB_DIST` (optional; serve SPA), `CORS_ORIGINS`, `PUBLIC_ORIGIN` (optional, e.g. `https://arcade.example.com`; when set, `/play` uses it as `{ORIGIN}` instead of the request `Host` header — recommended in production).


---

# v2 additions

All v1 rules apply (camelCase, error shape, auth markers). New error code: `rate_limited` 429 (with `Retry-After` header, seconds).

## Changed types
```ts
type User = UserRef & { bio: string; createdAt: string; role: "user" | "admin" }   // + role
type GameSummary = { ...v1, favorites: number }                                     // + favorites
type Game = { ...v1, isFavorite: boolean /*🔓, false when anon*/, achievements: AchievementDef[] }
type AchievementDef = { id: string; name: string; description: string; iconUrl: string | null /* server-relative */ }
```
Admins are users whose username is listed in env `ADMIN_USERNAMES` (comma list, case-insensitive), applied at startup and on register.

## Favorites
| Method | Path | Body | Response |
|---|---|---|---|
| PUT 🔒 | /api/games/{id}/favorite | – | `{ favorited: true, favorites: number }` (idempotent) |
| DELETE 🔒 | /api/games/{id}/favorite | – | `{ favorited: false, favorites: number }` |
| GET 🔒 | /api/users/me/favorites | `?page=&perPage=` | `Page<GameSummary>` newest favorite first |

`GET /api/games` gains `sort=favorites`.

## Achievements (definitions come from game.json, see GAME_FORMAT.md)
```ts
type GameAchievement = AchievementDef & { unlockedBy: number; unlockedAt: string | null /*🔓 mine*/ }
type UserAchievement = AchievementDef & { gameId: string; gameTitle: string; unlockedAt: string }
```
| Method | Path | Body | Response |
|---|---|---|---|
| GET 🔓 | /api/games/{id}/achievements | – | `GameAchievement[]` in game.json order |
| POST 🔒 | /api/games/{id}/achievements/{achievementId} | – | `{ achievement: UserAchievement, new: boolean }` (404 if the id is not defined by the CURRENT version; idempotent) |
| GET | /api/users/{username}/achievements | `?limit=50` (max 100) | `UserAchievement[]` most recent first |

## Cloud saves (per user per game, max 256KB JSON object)
| Method | Path | Body | Response |
|---|---|---|---|
| GET 🔒 | /api/games/{id}/save | – | `{ data: object or null, updatedAt: string or null }` |
| PUT 🔒 | /api/games/{id}/save | `{ data: object }` | `{ updatedAt }` (413 if > 256KB, 422 if not a plain object) |
| DELETE 🔒 | /api/games/{id}/save | – | 204 |

## Analytics (plays are now also recorded as events with a UTC date)
```ts
type DailyPlays = { date: string /*YYYY-MM-DD UTC*/; plays: number }   // always 30 entries, oldest first, zero-filled
type CreatorStats = { totals: { games: number; published: number; plays: number; favorites: number; comments: number; ratingCount: number; ratingAvg: number /*weighted across games, 0 if none*/ }; daily: DailyPlays[] }
type GameStats = { plays: number; favorites: number; comments: number; uniquePlayers: number /*distinct users with a score, save or achievement*/; daily: DailyPlays[] }
```
| Method | Path | Response |
|---|---|---|
| GET 🔒 | /api/users/me/stats | `CreatorStats` |
| GET 🔒 owner | /api/games/{id}/stats | `GameStats` |

## Moderation
```ts
type ReportReason = "spam" | "offensive" | "broken" | "copyright" | "other"
type Report = { id: string; targetType: "game" | "comment"; targetId: string; targetPreview: string /*game title or first 140 chars of comment*/; targetGameId: string; reason: ReportReason; details: string; reporter: UserRef; status: "open" | "resolved"; resolution: "dismiss" | "unpublish" | "delete" | null; createdAt: string; resolvedAt: string | null }
```
| Method | Path | Body | Response |
|---|---|---|---|
| POST 🔒 | /api/reports | `{ targetType, targetId, reason, details? (max 1000) }` | 201 `Report` (409 if the same user already has an open report on that target) |
| GET 🔒 admin | /api/admin/reports | `?status=open or resolved&page=&perPage=` | `Page<Report>` |
| POST 🔒 admin | /api/admin/reports/{id}/resolve | `{ action: "dismiss" / "unpublish" / "delete" }` | `Report` (unpublish only valid for games; delete removes the game/comment; resolves all open reports on the same target) |

Non-admins get 403 on /api/admin/*.

## Rate limits
Per client IP for anonymous requests, per user id when authed; in-memory token buckets.
- login + register: 10/min per IP
- game create + bundle replace: 20/hour
- comments: 30 per 10 min
- reports: 10/hour
- score submit: 60/min
- save PUT: 60/min

Exceeding → 429 `rate_limited` + `Retry-After`. Disable with `RATE_LIMIT=off` (tests).

## Studio player
`GET /play/studio`: player HTML for unsaved projects (same CSP/sandbox headers as /play/{id}, `Access-Control-Allow-Origin: *`). See GAME_FORMAT.md "Studio protocol".
