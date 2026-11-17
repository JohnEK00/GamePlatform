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
  gamesTotal: number;             // review-fix R12: games visible to the viewer (the `games` array is one page)
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


---

## F003 additions

Trending and "More like this" discovery (spec: `docs/features/F003-trending-and-related.md`). All earlier rules apply, including the review-fix play dedupe and rate limit on `POST /api/games/{id}/play`.

### Types
```ts
type GameSummary = { ...v2, playsWeek: number }   // + playsWeek, on EVERY GameSummary (listings, profile, favorites, feed, related, Game)
type GameSort = "new" | "popular" | "top" | "favorites" | "trending"

type RelatedGame = GameSummary & {
  reason: "tags" | "trending";   // "tags": shares >= 1 tag with the source game; "trending": fill-up
  sharedTags: string[];          // shared tags in the SOURCE game's tag order; [] when reason is "trending"
}
```
- `playsWeek` counts the game's counted (deduplicated) plays by anyone other than its owner, over the 7 UTC days ending today (inclusive).
  - It comes from a snapshot refreshed at most every `TRENDING_TTL_SECS`, so it is **approximate** and may lag behind `plays`.
  - It is `0` when the game has no plays in the window, or when the game is newer than the snapshot.

### Trending score (normative)
For each game, over the window days `d` (today and the 6 previous UTC days, by `play_events.day`):
- `viewers(d)` is the number of distinct viewers with a counted play that day, excluding the owner's authenticated plays.
  - A viewer is the signed-in user. For an anonymous play, it is a secret-keyed hash of the client IP, the same identity the play dedupe uses.
  - Each play recorded before F003 counts as one viewer.
- `trendingScore = Σ_d viewers(d) × (7 − age(d)) / 7`, where `age(today) = 0`. Today weighs 1, and six days ago weighs 1/7.

`trendingScore` is not exposed. It only orders results.

### Endpoints
| Method | Path | Query / Body | Response |
|---|---|---|---|
| GET 🔓 | /api/games | v1/v2 query; `sort` also accepts `trending` | `Page<GameSummary>` |
| GET 🔓 | /api/games/{id}/related | `?limit=8` (1–24, clamped) | `RelatedGame[]` (0..limit items) |

- **`sort=trending`**:
  - Order: `trendingScore` desc, then `playsWeek` desc, `plays` desc, `createdAt` desc, `id`.
  - It combines with `q`, `tag` and `owner` exactly like the other sorts, and `total` doesn't depend on the sort.
  - Games with no plays in the window are still listed (score 0), after the scored ones.
