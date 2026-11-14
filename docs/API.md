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
`PORT` (8080), `DATABASE_URL` (`sqlite://data/webgame.db?mode=rwc`), `DATA_DIR` (`data`), `JWT_SECRET` (dev default with a warning), `ENGINE_DIST` (`../packages/engine/dist`), `WEB_DIST` (optional; serve SPA), `CORS_ORIGINS`, `ADMIN_USERNAMES` (comma list; register those accounts BEFORE listing them, or anyone can claim an unregistered name), `RATE_LIMIT` (`off` disables), `TRUST_PROXY` (number of trusted reverse-proxy hops; `true` = 1; client IP = n-th X-Forwarded-For entry from the right), `PUBLIC_ORIGIN` (optional, e.g. `https://arcade.example.com`; when set, `/play` uses it as `{ORIGIN}` instead of the request `Host` header — recommended in production).


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


---

## F001 additions

Leaderboards 2.0 (spec: `docs/features/F001-leaderboards-2.md`). All earlier rules apply.

### Types
```ts
type LeaderboardPeriod = "day" | "week" | "all"
type LeaderboardConfig = {
  order: "desc" | "asc";        // "desc": higher is better (default); "asc": lower is better
  format: "number" | "time";    // "time": score is milliseconds (default "number")
  label: string;                // column label, "" = UI default; max 24 chars
}
type Game = { ...v2, leaderboard: LeaderboardConfig }   // + leaderboard (from game.json; defaults when absent)

type Leaderboard = {
  period: LeaderboardPeriod;
  periodStart: string | null;   // RFC3339 UTC (ms, "Z"), inclusive; null for "all"
  periodEnd: string | null;     // RFC3339 UTC, exclusive; null for "all"
  config: LeaderboardConfig;
  entries: Score[];             // each user's best score inside the window, best first; Score.rank = rank in this window
  totalPlayers: number;         // distinct users with >= 1 score in the window
  me: Score | null;             // 🔓 the viewer's best in the window with its rank; null if anonymous or no score
}

type ScoreSubmitResult = Score & {   // superset of v1 Score; `rank` keeps its v1 meaning (all-time rank of THIS score among other users' bests)
  personalBest: boolean;             // true if this is the user's first score, or strictly better than their previous all-time best (per order)
  ranks: { day: number; week: number; all: number };   // rank of the user's best score in each window, after this submit
}
```

### Periods and ranking
- `day` = [today 00:00:00.000Z, tomorrow 00:00:00.000Z).
- `week` = ISO week: [Monday 00:00:00.000Z, next Monday 00:00:00.000Z).
- `all` has no bounds.
- A score belongs to the window that contains its `createdAt`. Server time is the source of truth.
- "Best" is `MAX(score)` for `desc` and `MIN(score)` for `asc`. On equal scores the earlier `createdAt` is listed first.
- Ranks use competition ranking (1, 2, 2, 4).

### Endpoints
| Method | Path | Query / Body | Response |
|---|---|---|---|
| GET 🔓 | /api/games/{id}/leaderboard | `?period=day\|week\|all` (default `all`) `&limit=10` (1–100, clamped) | `Leaderboard` |
| GET 🔓 | /api/games/{id}/scores | v1 query + `period` (default `all`) | `Score[]`, now honours `order` and `period` (same as `Leaderboard.entries`) |
| POST 🔒 | /api/games/{id}/scores | `{ score }` (v1 rules) | 201 `ScoreSubmitResult` |

- An invalid `period` → 400 `bad_request`, and a non-integer `limit` → 400 (same as v1 `/scores`).
- Visibility follows `GET /api/games/{id}`: an unpublished game → 404 unless the viewer is the owner.
- `POST …/scores` on a `format: "time"` game: the score must satisfy 0 ≤ score ≤ 86400000 (24h in ms), else 422 `validation`.

### Rate limits
- Leaderboard reads (`GET …/leaderboard`): 120/min, per user when authenticated and per IP otherwise.
- `GET …/scores` is unchanged (unlimited).
- Score submits keep the existing 60/min.


---

## F002 additions

Follow creators and an activity feed (spec: `docs/features/F002-follow-and-feed.md`). All earlier rules apply, including F001.

