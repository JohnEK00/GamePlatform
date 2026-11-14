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