- **Unknown `sort`** → 400 `bad_request` "Unknown sort '…' (expected new, popular, top, favorites or trending)".
- **`/related`**:
  - Source visibility follows `GET /api/games/{id}`: an unknown id → 404, and an unpublished game → 404 unless the viewer is the owner.
  - A non-integer `limit` → 400 `bad_request`.
  - Results are always **published** games, never the source, and at most **2 per owner** (the source's owner included).
  - Ranking:
    1. Games sharing ≥ 1 tag with the source (`reason: "tags"`), ordered by `tagScore` desc, then shared-tag count desc, `trendingScore` desc, `plays` desc, `createdAt` desc, `id`. Here `tagScore = Σ over shared tags of 1 / log2(2 + n(tag))`, where `n(tag)` is the number of published games with that tag. Rarer tags weigh more.
    2. If fewer than `limit` games share a tag, the rest is filled in `sort=trending` order (`reason: "trending"`, `sharedTags: []`).
  - The response is the same for every viewer: nothing is personalised beyond source visibility.

### Rate limits
- No new limits. `/related` and `sort=trending` are unlimited public reads, like other listings.
- Plays keep the review-fix `Limit::Play` and the 10-minute per-viewer dedupe. Only counted plays enter `playsWeek` and the trending score.

### Backend env
`TRENDING_TTL_SECS` (default `600`) is the maximum age of the trending snapshot before a `sort=trending` or `/related` read refreshes it.
- `0` refreshes on every such read (used by tests).
- The snapshot is also refreshed once at startup.
- A non-integer value is a startup error.


## Review-fix additions (REVIEW-2026-11-14-1)

### `POST /api/games/{id}/play` (R2)
- **Rate limit:** 30/min, keyed by user when signed in and by client IP otherwise. Over the limit → 429 `rate_limited` with `Retry-After`. `RATE_LIMIT=off` disables it.
- **Dedupe (always on):** at most one counted play per (game, viewer) per 10 minutes. The viewer key is the same as for the rate limit.
- **Duplicate calls:** still return `200 { plays }` with the current count, but don't increment `plays` or write a play event.
- **Scope:** the dedupe is held in memory per process, so it resets when the server restarts.

### `GET /api/users/{username}` (R12)
- **Paging:** accepts `?page=` (default 1) and `&perPage=` (default 24, clamped 1–100). A non-integer value → 400.
- **Response:** `{ user, games: GameSummary[] /* one page, newest first */, gamesTotal: number /* games visible to the viewer; includes unpublished for the owner */ }`.

### Score retention (R12)
- After each submit, that user's scores for that game are pruned.
- **Kept:** the user's best 20 scores for the game, plus any score younger than 8 days that is the user's best of its UTC day or ISO week.
- **Effect:** day, week and all-time boards are unchanged by pruning.

### Game and runtime files (R6)
- **Caching:** responses carry a strong `ETag`. `If-None-Match` → 304 with the same security headers. `Cache-Control: no-cache` stays, so browsers revalidate.

### Bundles (R8)
- A zip that contains both a file `x` and a folder `x/` (case-insensitive) → 422.

### Ops
- **Health check:** `webgame-server healthcheck` exits 0 when `GET /api/health` on `127.0.0.1:$PORT` returns 200. The Docker `HEALTHCHECK` uses it.
- **Shutdown:** graceful on SIGTERM and Ctrl+C.
- **Startup cleanup:** stale `.staging-*` folders and orphaned game folders are removed.


---

## F004 additions

Version changelogs and an "Updated" badge (spec: `docs/features/F004-version-changelogs.md`). All earlier rules apply, including F002 (feed) and the review-fix bundle replace serialisation (R1).

### Types
```ts
type GameVersion = {
  version: number;                // >= 1
  notes: string;                  // plain text, 0–1000 chars, "\n" line breaks; "" = no notes
  createdAt: string;              // RFC3339 UTC: when this version went live (upload / replace time)
  current: boolean;               // version === the game's current version
}

type GameSummary = { ...F003, lastUpdatedAt: string | null }
// lastUpdatedAt: RFC3339 UTC of the latest bundle replace made while the game was PUBLISHED; null if none.
// Not changed by metadata PATCHes, thumbnail changes, publishing, or notes edits.
// On EVERY GameSummary (listings, profile, favorites, feed, related, Game).

type Game = { ...F003, latestVersion: GameVersion }   // the current version's row (current: true)

type FeedUpdate = {
  fromVersion: number;            // lowest version covered by this (possibly coalesced) item; === FeedItem.version when only one
  changes: { version: number; notes: string }[];   // covered versions with non-empty notes, newest first, at most 3
}
type FeedItem = { ...F002, update: FeedUpdate | null }   // non-null for kind "gameUpdated" only
```
The UI shows an "Updated" badge while `now − lastUpdatedAt < 7 days` (client-side; the server only reports the timestamp).

### Notes rules (every endpoint that accepts `notes`)
- `\r\n` and `\r` become `\n`; leading/trailing whitespace is trimmed; runs of 3+ blank lines collapse to 2.
- After that, at most **1000** characters (Unicode scalar values), else 422 `validation` "notes must be at most 1000 characters". A multipart `notes` field larger than 8 KB raw → 422.
- Control characters other than `\n` and `\t`, and the bidi controls U+202A–U+202E and U+2066–U+2069 → 422 `validation` "notes contain invalid characters".
- A missing field means `""`. Notes are plain text: clients must not render them as HTML or Markdown.

### Changed endpoints
| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST 🔒 | /api/games | v1 multipart + optional `notes` (version 1's release notes) | 201 `Game` |
| PUT 🔒 owner | /api/games/{id}/bundle | multipart `bundle` + optional `notes` + optional `expectedVersion` (decimal string) | `Game` (version+1, `latestVersion` = the new row) |
| GET 🔒 | /api/feed | unchanged query | `FeedPage` whose `gameUpdated` items carry `update` |

`PUT …/bundle` details:
- `expectedVersion` not a positive integer → 400 `bad_request` (checked before the upload is processed).
- `expectedVersion` present and different from the game's current version → 409 `conflict` "The game is at v{n}; reload and retry". Nothing is written.
- Without `expectedVersion`, behaviour is unchanged: the R1 rules still return 409 for a concurrent replace.
- On success the new version's `GameVersion` row is written atomically with the version bump. When the game is published, `lastUpdatedAt` is set to the same timestamp as `latestVersion.createdAt`, and the F002 `gameUpdated` event is recorded as before.
- When the game is unpublished, the version row is written but `lastUpdatedAt` is unchanged and no feed event is recorded (F002 rule). Publishing later never sets `lastUpdatedAt`.

### New endpoints
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET 🔓 | /api/games/{id}/versions | `?page=1&perPage=20` (max 100) | `Page<GameVersion>`, highest version first |
| PATCH 🔒 owner | /api/games/{id}/versions/{version} | `{ notes: string }` | `GameVersion` |

- Visibility of `/versions` follows `GET /api/games/{id}`: unknown id → 404; unpublished → 404 unless the viewer is the owner.
- History contains every version uploaded since F004, plus one row for each game's version that was current when F004 was deployed (empty notes; `createdAt` approximate). Older versions have no row. Old bundle files are not kept; there is no rollback.
- `PATCH …/versions/{version}`:
  - `{version}` not a positive integer → 400 `bad_request`. No row for that version → 404 `not_found`.
  - Missing or non-string `notes` → 422 `validation`; otherwise the notes rules above.
  - Only `notes` changes. It does not change `lastUpdatedAt`, `updatedAt`, the game's version or any feed event's position; feed items show the new text on their next read.
  - Owner rules as for `PATCH /api/games/{id}` (anonymous 401, others 403/404 as today).

### Feed (`FeedItem.update`)
- `fromVersion`: when the F002 24h coalescing merges several `gameUpdated` events, the item keeps the lowest version it replaced, so `fromVersion..version` lists every covered version. Items created before F004 report `fromVersion === version`.
- `changes` is read from the version history at request time (edits show immediately), filtered to non-empty notes, newest first, max 3.
- Clients must treat a missing `update` as `null` (older servers).

### Rate limits
- Notes edits (`PATCH …/versions/{version}`): 30 per 10 min, per user (`Limit::VersionNotes`).
- Bundle replace and create keep the existing 20/hour.
- `GET …/versions` is an unlimited public read, like comments.


---

## F013 additions

Studio: publish updates to an existing game (spec: `docs/features/F013-studio-publish-updates.md`). All earlier rules apply. Studio updates use the F004 `PUT /api/games/{id}/bundle` fields (`notes`, `expectedVersion`) unchanged. No other endpoint changes.

### New endpoint
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET 🔒 owner | /api/games/{id}/bundle | – | 200 `application/zip`: the **current** version's stored files |

- **Auth**: a session JWT. Preview-scoped tokens → 401. Anonymous → 401. Unknown id → 404. Another user's game → the same 403/404 as `PUT …/bundle`. Unpublished games work for their owner. Admins get no extra access.
- **Body**: a zip built from the extracted files of the current version.
  - `game.json` comes first, then the other paths sorted byte-wise. Paths are the stored ones: the single top-level folder (if the upload had one) is already stripped.
  - Only regular files are included.
  - png/jpg/jpeg/webp/gif/mp3/ogg/woff2 entries are stored; everything else is DEFLATE-compressed.
  - Every entry date is the version's `createdAt` (F004), else `updatedAt`.
  - The archive is plain zip: no ZIP64, no encryption, no data descriptors. Re-uploading it unchanged passes bundle validation.
- **Headers**:
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename="{slug}-v{version}.zip"`. `slug` is ASCII `[a-z0-9-]`, 1–40 chars, from the title (`game` if empty).
  - `X-Game-Version: {version}`, the version the files belong to.
  - `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Length`.
- **Errors**:
  - The game was replaced while the archive was being built → 409 `conflict` "The game was updated while preparing the download; retry". Clients may retry once.
  - Archive larger than 64 MiB → 413 `payload_too_large`.
  - More than 2 builds already running server-wide → 503 `unavailable` with `Retry-After: 5`.
- A download never takes the R1 bundle-replace claim, so it never causes a replace to fail.
- On servers without F013, `GET` on this path returns 405 (the route has only `PUT`).

### CORS
`/api/*` responses add `Access-Control-Expose-Headers: X-Game-Version, Content-Disposition, Retry-After`, so cross-origin clients (the desktop app, the dev web app) can read them.

### Rate limits
- Bundle downloads (`GET …/bundle`): 30/hour, per user (`Limit::BundleDownload`). Over the limit → 429 `rate_limited` with `Retry-After`.
- Bundle replace and create keep the existing 20/hour (`Limit::Upload`).


---

## F005 additions

Screenshot capture and share (spec: `docs/features/F005-screenshots.md`). All earlier rules apply, including the review round 2 `Limit::Image` (N5) on thumbnail and avatar uploads.

### Types
```ts
type Screenshot = {
  id: string;
  gameId: string;
  author: UserRef;
  caption: string;           // plain text, 0–140 chars, single line; "" = none
  imageUrl: string;          // "/media/screenshots/{id}.png" or ".jpg" (server-relative)
  thumbUrl: string;          // "/media/screenshots/{id}_t.jpg", fits in 480×480
  width: number;             // of imageUrl, 64–4096
  height: number;
  gameVersion: number;       // the game's version when it was posted
  createdAt: string;         // RFC3339 UTC
  canDelete: boolean;        // 🔓 the viewer is the author, the game owner or an admin; false when anonymous
}

type ReportTargetType = "game" | "comment" | "screenshot"
type Report = { ...v2, targetType: ReportTargetType, targetImageUrl: string | null }
// targetImageUrl: the screenshot's thumbUrl while it exists; null for other target types and deleted screenshots.
// targetPreview for screenshots: the caption's first 140 chars, else "Screenshot by {displayName or username}".
```

### Endpoints
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET 🔓 | /api/games/{id}/screenshots | `?page=1&perPage=12` (1–50, clamped) | `Page<Screenshot>`, newest first (`createdAt` desc, then `id`) |
| POST 🔒 | /api/games/{id}/screenshots | multipart `image` (required, png/jpg/webp ≤ 2MB) + `caption` (optional) | 201 `Screenshot` |
| DELETE 🔒 | /api/screenshots/{id} | – | 204 |

- **Visibility**: `GET` and `POST` follow `GET /api/games/{id}`. An unknown id → 404, and an unpublished game → 404 unless the viewer is the owner. A non-integer `page`/`perPage` → 400.
- **`POST` validation, in this order**:
  1. Auth → 401.
  2. Visibility → 404.
  3. `Limit::Screenshot` → 429.
  4. Multipart:
     - `image` missing or empty → 422 "image file is required";
     - a `caption` field larger than 1 KB raw → 422;
     - unknown fields are ignored.
  5. `validate_image`: larger than 2 MB → 413; not PNG/JPEG/WebP by magic bytes → 422.
  6. Caption: trimmed; at most **140** Unicode scalar values; any control character (including `\n` and `\t`) or a bidi control (U+202A–U+202E, U+2066–U+2069) → 422 `validation`.
  7. The user already has **20** screenshots on this game → 422 `validation` "You can post at most 20 screenshots per game". The insert is guarded, so concurrent posts can't exceed 20.
  8. More than 2 image decodes running server-wide → 503 `unavailable` with `Retry-After: 5`.
  9. Dimensions (from the header, before decoding): each side 64–4096 → else 422. A decode failure → 422 "image could not be decoded".
- **Stored image**: the server decodes and re-encodes every upload and keeps no original bytes.
  - PNG input → PNG; JPEG/WebP → JPEG quality 90.
  - Alpha is flattened on black, only the first frame is kept, and no metadata (EXIF, XMP, text chunks, ICC) is kept.
  - The thumbnail is a JPEG (quality 80) that fits in 480×480 and is never upscaled.
- **`DELETE`**:
  - Allowed for the author, the owner of the screenshot's game, or an admin. Anyone else → 403. Unknown id → 404. Anonymous → 401.
  - It removes the row and files and marks every open report on that screenshot `resolved` with resolution `delete`.
- **Cascades**: deleting a game (owner or admin) deletes its screenshots and their files.

### Reports (changed)
| Method | Path | Body | Response |
|---|---|---|---|
| POST 🔒 | /api/reports | v2 body; `targetType` may be `"screenshot"` | 201 `Report` |
| POST 🔒 admin | /api/admin/reports/{id}/resolve | `{ action }` | `Report` |

- **Creating**: for `targetType: "screenshot"`, the screenshot must exist and its game must be visible to the reporter (else 404). `targetGameId` is the screenshot's game. The v2 duplicate rule (409) applies.
- **Resolving**: for screenshot reports, `delete` deletes the screenshot (same effects as `DELETE /api/screenshots/{id}`), `dismiss` is unchanged, and `unpublish` → 422 `validation` (as for comments).
- **Lists**: `GET /api/admin/reports` returns `targetImageUrl` on every report.

### Media
| Path | What |
|---|---|
| GET /media/screenshots/{file} | Stored screenshots and thumbnails. Headers: `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=31536000, immutable` (a file never changes; ids are never reused), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`. |

Files stay reachable by direct URL after their game is unpublished, as thumbnails do. The ids are unguessable UUIDs, and listings hide them.

### Rate limits
- Screenshot posts (`POST …/screenshots`): **10/hour per user** (`Limit::Screenshot`, a separate bucket from `Limit::Image`). Over the limit → 429 `rate_limited` with `Retry-After`.
- "Set as thumbnail" uses the existing `PUT /api/games/{id}/thumbnail` and its `Limit::Image`.
- `GET …/screenshots` is an unlimited public read, like comments. `DELETE` is unlimited.


## Review-fix additions (REVIEW-2026-11-14-2)
- **`GET /api/games/{id}/scores`:** may return 429 `rate_limited` with `Retry-After`. The limit is 120/min, per user when signed in or per IP when anonymous, in its own bucket (separate from leaderboard reads).
- **Image uploads:** `PUT /api/games/{id}/thumbnail` and `PUT /api/users/me/avatar` share an Image bucket of 20/hour per user and may return 429. The limit is checked after auth and owner checks, before the body is read.
- **`TRENDING_TTL_SECS`** (default 600) is the background refresh cadence.
  - The snapshot is refreshed at startup and then every TTL, alongside `PRAGMA optimize`. A failed refresh is retried after `min(TTL, 60s)`.
  - `sort=trending` and `/related` read the current snapshot and never refresh it inline.
  - `0` disables the background task: reads refresh inline instead, with a 60s backoff after a failure. This is for tests and development.
- **Studio linker:** commented-out imports, and import-like text inside strings or templates, are ignored.
- **Unchanged:** response shapes, the feed cursor semantics and leaderboard results. Leaderboards are now served from a precomputed `score_bests` table (migration `0008_review2.sql`).


## F009 additions

Controls overlay and key remapping (spec: `docs/features/F009-controls-and-remapping.md`). All earlier rules apply. No new endpoints and no rate limit changes.

### Types
```ts
type GamepadButtonName = "A" | "B" | "X" | "Y" | "LB" | "RB" | "LT" | "RT" | "Back" | "Start" | "LS" | "RS" | "Up" | "Down" | "Left" | "Right"
type ControlAction = {
  id: string;                    // ^[a-z0-9_-]{1,32}$, unique per game
  name: string;                  // 1–40 chars, trimmed, no control or bidi characters
  keys: string[];                // 0–3 unique bindable codes (GAME_FORMAT.md § F009), e.g. "KeyA", "Space", "Mouse0"
  gamepad: GamepadButtonName[];  // 0–2 unique; keys.length + gamepad.length >= 1
}
type Game = { ...F004, actions: ControlAction[]; controlsHint: string }
// actions: from game.json `actions` of the CURRENT version, normalised, in declared order; [] when absent.
// controlsHint: from game.json `controls` (string only), normalised, 0–300 chars; "" when absent or not a string.
```
- Only `Game` (the detail object returned by `GET /api/games/{id}`, upload, replace and edit responses) carries the two fields. `GameSummary` is unchanged.
- Players' remapped keys are stored on the device (ARCHITECTURE § F009), never on the server.

### Changed endpoints
| Method | Path | Change |
|---|---|---|
| POST 🔒 | /api/games | game.json `actions` is validated (GAME_FORMAT § F009). A violation → 422 `validation` with a message naming the path. `controls` is never rejected. |
| PUT 🔒 | /api/games/{id}/bundle | Same validation. The new version's `actions` and `controlsHint` replace the old ones (a bundle without them clears them). |
| GET 🔓 | /api/games/{id} | + `actions`, `controlsHint`. |
| GET | /play/{id} | The `boot` options carry `actions` (the stored list, escaped for `<script>`). `Cache-Control: no-cache` and the CSP are unchanged. |
| GET | /play/studio | The page passes `manifest.actions` from `webgame:studio-load` to `boot`. |

- `GET /api/games/{id}/bundle` (F013) is unchanged. It returns the stored `game.json` file as uploaded, not the normalised copy.
- Example 422 messages: `game.json: actions must be an array`, `game.json: at most 32 actions are allowed`, `game.json: actions[0].id must match ^[a-z0-9_-]{1,32}$`, `game.json: actions[1].id "jump" is a duplicate`, `game.json: actions[2].keys[1] "Escape" can't be bound`, `game.json: actions[3].gamepad[0] "Home" is not a gamepad button`, `game.json: actions[4] needs at least one key or gamepad button`.

### Existing games
- Games uploaded before F009 are backfilled once at backend startup from their stored `game.json` (ARCHITECTURE § F009). Until the backfill has processed a game, it reports `actions: []` and `controlsHint: ""`.
- A stored `game.json` whose `actions` would now fail validation is backfilled as `actions: []` (no error). The next upload of that bundle gets the 422.


## Review-fix additions (REVIEW-2026-11-15-3)
- **`Report.targetImageFullUrl: string | null`** (L7): the full-size screenshot URL (`/media/screenshots/{id}.{png|jpg}`) while the screenshot exists. It is `null` for other target types and for deleted screenshots. It appears wherever `targetImageUrl` does (create response, admin list, resolve response). `targetImageUrl` stays the thumbnail.
- **Screenshot media caching** (L8): responses send `Cache-Control: public, max-age=3600`, no longer `immutable`, and use `Last-Modified` for revalidation. Non-2xx responses, such as the 404 after a delete, send `no-store`. A shared cache may keep serving a deleted screenshot for up to 1 hour unless it is purged.
- **`POST …/screenshots`:**
  - New 422 message: "image is too large to process; use fewer pixels or 8-bit color", returned when the estimated decode memory exceeds 80 MiB (L3).
  - A 503 (decode slots busy) or a server-side 5xx failure (decode task, file write or database) does not use up the 10/hour quota (L5). A 422 (invalid, undecodable or over-budget image) is charged (review 4, M2).
- **Leaderboards after a `leaderboard.order` change** (L4): boards are served by a slower fallback query until a background rebuild of `score_bests` finishes (migration `0011_review3.sql`). Results are identical.


---

## F006 additions

Comment replies and reactions (spec: `docs/features/F006-comment-replies-and-reactions.md`). All earlier rules apply, including the v2 moderation flow and `Limit::Comment`.

### Types
```ts
type Comment = {
  ...v1,                          // id, gameId, author, body, createdAt
  parentId: string | null;        // null = top-level; otherwise ALWAYS the id of a top-level comment (one level of nesting)
  replyTo: UserRef | null;        // replies only: the author of the reply that was answered (see "Reply rules"); null otherwise or if that user was deleted
  isCreator: boolean;             // the author is the game's CURRENT owner
  hearts: number;                 // >= 0, distinct users who hearted this comment
  myHeart: boolean;               // 🔓 the viewer hearted it; false when anonymous
  creatorHeart: boolean;          // the game's current owner hearted it
  canDelete: boolean;             // 🔓 the viewer is the author, the game owner or an admin; false when anonymous
}

type CommentThread = Comment & {  // a top-level comment (parentId === null) with a reply preview
  replyCount: number;             // all replies in the thread
  replies: Comment[];             // the OLDEST replies, oldest first, at most 3
}

type CommentListPage = Page<CommentThread> & {
  totalAll: number;               // comments + replies on the game; `total` counts top-level comments only
}

type CommentContext = {
  comment: Comment;               // the requested comment (top-level or reply)
  thread: CommentThread;          // its thread; thread.id === comment.id when the comment is top-level
}

type HeartResponse = { hearted: boolean; hearts: number; creatorHeart: boolean }
```
- The fields are on every `Comment` the API returns: list items, previews, `/replies`, `CommentContext`, and the `POST` response.
- Clients must treat missing new fields as `null` / `0` / `false` / `[]`, and a missing `totalAll` as `total` (older servers).

### Changed endpoints
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET 🔓 | /api/games/{id}/comments | `?page=1&perPage=20` (max 100) | `CommentListPage`: top-level comments only, newest first (`createdAt` desc, then insertion order desc) |
| POST 🔒 | /api/games/{id}/comments | `{ body, parentId?: string \| null }` | 201 `Comment` |
| DELETE 🔒 | /api/comments/{id} | – | 204 |

- **`GET …/comments`** was `Page<Comment>` with `total` = all comments. Now `total` = top-level comments, `totalAll` = all comments. Paging and visibility are unchanged (unknown game → 404; unpublished → 404 unless owner; non-integer `page`/`perPage` → 400).
- **`POST …/comments` validation, in this order**:
  1. Auth → 401.
  2. Game visibility → 404.
  3. `Limit::Comment` (shared by top-level comments and replies) → 429.
  4. `parentId` present and not a string or `null` → 422 `validation`.
  5. `body`: trimmed, 1–2000 characters, else 422 (v1 rule, unchanged).
  6. `parentId` (when a string): no such comment, or it belongs to another game → 404 `not_found` "Comment not found".
  7. The thread already has **200** replies → 422 `validation` "This thread has reached 200 replies". The insert is guarded, so concurrent posts can't exceed 200.
- **Reply rules** (when `parentId` names comment P):
  - The stored `parentId` is P's id if P is top-level, else P's `parentId` (its root). Nesting never goes deeper than one level.
  - `replyTo` is P's author when P is itself a reply **and** P's author is not the poster. Otherwise `replyTo` is `null`.
- **`DELETE /api/comments/{id}`**:
  - Allowed for the comment's author, the game's owner, or an admin (admins are new). Anyone else → 403. Unknown id → 404. Anonymous → 401.
  - Deleting a top-level comment also deletes all its replies. Hearts on deleted comments are removed.
  - Every open report whose target is a deleted comment (the comment itself and, for a top-level comment, each of its replies) is marked `resolved` with resolution `delete`, in the same transaction.

### New endpoints
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET 🔓 | /api/comments/{id} | – | `CommentContext` |
| GET 🔓 | /api/comments/{id}/replies | `?page=1&perPage=50` (1–100) | `Page<Comment>`: the thread's replies, oldest first (`createdAt` asc, then insertion order); `total` = `replyCount` |
| PUT 🔒 | /api/comments/{id}/heart | – | `HeartResponse` `{ hearted: true }` (idempotent) |
| DELETE 🔒 | /api/comments/{id}/heart | – | `HeartResponse` `{ hearted: false }` (idempotent; 200 even if not hearted) |

- **Visibility** (all four): unknown comment id → 404; the comment's game must be visible to the viewer under `GET /api/games/{id}` rules, else 404.
- **`/replies`**: `{id}` is a reply (not top-level) → 422 `validation` "Replies are listed for top-level comments only". Non-integer `page`/`perPage` → 400.
- **Hearts**, checked in this order: auth → 401; comment and visibility → 404; `Limit::Heart` → 429; `PUT` on your own comment → 422 `validation` "You can't heart your own comment" (`DELETE` on your own comment returns `{ hearted: false }`). The response carries the counts after the change.
- `hearts`, `myHeart` and `creatorHeart` on later reads reflect the change immediately.
- Who hearted a comment is not listed anywhere; only the count, the viewer's own state and `creatorHeart` are exposed.

### Reports (changed)
| Method | Path | Body | Response |
|---|---|---|---|
| POST 🔒 | /api/reports | v2 body; `targetType: "comment"` accepts replies too | 201 `Report` |
| POST 🔒 admin | /api/admin/reports/{id}/resolve | `{ action }` | `Report` |

- Creating a report on a reply follows the v2 comment rules (`targetGameId` = the reply's game; `targetPreview` = its first 140 chars).
- Resolving a comment report with `delete` has exactly the effects of `DELETE /api/comments/{id}` (replies cascade, open reports on all deleted comments are resolved). `dismiss` is unchanged; `unpublish` → 422 as before.
- `Report` has no new fields. Clients link a comment report to `/games/{targetGameId}?comment={targetId}`.

### Stats (unchanged, clarified)
`CreatorStats.totals.comments` and `GameStats.comments` count all comments, replies included.

### Rate limits
- Top-level comments and replies share `Limit::Comment`: 30 per 10 min, per user (unchanged).
- Hearts (`PUT` and `DELETE …/heart`, shared bucket): **120 per 10 min, per user** (`Limit::Heart`). Over the limit → 429 `rate_limited` with `Retry-After`.
- `GET /api/comments/{id}` and `/replies` are unlimited public reads, like the comment list. `DELETE /api/comments/{id}` is unlimited.


---

## F007 additions

In-app notifications (spec: `docs/features/F007-in-app-notifications.md`). All earlier rules apply, including F002 (follows), F006 (comments, replies, hearts, permalinks) and the v2 error shape.

### Types
```ts
type NotificationKind = "comment" | "reply" | "heart" | "follow" | "gamePublished"

type NotificationGame = { id: string; title: string; thumbnailUrl: string | null }

type Notification = {
  id: string;                     // decimal string; stable for the row's lifetime
  kind: NotificationKind;
  actors: UserRef[];              // 1–3 most recent distinct actors, newest first
  actorCount: number;             // distinct actors in the group, >= 1
  eventCount: number;             // events in the group, >= actorCount; comment/reply: comments posted; heart/follow/gamePublished: = actorCount
  game: NotificationGame | null;  // null only for "follow"
  commentId: string | null;       // comment: the newest comment in the group; reply: the newest reply; heart: the hearted comment; else null
  excerpt: string | null;         // first 140 chars (Unicode scalar values) of commentId's current body; plain text; null when commentId is null
  ownsThread: boolean;            // reply: the recipient wrote the thread's top-level comment; false otherwise
  creatorHeart: boolean;          // heart: the game's current owner is among the actors; false otherwise
  read: boolean;
  createdAt: string;              // RFC3339 millis Z, first event of the group
  updatedAt: string;              // RFC3339 millis Z, latest event of the group (the ordering key)
  path: string;                   // in-app route to open, see "Paths"
}

type NotificationPage = {
  items: Notification[];          // updatedAt desc, then id desc
  nextCursor: string | null;      // opaque; null when there are no more items
  unread: number;                 // same value as UnreadCount.unread
}

type UnreadCount = {
  unread: number;                 // visible unread notifications, capped at 100 (clients show "99+" at 100)
  latestAt: string | null;        // updatedAt of the newest visible unread notification; null when unread = 0
  pollAfterSecs: number;          // suggested delay before the next poll (env NOTIFICATION_POLL_SECS)
}

type NotificationSettings = {     // all default to true
  comments: boolean;              // "comment" kind
  replies: boolean;               // "reply" kind
  hearts: boolean;                // "heart" kind
  follows: boolean;               // "follow" kind
  newGames: boolean;              // "gamePublished" kind
}

type MarkReadRequest = {
  ids?: string[];                 // 1–100 notification ids; absent = every unread notification of the caller
  upTo: string;                   // RFC3339; only rows with updatedAt <= upTo are marked (race guard)
}
type MarkReadResponse = { unread: number }   // UnreadCount.unread after the change
```
Clients must ignore notifications with an unknown `kind` (more kinds may be added later).

### Endpoints
| Method | Path | Query / Body | Response |
|---|---|---|---|
| GET 🔒 | /api/notifications | `?cursor=&limit=20&unread=false` | `NotificationPage` |
| GET 🔒 | /api/notifications/unread-count | – | `UnreadCount` |
| POST 🔒 | /api/notifications/read | `MarkReadRequest` | `MarkReadResponse` |
| GET 🔒 | /api/notifications/settings | – | `NotificationSettings` |
| PUT 🔒 | /api/notifications/settings | `Partial<NotificationSettings>` | `NotificationSettings` (after the change) |

- Order in every handler: auth → 401; `Limit::Notifications` → 429; validation → 400/422.
- **`GET /api/notifications`**:
  - `limit`: 1–50, clamped, default 20. Non-integer → 400 `bad_request`.
  - `unread`: `true` lists unread notifications only; `false` or absent lists all. Any other value → 400.
  - `cursor`: a `nextCursor` from a previous response; returns items strictly after it in the order `updatedAt desc, id desc`. Malformed → 400. The cursor is opaque; clients must not build or parse it.
  - Across pages, a group that received a new event moves to the top; clients dedupe by `id`.
- **`POST /api/notifications/read`**:
  - `upTo` missing or not an RFC3339 timestamp → 422 `validation`.
  - `ids`: not an array of strings, empty, or more than 100 entries → 422; an entry that is not a positive decimal integer → 400.
  - Marks the caller's matching unread notifications with `updatedAt <= upTo` as read. Ids that don't exist or belong to someone else are ignored (no error). Idempotent.
- **`PUT /api/notifications/settings`**: each present field must be a boolean, else 422. Unknown fields are ignored. An empty object is valid (no change). A setting turned off stops **new** notifications of that kind; existing ones are kept until they expire.

### Triggers and recipients (server side; no new client calls)
| Kind | Written when | Recipients | Group | Joins an unread group? |
|---|---|---|---|---|
| `comment` | `POST /api/games/{id}/comments` creates a top-level comment | the game owner | per game | yes; each comment is one event |
| `reply` | `POST /api/games/{id}/comments` creates a reply | the thread's top-level author, and the reply's `replyTo` user | per thread | yes; each reply is one event |
| `heart` | `PUT /api/comments/{id}/heart` inserts a heart | the comment's author | per comment | yes; one event per hearting user |
| `follow` | `PUT /api/users/{username}/follow` creates a follow | the followed user | one per recipient | yes; one event per follower |
| `gamePublished` | a game becomes published for the first time (the F002 `gamePublished` condition) | every follower of the owner | per game | n/a (written once per recipient per game, ever) |

- **Never the actor.** The user who caused the event is never a recipient, and each recipient gets at most one notification per event (e.g. a reply whose thread author is also the `replyTo` user).
- **Coalescing.** While a recipient has an unread notification for the same (kind, group), new events join it: `actorCount`/`eventCount` grow and `updatedAt` moves to the new event. Once it is read, it never changes again, and the next event creates a new unread notification.
- **Dedupe (hearts and follows).** A user's heart on a comment, or follow of a user, notifies at most once while an earlier event of theirs for the same group is stored (read or unread).
- **Retraction.** `DELETE /api/comments/{id}/heart` and `DELETE /api/users/{username}/follow` remove that user's event from the recipient's **unread** notification of that group. A read notification is not changed. A notification left with no events is no longer listed or counted.
- **Settings** are checked when the notification is written. A recipient with the kind turned off gets nothing.
- Writing notifications is best effort: a failure is logged and never changes the response of the triggering request. `gamePublished` notifications are written in the background after the publish commits; an interrupted fan-out resumes after a restart. Followers who follow after the publish are not notified.
- **Deletions.** Deleting a comment (any path, including admin resolve `delete`) removes its events; deleting a thread or a hearted comment removes the whole `reply`/`heart` notification. Deleting a game removes all its notifications.

### Visibility
A notification is listed and counted only when (a) it has at least one event and (b) its game, if any, is visible to the recipient under `GET /api/games/{id}` rules (published, or owned by the recipient). Unpublishing hides a game's notifications; re-publishing shows them again unless they were pruned.

### Paths
| Kind | `path` |
|---|---|
| `comment`, `reply`, `heart` | `/games/{gameId}?comment={commentId}` (F006 permalink) |
| `follow` | `/u/{recipient username}/followers` |
| `gamePublished` | `/games/{gameId}` |

### Retention
Pruned by the server's maintenance task (about hourly):
- read notifications 30 days after they were read;
- any notification 90 days after its `updatedAt`;
- beyond the newest **200** notifications per recipient;
- notifications with no events.

### Privacy
- The author of a comment learns who hearted it (through `heart` notification actors). Nobody else does; there is still no public list of who hearted a comment (F006).
- `excerpt` is read from the current comment at request time, so deletions apply immediately.

### Rate limits
- All five endpoints share **`Limit::Notifications`: 120/min, per user**. Over the limit → 429 `rate_limited` with `Retry-After`.
- The writes that create notifications keep their existing buckets (`Limit::Comment`, `Limit::Heart`, `Limit::Follow`, `Limit::Upload`) and don't use this one.

### Backend env
`NOTIFICATION_POLL_SECS` (default `60`): the `pollAfterSecs` value returned by `GET /api/notifications/unread-count`. Integer 15–600; anything else is a startup error.

## Review-fix additions (REVIEW-2026-11-15-4)
- **Heart/follow toggles:** turning a heart or follow off and back on while its notification is unread no longer bumps `updatedAt` or moves the item. The unread count can still go 1→0→1. A different actor still bumps it.
- **Empty notifications:** a notification is deleted as soon as its last event is removed or cascaded, not at the next prune (migration `0014_review4.sql`).
- **Write robustness:** notification writes use `BEGIN IMMEDIATE` with the dedupe check folded into the upsert, so concurrent writers wait instead of losing notifications.


## F012 additions

Bitmap fonts, 9-slice and UI widgets (spec: `docs/features/F012-bitmap-fonts-and-ui-widgets.md`). All earlier rules apply. **No new types, endpoints, migrations or rate limits.** The engine API is in GAME_FORMAT.md § F012 additions.

### Changed behaviour
| Method | Path | Change |
|---|---|---|
| POST 🔒 | /api/games | `fnt` is an allowed bundle file extension. The 422 `validation` message for a disallowed extension lists it. |
| PUT 🔒 | /api/games/{id}/bundle | Same allowlist. |
| GET | /games/{id}/files/{path} | `*.fnt` → `Content-Type: text/plain; charset=utf-8`, with the existing `X-Content-Type-Options: nosniff`, CSP sandbox and `Access-Control-Allow-Origin: *`. |

- The full allowlist is now: `png jpg jpeg webp gif svg json txt wav mp3 ogg js css woff2 ttf fnt`. Extension matching is unchanged.
- The backend does **not** parse or validate `.fnt` contents. A broken descriptor fails in the engine at load time, inside the game's sandbox.
- `GET /api/games/{id}/bundle` (F013) is unchanged; `.fnt` entries are deflated like other text files.


---

## F017 additions

Creator comment tools: pin, lock and "Top" sort (spec: `docs/features/F017-creator-comment-tools.md`). All earlier rules apply, including F006 (threads, hearts, visibility) and F007 (notifications).

### Types
```ts
type Comment = {
  ...F006,
  pinned: boolean;                // top-level only: this is the game's pinned comment; always false on replies
  locked: boolean;                // top-level only: the thread is locked against new replies; always false on replies
  canModerate: boolean;           // 🔓 top-level only: the viewer is the game's current owner or an admin (may pin/lock); false on replies and when anonymous
}

type CommentListPage = Page<CommentThread> & {
  totalAll: number;               // F006, unchanged: all comments + replies on the game, pinned thread included
  pinned: CommentThread | null;   // the game's pinned thread (same shape as items), on every page; null when none
}

type CommentSort = "new" | "top"

type ThreadState = {
  id: string;                     // the comment acted on
  pinned: boolean;                // its state after the request
  locked: boolean;                // its state after the request
  unpinnedId: string | null;      // PUT …/pin only: the comment that was pinned before and is now unpinned; else null
}
```
- The three `Comment` fields appear wherever a `Comment` is returned (list items, `pinned`, previews, `/replies`, `CommentContext`, the `POST` response).
- Clients must treat missing `pinned`/`locked`/`canModerate` as `false` and a missing `CommentListPage.pinned` as `null` (older servers).
- A game has at most one pinned comment.

### Changed endpoints
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET 🔓 | /api/games/{id}/comments | `?page=1&perPage=20&sort=new` (`sort`: `new` \| `top`) | `CommentListPage` |
| POST 🔒 | /api/games/{id}/comments | F006 body | 201 `Comment` |

- **`GET …/comments`**:
  - `sort` absent, empty or `new`: top-level comments newest first (F006 order, unchanged). `top`: most hearts on the top-level comment first (replies' hearts don't count), then `createdAt` desc, then insertion order desc.
  - Unknown `sort` → 400 `bad_request` "Unknown sort '…' (expected new or top)". It is checked before `page`/`perPage`.
  - The pinned thread is **not** in `items` on any page and is **not** counted in `total`. It is returned in `pinned` (with its reply preview and `replyCount`) on every page.
  - Visibility and paging rules are unchanged.
- **`POST …/comments`**: one new step in the F006 validation order, between step 6 (`parentId` → 404) and step 7 (200-replies cap → 422):
  - 6b. The thread (the root of `parentId`) is locked and the poster is neither the game's owner nor an admin → 422 `validation` "This thread is locked".
  - The check is part of the guarded insert, so a reply racing a lock is either committed before it or refused.
  - Top-level comments are never affected by locks.

### New endpoints
| Method | Path | Body | Response |
|---|---|---|---|
| PUT 🔒 owner/admin | /api/comments/{id}/pin | – | `ThreadState` `{ pinned: true }` (idempotent) |
| DELETE 🔒 owner/admin | /api/comments/{id}/pin | – | `ThreadState` `{ pinned: false, unpinnedId: null }` (idempotent; 200 even if not pinned) |
| PUT 🔒 owner/admin | /api/comments/{id}/lock | – | `ThreadState` `{ locked: true, unpinnedId: null }` (idempotent) |
| DELETE 🔒 owner/admin | /api/comments/{id}/lock | – | `ThreadState` `{ locked: false, unpinnedId: null }` (idempotent) |

- "owner/admin" = the current owner of the comment's game, or a user with `role: "admin"`.
- Checked in this order (all four):
  1. Auth → 401.
  2. Unknown comment, or its game is not visible to the caller under `GET /api/games/{id}` rules → 404 `not_found` "Comment not found".
  3. Caller is not the game's owner or an admin → 403 `forbidden`.
  4. `Limit::ThreadTools` → 429.
  5. The comment is a reply → 422 `validation` "Only top-level comments can be pinned" (`…/pin`) or "Only top-level comments can be locked" (`…/lock`).
  6. The comment was deleted after step 2 → 404.
- **`PUT …/pin`** unpins the game's previously pinned comment (if any, and if it is another comment) in the same transaction and reports it in `unpinnedId`. Pinning the already pinned comment returns `unpinnedId: null`.
- Pin and lock are independent: a comment can be pinned and locked at the same time.
- Deleting a comment (any path, including admin resolve `delete`) removes its pin and lock with it. No endpoint returns a dangling pin.
- None of the four endpoints write F002 activity or F007 notifications, and none retract existing ones.

### Reports and moderation (unchanged, clarified)
- Comment reports, `DELETE /api/comments/{id}` and admin resolve `delete` behave as in F006 for pinned and locked comments. `Report` has no new fields.
- Admins have the same pin/lock tools as owners on every game.

### Rate limits
- `PUT`/`DELETE …/pin` and `PUT`/`DELETE …/lock` share **`Limit::ThreadTools`: 60 per 10 min, per user**. Over the limit → 429 `rate_limited` with `Retry-After`.
- They don't use `Limit::Comment` or `Limit::Heart`. `GET …/comments` with any `sort` stays an unlimited public read.


## Review-fix additions (REVIEW-2026-11-16-5)
- **Compression (M1):** when the client sends `Accept-Encoding: gzip`, responses from `/runtime/*`, `/games/{id}/files/*` and the web app may be gzipped (`Content-Encoding: gzip`, no `Content-Length`).
  - Only text types are compressed (`text/*`, JSON, JS, XML, SVG, wasm), and only at 256 bytes or more. Images, audio, fonts and zips never are.
  - `/api/*` and `/play/*` are not compressed.
- **ETags (M1):** game and runtime files of those text types now carry a weak ETag (`W/"v{n}-…"`, `W/"rt-…"`) and `Vary: Accept-Encoding`. Media keeps a strong ETag. `If-None-Match` accepts either form.
- **Web app caching (M1, when `WEB_DIST` is set):**
  - `/assets/*` is served with `Cache-Control: public, max-age=31536000, immutable`. A missing asset is a 404, not `index.html`.
  - Every other path (`index.html` and client routes) is served with `no-cache`.
  - Any `*.map` path returns 404 with the JSON `not_found` error.
- **Notifications (L5):** notifications whose events are all retracted don't count toward the 200-per-recipient cap. Re-toggling a heart or follow while that kind is muted restores nothing.
- **Fan-out retries (L9):** a parked `gamePublished` fan-out is retried every 10 minutes while the server runs, not only after a restart. Pruning and fan-out retries run even when `TRENDING_TTL_SECS=0`, in a housekeeping task that ticks every 60 s.


---

## F008 additions

Collections: curated, ordered game lists (spec: `docs/features/F008-collections.md`). All earlier rules apply, including the v2 report flow, F005's report fields and the v2 error shape.

### Types
```ts
type CollectionVisibility = "public" | "private"

type CollectionSummary = {
  id: string;                     // UUID v4
  title: string;                  // 1–60 chars, single line
  description: string;            // 0–500 chars, may contain "\n" (at most 8 lines); "" = none
  visibility: CollectionVisibility;
  owner: UserRef;
  gameCount: number;              // items whose game is visible to the viewer (GET /api/games/{id} rule)
  coverUrls: string[];            // 0–4 thumbnailUrl values of the first visible games that have a thumbnail, in collection order
  createdAt: string;              // RFC3339 UTC
  updatedAt: string;              // RFC3339 UTC; bumped by every successful change (details, add, note, remove, reorder)
  path: string;                   // "/c/{id}" (in-app route)
}

type CollectionItem = {
  gameId: string;
  game: GameSummary | null;       // null: the game is not visible to the viewer. Only ever returned to the collection's owner.
  note: string;                   // 0–140 chars, single line; "" = none
  addedAt: string;                // RFC3339 UTC
}

type Collection = CollectionSummary & {
  items: CollectionItem[];        // collection order; all items (max 100), not paged
  isOwner: boolean;               // 🔓 the viewer owns the collection
  canDelete: boolean;             // 🔓 the viewer is the owner or an admin
}

type MyCollection = CollectionSummary & {
  containsGame: boolean;          // the `gameId` query game is in this collection; false without `gameId`
  itemCount: number;              // all items including unavailable ones (what the 100 cap counts)
}

type GameCollectionsPage = { items: CollectionSummary[]; total: number /* public collections containing the game */ }

type CollectionItemResponse = {
  added: boolean;                 // true: newly inserted; false: already present (note updated if given)
  item: CollectionItem;           // with `game` as the owner sees it
  gameCount: number;              // after the change, as the owner sees it
  updatedAt: string;              // the collection's updatedAt after the change
}

type CollectionRemoveResponse = { removed: boolean; gameCount: number; updatedAt: string }

type CreateCollectionRequest = { title: string; description?: string; visibility?: CollectionVisibility /* default "public" */; gameId?: string }
type UpdateCollectionRequest = { title?: string; description?: string; visibility?: CollectionVisibility }
type PutCollectionGameRequest = { note?: string }   // the body is optional; an absent note keeps the stored note
type ReorderCollectionRequest = { gameIds: string[] }
```
- Item order is ascending stored position, then `addedAt`, then `gameId`.
- **Visibility of a collection** ("visible to the caller"): public → anyone; private → its owner or an admin. Otherwise every endpoint below answers 404 `not_found` "Collection not found" (never 403), so private collections can't be probed.
- **Items for a viewer**: an item is included with its `GameSummary` when its game is visible to the viewer under `GET /api/games/{id}` rules. Otherwise it is omitted, except for the collection owner, who gets it with `game: null`. Admins viewing someone else's collection get only items visible to them.

### Text rules
| Field | Rule (after trimming leading and trailing whitespace) | 422 `validation` message |
|---|---|---|
| `title` | 1–60 Unicode scalar values; no control characters, no bidi controls (U+202A–U+202E, U+2066–U+2069) | "title must be 1–60 characters" / "title must be a single line of plain text" |
| `description` | `\r\n` and `\r` become `\n` first; 0–500 scalar values; at most 7 `\n` (8 lines); no other control characters, no bidi controls | "description must be at most 500 characters" / "description must be at most 8 lines" / "description must be plain text" |
| `note` | 0–140 scalar values; no control characters (including `\n`), no bidi controls | "note must be at most 140 characters" / "note must be a single line of plain text" |
| `visibility` | exactly `"public"` or `"private"` | "visibility must be \"public\" or \"private\"" |

A field with the wrong JSON type → 422. Unknown fields are ignored. Malformed JSON → 400 as elsewhere.

### Endpoints
| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST 🔒 | /api/collections | `CreateCollectionRequest` | 201 `Collection` |
| GET 🔓 | /api/collections/{id} | – | `Collection` |
| PATCH 🔒 owner | /api/collections/{id} | `UpdateCollectionRequest` | `Collection` |
| DELETE 🔒 owner/admin | /api/collections/{id} | – | 204 |
| PUT 🔒 owner | /api/collections/{id}/games/{gameId} | `PutCollectionGameRequest` (or no body) | `CollectionItemResponse` |
| DELETE 🔒 owner | /api/collections/{id}/games/{gameId} | – | `CollectionRemoveResponse` (idempotent; `removed: false` when absent) |
| PUT 🔒 owner | /api/collections/{id}/order | `ReorderCollectionRequest` | `Collection` |
| GET 🔓 | /api/users/{username}/collections | `?page=1&perPage=24` (1–100, clamped) | `Page<CollectionSummary>` |
| GET 🔒 | /api/users/me/collections | `?gameId=` (optional) | `MyCollection[]` (all of the caller's collections, max 50) |
| GET 🔓 | /api/games/{id}/collections | `?limit=6` (1–24, clamped) | `GameCollectionsPage` |

**Check order for writes on `/api/collections/{id}…`** (PATCH, DELETE, both item endpoints, order):
1. Auth → 401.
2. Unknown collection, or not visible to the caller → 404 "Collection not found".
3. The caller is not the owner (for DELETE: not the owner and not an admin) → 403 `forbidden`.
4. `Limit::Collections` → 429.
5. Body validation → 400/422.
6. The endpoint's own rules below.

**`POST /api/collections`**: auth → 401; `Limit::Collections` → 429; body validation → 422; `gameId` given and not visible to the caller → 404 "Game not found" (nothing is created); the caller already has **50** collections → 422 "You can have at most 50 collections". With `gameId`, that game is the first item (empty note). The cap check and insert are atomic.

**`GET /api/collections/{id}`**: visibility → 404. `isOwner` and `canDelete` are false when anonymous.

**`PATCH /api/collections/{id}`**: present fields are validated and applied. An empty object is valid (no change; `updatedAt` is not bumped). Admins who aren't the owner → 403.

**`DELETE /api/collections/{id}`**: deletes the collection and its items, and marks every open report on it `resolved` with resolution `delete`. Games are not affected.

**`PUT /api/collections/{id}/games/{gameId}`**:
- The game is already in the collection → its note is replaced when `note` is present (kept when absent), `added: false`. This works even if the game is no longer visible, and even at the cap.
- Otherwise: the game must be visible to the caller under `GET /api/games/{id}` rules, else 404 "Game not found"; the collection already has **100** items (unavailable ones included) → 422 "A collection can hold at most 100 games"; else the game is appended at the end with `added: true`.
- The cap check and insert are atomic, so concurrent adds can't exceed 100.

**`DELETE /api/collections/{id}/games/{gameId}`**: removes the item whether or not the game is visible. An id that isn't in the collection → 200 `removed: false` (`updatedAt` not bumped).

**`PUT /api/collections/{id}/order`**:
- `gameIds` missing, not an array of strings, longer than 100, or with duplicates → 422.
- The set of `gameIds` is not exactly the set of the collection's current items (all of them, including unavailable ones) → 409 `conflict` "The collection has changed; reload and try again".
- Otherwise the items take the given order. `updatedAt` is bumped only when the order changed.

**`GET /api/users/{username}/collections`**: unknown user → 404. The user themself sees all their collections (public and private, including empty ones). Everyone else sees only public collections with `gameCount >= 1`. Order: `updatedAt` desc, then `id` desc. A non-integer `page`/`perPage` → 400.

**`GET /api/users/me/collections`**: order `updatedAt` desc, then `id` desc. A `gameId` that is unknown or not visible makes every `containsGame` false (no error).

**`GET /api/games/{id}/collections`**: the game must be visible to the viewer (else 404). Lists public collections that contain the game, `updatedAt` desc, then `id` desc, at most `limit`; `total` counts all of them. Private collections never appear, even to their owner. A non-integer `limit` → 400.

### Reports (changed)
```ts
type ReportTargetType = "game" | "comment" | "screenshot" | "collection"
type Report = { ...F005 and review 3, targetGameId: string | null }   // null for "collection" reports; a string for every other type
```
| Method | Path | Body | Response |
|---|---|---|---|
| POST 🔒 | /api/reports | v2 body; `targetType` may be `"collection"` | 201 `Report` |
| POST 🔒 admin | /api/admin/reports/{id}/resolve | `{ action }` | `Report` |

- **Creating**: for `"collection"`, the collection must exist and be visible to the reporter (else 404 "Collection not found"). `targetPreview` is the first 140 chars of its title at report time. `targetGameId`, `targetImageUrl` and `targetImageFullUrl` are `null`. The v2 duplicate rule (409) applies. An unknown `targetType` → 422 `targetType must be "game", "comment", "screenshot" or "collection"`.
- **Resolving**: `delete` deletes the collection (same effects as `DELETE /api/collections/{id}`; a collection that is already gone is not an error); `dismiss` is unchanged; `unpublish` → 422 "unpublish is only valid for game reports".
- **Clients** must accept `targetGameId: null`, and should show a row with an unknown `targetType` with Dismiss only.

### Caps
50 collections per user; 100 games per collection; titles 60, descriptions 500 (8 lines) and notes 140 characters.

### Rate limits
- `POST /api/collections`, `PATCH`/`DELETE /api/collections/{id}`, `PUT`/`DELETE …/games/{gameId}` and `PUT …/order` share **`Limit::Collections`: 120 per 10 min, per user**. Over the limit → 429 `rate_limited` with `Retry-After`.
- `GET /api/collections/{id}` and the three list endpoints are unlimited reads (like profiles and comments). Collection reports use the existing `Limit::Report`.

### Web routes
`/c/{id}`, `/u/{username}/collections` and `/collections` are SPA routes. With `WEB_DIST` set they fall back to `index.html` with `no-cache` (review 5 M1). F008 adds no backend-served files, and `/api/*` stays uncompressed.


---

## F018 additions

Notification controls: mutes, shared polling and `pinned` notifications (spec: `docs/features/F018-notification-controls.md`). All earlier rules apply, including F007 (notifications), F017 (pins) and the v2 error shape.

### Types
```ts
type NotificationKind = "comment" | "reply" | "heart" | "follow" | "gamePublished" | "pinned"

type Notification = {
  ...F007,
  threadId: string | null;        // reply: the thread's top-level comment; heart: the top-level comment of the hearted comment's thread
                                  // (the hearted comment itself when it is top-level); pinned: the pinned comment; else null
}

type NotificationSettings = {
  ...F007,
  pins: boolean;                  // "pinned" kind; default true
}

type Game = { ...earlier, notificationsMuted: boolean }      // GET /api/games/{id} only: the viewer muted this game; false when anonymous
type Comment = { ...F017, threadMuted: boolean }              // top-level only: the viewer muted this thread; false on replies and when anonymous

type MuteTarget = "game" | "thread"

type NotificationMute = {
  target: MuteTarget;
  game: NotificationGame;         // the game (for threads: the thread's game)
  threadId: string | null;        // thread: the top-level comment id; game: null
  excerpt: string | null;         // thread: first 80 chars (Unicode scalar values) of the top-level comment's current body; game: null
  path: string;                   // game: "/games/{gameId}"; thread: "/games/{gameId}?comment={threadId}"
  createdAt: string;              // RFC3339 millis Z, when it was muted
}

type NotificationMuteList = {
  items: NotificationMute[];      // createdAt desc, then insertion order desc; only mutes whose game is visible to the caller
  total: number;                  // items.length (all listed mutes; there is no paging)
}

type MuteState = {
  muted: boolean;                 // the state after the request
  unread: number;                 // UnreadCount.unread after the request (mutes mark matching notifications read)
}
```
- Clients must treat a missing `threadId` as `null`, a missing `pins` as "setting not supported" (hide the switch), and a missing `notificationsMuted`/`threadMuted` as "muting not supported" (hide the buttons).
- Clients must still ignore notifications with an unknown `kind` (F007).

### Endpoints
| Method | Path | Body | Response |
|---|---|---|---|
| GET 🔒 | /api/notifications/mutes | – | `NotificationMuteList` |
| PUT 🔒 | /api/notifications/mutes/games/{gameId} | – | `MuteState` `{ muted: true }` (idempotent) |
| DELETE 🔒 | /api/notifications/mutes/games/{gameId} | – | `MuteState` `{ muted: false }` (idempotent) |
| PUT 🔒 | /api/notifications/mutes/threads/{commentId} | – | `MuteState` `{ muted: true }` (idempotent) |
| DELETE 🔒 | /api/notifications/mutes/threads/{commentId} | – | `MuteState` `{ muted: false }` (idempotent) |
| PUT 🔒 | /api/notifications/settings | `Partial<NotificationSettings>` (now including `pins`) | `NotificationSettings` |

- Request bodies are ignored on the four mute writes.
- **`PUT …/mutes/games/{gameId}`**, checked in this order:
  1. Auth → 401.
  2. `Limit::Notifications` → 429.
  3. `gameId` longer than 64 bytes, unknown, or not visible to the caller under `GET /api/games/{id}` rules → 404 `not_found` "Game not found".
  4. Already muted → 200 (no cap check; `createdAt` unchanged; step 6 still runs).
  5. The caller already has **500** mutes (games and threads together) → 422 `validation` "You can mute at most 500 games and threads; unmute some in Settings".
  6. Mute, and mark every **unread** notification of the caller with `game.id = gameId` as read (any kind). Returns `{ muted: true, unread }`.
- **`PUT …/mutes/threads/{commentId}`**, checked in this order:
  1. Auth → 401.
  2. `Limit::Notifications` → 429.
  3. `commentId` longer than 64 bytes, unknown, or its game not visible to the caller → 404 `not_found` "Comment not found".
  4. The comment is a reply → 422 `validation` "Only whole threads can be muted".
  5. Already muted → 200 (as above).
  6. 500 mutes → 422 (as above).
  7. Mute, and mark the caller's **unread** notifications in the thread's scope (below) as read. Returns `{ muted: true, unread }`.
  - A comment deleted between step 3 and the write → 404.
- **`DELETE …`** (both): auth → 401; `Limit::Notifications` → 429; then remove the caller's mute of that target if any. Never 404 (unknown, deleted, invisible and never-muted targets all return `{ muted: false, unread }`). Unmuting marks nothing unread and restores nothing.
- **`GET /api/notifications/mutes`**: auth → 401; `Limit::Notifications` → 429. Mutes whose game is not visible to the caller are kept but not listed.

### Mute scopes (server side; checked when a notification is written)
| Mute | Suppresses, for the muting user only |
|---|---|
| game `G` | every kind whose notification has `game.id = G`: `comment`, `reply`, `heart`, `pinned`, `gamePublished` |
| thread `T` (a top-level comment of game `G`) | `reply` in thread `T`; `heart` on `T` or on any reply in `T`; `pinned` of `T` |

- `follow` is never muted by these. A `comment` notification (new top-level comments on your game) is muted by a game mute only.
- Mutes and the per-kind settings both apply: a notification is written only when the kind is on **and** no mute matches.
- Mutes stop **new** events, including joining an existing unread group, and heart re-toggles while muted restore nothing (review 5 L5 rule).
- Mutes don't expire. They are removed by unmuting, or when the game, the thread's top-level comment or the user is deleted.

### Pinned notifications (server side; no new client calls)
| Kind | Written when | Recipient | Group | Joins an unread group? |
|---|---|---|---|---|
| `pinned` | `PUT /api/comments/{id}/pin` changes the comment from unpinned to pinned | the comment's author, unless they are the pinner | per comment | n/a (once per recipient and comment while any notification for it is stored) |

- Fields: `actors` = the pinner(s); `game`; `commentId` = the pinned comment; `excerpt` of it; `threadId` = the comment; `ownsThread` and `creatorHeart` false; `eventCount` = `actorCount`; `path` = `/games/{gameId}?comment={commentId}`.
- **Withdrawal.** When the comment is unpinned (`DELETE /api/comments/{id}/pin`, or replaced by another pin, i.e. it is the response's `unpinnedId`) and the author's `pinned` notification for it is still **unread**, it stops being listed and counted. Pinning it again while that withdrawn notification is stored restores it without changing its `updatedAt`. A read `pinned` notification is never changed.
- Lock and unlock still never notify (F017).
- Settings switch: `pins`.

### Retention and privacy
- F007 retention applies to `pinned` notifications unchanged.
- Mutes are private: no endpoint reveals who muted a game or thread.

### Rate limits
- The five new endpoints share **`Limit::Notifications`: 120/min, per user** with the F007 endpoints. Over the limit → 429 `rate_limited` with `Retry-After`.
- Pin notifications are written by the pin endpoints and don't use this bucket (they keep `Limit::ThreadTools`).

### Polling (client behaviour, informative)
Web clients coordinate tabs (spec § 2.6): in browsers with the Web Locks API and `BroadcastChannel`, one tab per user and server polls `GET /api/notifications/unread-count` and shares the result. The endpoint and its `pollAfterSecs` are unchanged.


---

## F021 additions

Collection activity: a `collectionUpdated` feed kind and an `addedToCollection` notification kind (spec: `docs/features/F021-collection-activity.md`). All earlier rules apply, including F002 (feed), F007 (notifications), F008 (collections) and F018 (mutes, group dedupe, withdrawal). **No new endpoints and no new rate limits.**

### Types
```ts
type FeedItemKind = "gamePublished" | "gameUpdated" | "personalBest" | "achievementUnlocked" | "collectionUpdated"

type FeedCollectionGame = {
  game: GameSummary;
  note: string;                   // the curator's current note for this game (F008 rules: 0–140 chars, single line); "" = none
}

type FeedCollection = {
  id: string;                     // collection id (UUID v4)
  title: string;                  // the collection's CURRENT title
  path: string;                   // "/c/{id}"
  games: FeedCollectionGame[];    // 1–4 entries, newest added first (see "Games of an item")
  gameCount: number;              // all games of the item (>= games.length >= 1)
}

type FeedItem = {
  ...F002 and F004,
  collection: FeedCollection | null;   // collectionUpdated only; null for every other kind
}
// For collectionUpdated: actor = the collection owner (the curator); game = collection.games[0].game;
// reason = "following"; version, score, achievement and update are null.

type NotificationKind = "comment" | "reply" | "heart" | "follow" | "gamePublished" | "pinned" | "addedToCollection"

type NotificationCollection = {
  id: string;
  title: string;                  // the collection's CURRENT title
  path: string;                   // "/c/{id}"
}

type Notification = {
  ...F007 and F018,
  collection: NotificationCollection | null;   // addedToCollection only; null for every other kind
}

type NotificationSettings = {
  ...F007 and F018,
  collections: boolean;           // "addedToCollection" kind; default true
}
```
- Clients must still ignore feed items and notifications with an unknown `kind` (F002, F007).
- Clients must treat a missing `collection` as `null` and a missing `collections` setting as "not supported" (hide the switch).

### Feed: event production
| Kind | Written when | Coalescing |
|---|---|---|
| `collectionUpdated` | `PUT /api/collections/{id}/games/{gameId}` returns `added: true`, or `POST /api/collections` creates a collection with `gameId`, **and** at that moment the collection is `public` and the game is published | one per collection per UTC day; each add replaces the day's row (new, higher `id`, so the item moves to the top) and puts the game first in its game list |

- Nothing is written for adds to private collections, for adds of unpublished games, for note changes (`added: false`), reorders, details changes, visibility changes or deletes. Changing a collection from private to public announces nothing.
- The check of the collection's visibility and the item insert are atomic (one transaction).
- Writing an event is best effort, as for F002 kinds. A request refused with 4xx (including 429) writes nothing.

### Feed: sources and visibility
A `collectionUpdated` event is included in `GET /api/feed` when **all** apply:
1. Its actor (the curator) is a user the viewer follows. (Favorites never add this kind.)
2. The actor is not the viewer.
3. The collection still exists, is `public`, and is still owned by the actor.
4. At least one game of the item exists (below).

**Games of an item** (evaluated at read time): the games announced by the item's adds that are (a) still in the collection, (b) whose current `addedAt` falls on the item's UTC day, and (c) published. Ordered newest add first. `games` holds the first 4 of them, `gameCount` all of them. A game added while the collection was private is never part of any item. A game removed and re-added on a later day belongs to the later day's item only.

- `kinds` accepts `"collectionUpdated"`; unknown values still → 400.
- Paging is unchanged (`id` cursor). An event that fails rule 4 at read time is skipped without affecting `nextCursor`.

### Notifications: trigger and recipient
| Kind | Written when | Recipient | Group | Joins an unread group? |
|---|---|---|---|---|
| `addedToCollection` | the same adds that write a `collectionUpdated` event (public collection, published game, `added: true`) | the game's owner, unless they are the curator | per (collection, game) | n/a (once per recipient, collection and game while any notification for it is stored) |

- Fields: `actors` = the curator; `actorCount` = `eventCount` = 1; `game` = the added game; `collection` = `{ id, title, path }`; `commentId`, `excerpt` and `threadId` null; `ownsThread` and `creatorHeart` false; `path` = `/c/{collectionId}`.
- **Withdrawal.** When the game is removed from the collection (`DELETE /api/collections/{id}/games/{gameId}` with `removed: true`) and the owner's notification for it is still **unread**, it stops being listed and counted. Adding it again while that withdrawn notification is stored (and the collection is public) restores it without changing its `updatedAt`. A read `addedToCollection` notification is never changed.
- **Settings:** `collections` (default true). `PUT /api/notifications/settings` accepts it; a non-boolean → 422.
- **Mutes (F018):** a game mute of the added game suppresses it (it has `game.id`), and muting the game marks an unread one read. Thread mutes never apply.
- **Visibility** (extends F007 "Visibility"): an `addedToCollection` notification is listed and counted only while its collection exists and is `public`, in addition to the F007 rules. Making the collection private hides it; making it public again shows it again unless it was pruned.
- **Deletions:** deleting the collection or the game deletes the notification. Retention (F007) is unchanged.

### Paths
| Kind | `path` |
|---|---|
| `addedToCollection` | `/c/{collectionId}` |

### Privacy
- No feed item or notification is ever produced by, or shown for, a private collection.
- OS notifications (desktop) for `addedToCollection` don't include the collection title (client rule, spec § 2.3).

### Rate limits
Unchanged. Events and notifications are written by the F008 collection endpoints, which keep `Limit::Collections`. Feed reads keep `Limit::Feed`; notification reads keep `Limit::Notifications`.


## Review-fix additions (REVIEW-2026-11-16-6)
- **`GET /api/games/{id}/comments`** (all sorts) may return 429 `rate_limited` with `Retry-After`: 120/min per user, or per IP when anonymous. The rate-limit check comes before the 404 for an unknown or hidden game.
- **"Top" comment sort** reads a trigger-maintained `comments.hearts` count through an index (migration `0018_review6.sql`). Response shapes and values are unchanged.
- **F018 mute cap:** the 500 cap counts only mutes on games the caller can currently see (the same rule as `GET /api/notifications/mutes`). Mutes on hidden games are kept, come back if the game is republished, and can always be deleted. The cap is enforced only when adding a mute, so the stored total, or the visible list after a republish, can exceed 500.
- **`JWT_SECRET`:** there is no built-in default secret any more. If it is unset, the server generates a random 256-bit secret at each start and logs a warning, so every restart signs everyone out. Production must set `JWT_SECRET`.

### F021 implementation note
- **Withdrawn "added to a collection" notifications stay stored:** if a game is added and then removed while its notification is unread, the notification is withdrawn. It is not listed or counted, but it stays in the database (re-adding restores it without moving it) and is deleted when the collection is. This follows the same pattern as F018 pinned notifications.


## F016 additions
Gamepad remapping and synced control bindings (spec: `docs/features/F016-gamepad-remapping-and-sync.md`). Two endpoints store a signed-in player's control bindings per game. Games can't read them; they reach the game only through the parent's `webgame:controls` message (GAME_FORMAT § F016).

### Types
```ts
type GamepadButtonName = "A" | "B" | "X" | "Y" | "LB" | "RB" | "LT" | "RT" | "Back" | "Start" | "LS" | "RS" | "Up" | "Down" | "Left" | "Right";   // F009 table
type ControlBindings = {
  keys:    { [actionId: string]: string[] };              // replaces the action's default keys; codes from the F009 bindable key table (Mouse0..2 allowed)
  gamepad: { [actionId: string]: GamepadButtonName[] };   // replaces the action's default gamepad buttons
}
type ControlBindingsResponse = { bindings: ControlBindings | null; updatedAt: string | null /*RFC3339*/ }
```

### Endpoints
| Method | Path | Body | Response |
|---|---|---|---|
| GET 🔒 | /api/games/{id}/controls | – | `ControlBindingsResponse`: `{ bindings: null, updatedAt: null }` when the caller has never stored bindings for this game |
| PUT 🔒 | /api/games/{id}/controls | `{ bindings: ControlBindings }` | 200 `{ bindings: ControlBindings, updatedAt: string }` (the normalised copy that was stored) |

- **Visibility**: both follow the cloud-save rule. The game must be visible to the caller: an unpublished game → 404 unless the caller owns it; an unknown id → 404. Anonymous → 401.
- **Validation** (`PUT`, strict; the first violation → 422 `validation` naming the path, e.g. `bindings.gamepad.jump[0] "Home" can't be bound`):
  - `bindings` must be a JSON object.
  - `keys` and `gamepad`: absent or `null` → `{}`; otherwise a JSON object with at most **32** own keys.
  - Every key (action id) matches `^[a-z0-9_-]{1,32}$`.
  - Every `keys` value is an array of at most **3** unique strings from the F009 bindable key table (86 codes).
  - Every `gamepad` value is an array of at most **2** unique names from the F009 gamepad table (16 names; `Home` is not allowed).
  - Empty arrays are allowed: they mean "no keys" or "no gamepad buttons" for that action.
  - Unknown fields inside `bindings` other than `keys` and `gamepad` are ignored.