### Types
```ts
type FollowResponse = { following: boolean; followers: number /* the target's follower count after the change */ }

type UserProfileResponse = {      // GET /api/users/{username}; v1 { user, games } + three fields
  user: User; games: GameSummary[];
  followers: number;              // users following this user
  following: number;              // users this user follows
  isFollowing: boolean;           // 🔓 the viewer follows this user; false when anonymous or viewing yourself
}

type FeedItemKind = "gamePublished" | "gameUpdated" | "personalBest" | "achievementUnlocked"
type FeedItem = {
  id: string;                     // opaque cursor value (decimal string)
  kind: FeedItemKind;
  actor: UserRef;                 // the game owner for gamePublished/gameUpdated; the player otherwise
  game: GameSummary;
  reason: "following" | "favorite";   // "favorite": shown only because the viewer favorited the game (gamePublished/gameUpdated only)
  createdAt: string;              // RFC3339 UTC; for coalesced items, the latest occurrence
  version: number | null;         // gamePublished/gameUpdated: the game version at event time; else null
  score: {                        // personalBest only; else null
    value: number;                // the new best
    first: boolean;               // true when it was the actor's first score on this game
    leaderboard: LeaderboardConfig;   // the game's CURRENT config (F001), for formatting
  } | null;
  achievement: (AchievementDef & { count: number /* unlocks by the actor in this game that UTC day, >= 1; this def is the latest */ }) | null;   // achievementUnlocked only
}
type FeedPage = { items: FeedItem[]; nextCursor: string | null }

type SuggestedCreator = {
  user: UserRef;
  reason: "favorited" | "popular";   // "favorited": owns games the viewer favorited
  games: number;                     // their published game count (>= 1)
}
```
Clients must ignore feed items with an unknown `kind` (more kinds may be added later).

### Endpoints
| Method | Path | Query / Body | Response |
|---|---|---|---|
| PUT 🔒 | /api/users/{username}/follow | – | `FollowResponse` `{ following: true }` (idempotent) |
| DELETE 🔒 | /api/users/{username}/follow | – | `FollowResponse` `{ following: false }` (idempotent; 200 even if not following) |
| GET | /api/users/{username}/followers | `?page=1&perPage=24` (max 100) | `Page<UserRef>`, newest follow first |
| GET | /api/users/{username}/following | `?page=1&perPage=24` (max 100) | `Page<UserRef>`, newest follow first |
| GET 🔓 | /api/users/{username} | – | `UserProfileResponse` (now with `followers`, `following`, `isFollowing`) |
| GET 🔒 | /api/feed | `?cursor=&limit=20&kinds=` | `FeedPage`, newest first |
| GET 🔒 | /api/feed/suggestions | – | `SuggestedCreator[]` (0–6 entries) |

- `{username}` is matched case-insensitively; an unknown user → 404 `not_found`.
- Follow yourself → 422 `validation`. Following more than **2000** users → 422 `validation` (only a PUT that would create a new row is refused).
- `/api/feed`:
  - `cursor`: optional, a `FeedItem.id` from a previous page. Returns items strictly older (lower id). Not a positive integer string → 400 `bad_request`.
  - `limit`: 1–50, clamped, default 20. Non-integer → 400.
  - `kinds`: optional comma list of `FeedItemKind`. Empty or absent = all. Any unknown value → 400.
  - `nextCursor` is the last item's `id` when more items exist, else `null`.
- Feed sources (an event is included when **all** apply):
  1. Its actor is a user the viewer follows, **or** its kind is `gamePublished`/`gameUpdated` and the viewer has favorited the game.
  2. The actor is not the viewer.
  3. The game is currently published.
  4. For `achievementUnlocked`, the achievement is still defined by the game's current version.
  When both (1) conditions hold, `reason` is `"following"`.
- `/api/feed/suggestions` returns up to 6 users. It never includes the viewer, users the viewer already follows, or users without a published game:
  1. Owners of games the viewer favorited (`reason: "favorited"`), ranked by the number of their games the viewer favorited, then by most recent favorite.
  2. Filled up with owners ranked by total plays across their published games (`reason: "popular"`).

### Event production (server side; no new client calls)
| Kind | Written when | Coalescing |
|---|---|---|
| `gamePublished` | a game becomes published for the **first time**: `POST /api/games` with `published` true, or `PATCH` unpublished → published while `first_published_at` is null | at most one per game, ever |
| `gameUpdated` | `PUT /api/games/{id}/bundle` succeeds while the game is published | replaces any `gameUpdated` row for the same game from the last 24h |
| `personalBest` | `POST /api/games/{id}/scores` returns `personalBest: true` (F001) on a published game, and the submitter is not the owner | one per (actor, game, UTC day); the latest replaces earlier ones |
| `achievementUnlocked` | `POST /api/games/{id}/achievements/{achId}` returns `new: true` on a published game, and the user is not the owner | one per (actor, game, UTC day); `count` increments, the latest achievement is shown |

- "Replaces" means the old row is deleted and a new one inserted, so the item moves to the top of the feed with a new `id`.
- Writing an event is best effort: a failure is logged and never changes the response of the triggering request.
- Studio sessions make no API calls, so they produce no events.

### Rate limits
- Follow + unfollow (`PUT`/`DELETE …/follow`, shared bucket): 60 per 10 min, per user.
- Feed reads (`GET /api/feed` and `/api/feed/suggestions`, shared bucket): 60/min, per user.
- Follower/following lists and profiles: unlimited (as other public reads).