- **Normalisation** (on `PUT` before storing, and on `GET` before returning):
  - Ids not declared by the game's **current** version are dropped.
  - Entries equal to that action's current defaults (same codes in the same order) are dropped.
  - `keys` and `gamepad` are listed in manifest order.
  - An empty result is stored and returned as `{ "keys": {}, "gamepad": {} }`. It is still a row, so the next `GET` returns it and **not** `null`.
- **Body limit**: request bodies above **16 KiB** → 413 `payload_too_large`.
- There is no `DELETE`. Deleting the game or the user deletes the bindings.

### Rate limits
- `PUT /api/games/{id}/controls`: **60/min per user** (`Limit::Controls`), checked after the visibility 404. Exceeding it → 429 `rate_limited` + `Retry-After`.
- `GET` is not rate limited (like `GET …/save`).

### Privacy
- Bindings are visible only to their owner. They are not part of `Game`, stats, profiles, the feed or any admin view.
- The server never receives controller names (`Gamepad.id`) or keyboard layouts.


### F016 implementation notes (backend)
- **Duplicates:** a duplicate entry within one action's list is a 422 (`bindings.keys.jump[1] "KeyA" is a duplicate`). `normalize_bindings` also removes duplicates, which protects rows that were stored earlier.
- **Error messages** name the failing path. Examples:
  - `bindings must be a JSON object`
  - `bindings.keys must be an object`
  - `bindings.keys must have at most 32 actions`
  - `bindings.keys "Jump!" is not a valid action id (^[a-z0-9_-]{1,32}$)`
  - `bindings.keys.jump must be an array`
  - `… must have at most 3 entries`
  - `…[0] must be a string`
  - `…[0] "Home" can't be bound`, used for any name not in the binding tables
- **Which error is reported:** when a body has several violations, `keys` is checked before `gamepad`, and action ids within each are checked in sorted order.
- **Null per action:** an action value of `null` (for example `"jump": null`) is a 422, because each action's value must be an array. This differs from the `game.json` rule, where `null` counts as `[]`.
- **Corrupt stored row:** a stored row that fails validation reads as no row (`bindings: null`) and is logged as a warning.
- **Games not yet backfilled:** for a game whose actions haven't been backfilled from F009 yet, a PUT normalises against an empty action list and stores `{keys:{}, gamepad:{}}`.
- **Check order:**
  - Authentication (401) comes first.
  - For signed-in callers, the body limit (413) and malformed JSON (400) come next, then visibility (404), then the rate limit (429).
  - Requests that fail before the rate-limit check don't use up rate-limit tokens.


## F019 additions
Engine UI widgets 2 (spec: `docs/features/F019-ui-widgets-2.md`). **No changes**: no new or changed endpoints, types, status codes, migrations, rate limits or bundle extensions. The feature is engine API only (GAME_FORMAT.md § F019 additions). The repacked example bundles must still pass the existing upload validation (`actions`, allowlist, size), which the backend suites already check.


## F020 additions
Game comment settings: comments on / replies only / off, and slow mode (spec: `docs/features/F020-game-comment-settings.md`). All earlier rules apply, including F006 (threads, validation order), F017 (locks, `canModerate`, `Limit::ThreadTools`) and the v2 error shape.

### Errors
- New code **`slow_mode`** → **429**, always with `Retry-After` (whole seconds, ≥ 1). Message: `Slow mode is on: you can post again in {n} seconds`, where `{n}` equals the `Retry-After` value (always "seconds", also for 1). It is used only by `POST /api/games/{id}/comments`. Clients that don't know it must treat it as a 429.

### Types
```ts
type CommentMode = "on" | "repliesOnly" | "off"
type SlowModeSecs = 0 | 30 | 60 | 300 | 900 | 3600     // 0 = slow mode off

type CommentSettings = {
  mode: CommentMode;              // "on" by default
  slowModeSecs: SlowModeSecs;     // 0 by default
}

type CommentSettingsView = CommentSettings & {
  canManage: boolean;             // 🔓 the viewer is the game's CURRENT owner or an admin: may change the settings and is exempt from mode and slow mode; false when anonymous
  waitSecs: number;               // 🔓 integer seconds until the viewer may post again under slow mode, 0..slowModeSecs; 0 when anonymous, when canManage, when slowModeSecs is 0, or when the wait is over
}

type Game = { ...F018, commentSettings: CommentSettings }          // public: the same for every viewer
type CommentListPage = { ...F017, settings: CommentSettingsView }  // returned on every page (clients read it from page 1)
```
- Clients must treat a missing `Game.commentSettings` as "unknown" (hide the settings UI) and a missing `CommentListPage.settings` as `{ mode: "on", slowModeSecs: 0, canManage: false, waitSecs: 0 }` (older servers).
- An unknown stored mode reads as `"on"`; an unknown stored interval reads as `0`.

### New endpoint
| Method | Path | Body | Response |
|---|---|---|---|
| PUT 🔒 owner/admin | /api/games/{id}/comment-settings | `{ mode: CommentMode, slowModeSecs: SlowModeSecs }` (both required) | 200 `CommentSettings` (the stored values) |

- "owner/admin" = the game's current owner, or a user with `role: "admin"`.
- Checked in this order:
  1. Auth → 401.
  2. Malformed JSON → 400 `bad_request`.
  3. Unknown game, or not visible to the caller under `GET /api/games/{id}` rules → 404 `not_found` "Game not found".
  4. Caller is not the owner or an admin → 403 `forbidden`.
  5. `Limit::ThreadTools` → 429 `rate_limited`.
  6. Body is not a JSON object → 422 `validation` `Body must be a JSON object`.
  7. `mode` missing or not exactly `"on"`, `"repliesOnly"` or `"off"` → 422 `validation` `mode must be one of: on, repliesOnly, off`.
  8. `slowModeSecs` missing or not a JSON integer in {0, 30, 60, 300, 900, 3600} → 422 `validation` `slowModeSecs must be one of: 0, 30, 60, 300, 900, 3600` (`"60"`, `60.5`, `true`, `null` are rejected).
- Unknown extra fields are ignored. Idempotent. Does **not** change `updatedAt` or `lastUpdatedAt`. Writes no F002 activity and no F007 notifications.

### Changed endpoints
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET 🔓 | /api/games/{id} | – | `Game` + `commentSettings` |
| GET 🔓 | /api/games/{id}/comments | F017 query | `CommentListPage` + `settings` |
| POST 🔒 | /api/games/{id}/comments | F006 body | 201 `Comment` |

- **`POST …/comments`**, the full validation order (F006 steps, F017 6b, F020 5b and 6c). "Exempt" = the poster is the game's current owner or an admin.
  1. Auth → 401.
  2. Game visibility → 404.
  3. `Limit::Comment` → 429 `rate_limited`.
  4. `parentId` not a string or `null` → 422.
  5. `body` trimmed length not 1–2000 → 422.
  - **5b.** Not exempt and mode `"off"` → 422 `validation` `Comments are turned off for this game`. Not exempt, mode `"repliesOnly"` and no `parentId` (top-level) → 422 `validation` `New comments are turned off for this game`.
  6. `parentId` unknown or on another game → 404 "Comment not found".
  - **6b.** (F017) Thread locked and not exempt → 422 "This thread is locked".
  - **6c.** Not exempt, `slowModeSecs > 0`, and the poster's last successful post on this game (top-level or reply, including posts since deleted and posts made while slow mode was off) was less than `slowModeSecs` ago → 429 `slow_mode` with `Retry-After` = `clamp(ceil(last + slowModeSecs − now), 1, slowModeSecs)`.
  7. Thread already has 200 replies → 422 "This thread has reached 200 replies".
- Steps 6b, 6c and 7 are enforced atomically with the insert: a rejected post never counts as the poster's last post, and two concurrent posts by one user under slow mode yield exactly one 201.
- Every successful post (by anyone, in any mode) updates the poster's last-post time for that game.
- The mode check (5b) is not atomic with the insert: a post racing a settings change may still be accepted.
- Hearts, deletes, reports, pins and locks are not affected by either setting. Existing comments are always listed.

### Rate limits
- `PUT /api/games/{id}/comment-settings` shares **`Limit::ThreadTools`** (60 per 10 min, per user) with the F017 pin/lock endpoints.
- Slow mode is a per-game setting enforced by the server, not a rate-limit bucket: it is unaffected by `RATE_LIMIT=off` and reported as `slow_mode`, not `rate_limited`. `Limit::Comment` still applies on top of it.


### F020 implementation notes (backend)
- **Body that isn't an object:** any valid JSON that isn't an object (`[]`, `"x"`, `5`, `null`) gets 422 `Body must be a JSON object`. That check comes after auth, the 404 and 403 checks and the rate limit.
- **Admins and unpublished games:** an admin gets 404 from `PUT …/comment-settings` on another user's unpublished game, the same as any non-owner.
- **Reply cap and slow mode:** the 200-reply cap is checked inside the slow-mode transaction. A capped reply rolls back and never uses up the slow-mode slot. A user still waiting out slow mode who replies to a full thread gets `slow_mode`.
- **Lock race:** if a thread is locked between the lock check and the transaction, the post fails with `slow_mode` instead of the lock error.
- **Wait times:** the wait is computed in milliseconds and rounded up, so `Retry-After` and `waitSecs` always agree on when the wait ends.
- **Unknown stored values:** an unknown `comment_mode` reads as `on` and an unknown `slow_mode_secs` reads as `0`. Both log a warning.

### F020 implementation notes (frontend)
- **429 errors in the client:** `ApiError.fromResponse` keeps `code: "slow_mode"`, the server's message and `retryAfter`. A 429 with any other code still becomes `rate_limited`.
- **Slow-mode 429 when the client's settings are stale:** if the client still has `slowModeSecs` at 0, the notice reads "Slow mode is on. You can post again in {m:ss}."
- **Reloading the first page:** fetching page 1 again restarts the countdown only when `waitSecs > 0`. It never clears a countdown that is already running.
- **Header:** the badges, the ⚙ Settings button and the sort toggle appear in that order.
