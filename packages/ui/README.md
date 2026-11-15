# @webgame/ui — Pixelforge Arcade GUI

Pure-GUI React 19 library: every page, the reusable components, the typed REST client (`docs/API.md`) and the
sandboxed game player (`docs/GAME_FORMAT.md`). It does **no bootstrapping** — hosts (`apps/web`, `apps/desktop`)
mount `<WebGameApp>`.

```
npm run build -w @webgame/ui   # vite lib build → dist/ui.js + dist/ui.css, then tsc → dist/types/*.d.ts
npm test -w @webgame/ui        # vitest + jsdom
npm run typecheck -w @webgame/ui
```

`react`, `react-dom` and `react-router-dom` are **externals** (not bundled); the host app provides them, so there is
exactly one React instance.

## Quick start

```tsx
import { WebGameApp } from "@webgame/ui";
import "@webgame/ui/style.css";

<WebGameApp config={{ apiBaseUrl: "http://localhost:8080", routerMode: "hash" }} />;
```

### `WebGameConfig`

| field | type | notes |
|---|---|---|
| `apiBaseUrl` | `string` | API origin. `""` = same origin. All server-relative URLs (`thumbnailUrl`, `avatarUrl`, `playUrl`) are resolved against it. |
| `routerMode` | `"browser" \| "hash"` | `BrowserRouter` for the web, `HashRouter` for Tauri / file-like origins. |
| `basename?` | `string` | Router basename. |
| `platform?.name` | `string` | Shown in the footer (e.g. `"Desktop"`). |
| `platform?.pickFile` | `(accept: string) => Promise<File \| null>` | Native file picker used by every file field (bundle, thumbnail, avatar, Studio "Open → .zip file…"). `accept` is an `<input accept>` string such as `".zip,application/zip"`. Return `null` on cancel. If absent, a hidden `<input type=file>` is used. Drag-and-drop always works. |
| `platform?.extraSettings` | `ReactNode` | Rendered as an extra panel on `/settings` (rendered inside the router + providers, so it may use `useAuth`, `useApi`, `useToast`, `Link`). |
| `platform?.openLocalProject` | `() => Promise<LocalProject \| null>` | Studio "Open → Local folder…" (desktop). May return `localFolder: { id, name }`, an opaque session-scoped handle that enables "Reload folder". Without it the Studio uses `<input webkitdirectory>`. |
| `platform?.reloadLocalProject` | `(folderId: string) => Promise<LocalProject \| null>` | F013: re-reads a folder picked earlier in the session (no dialog). Reject with an Error when the folder is gone; the Studio then hides "Reload folder". |
| `platform?.saveFile` | `(suggestedName: string, data: Blob) => Promise<boolean>` | Native "Save as" (desktop): Studio export, bundle download and screenshot download. Resolve `true` when saved, `false` on cancel. Without it an `<a download>` link is used. |

`<WebGameApp>` also accepts `client?: ApiClient` (custom fetch / tests) and `extraRoutes?: ReactNode`
(extra `<Route>` elements rendered inside the main layout, e.g. a desktop-only page).

### Host events

Hosts (e.g. native menus) drive the UI with `window` CustomEvents; each does nothing when its target isn't mounted.

| constant | event name | effect |
|---|---|---|
| `STUDIO_OPEN_FOLDER_EVENT` | `webgame:studio-open-folder` | Studio "Open folder" flow. |
| `PLAYER_SCREENSHOT_EVENT` | `webgame:player-screenshot` | 📷 capture in the mounted `GamePlayer` / `StudioPreview` (F005). |
| `PLAYER_CONTROLS_EVENT` | `webgame:player-controls` | Opens the controls panel of the mounted player (F009). |

## Routes

| path | page | auth |
|---|---|---|
| `/` | Home / browse (`?q=&tag=&sort=new\|trending\|popular\|top\|favorites&page=`), plus the "Trending this week" shelf | – |
| `/games/:id` | Game detail + player, rating, leaderboard, achievements, screenshots gallery, version history (`?section=versions`), comments, related games, owner actions | – |
| `/games/:id/edit` | Edit game (details, thumbnail, bundle replace with release notes, delete) | 🔒 |
| `/games/:id/stats` | Play statistics (owner) | 🔒 |
| `/upload` | Upload a game | 🔒 |
| `/dashboard` | My games (publish toggle, stats) (`?page=`) | 🔒 |
| `/favorites` | My favorites (`?page=`) | 🔒 |
| `/feed` | Activity feed of followed creators | 🔒 |
| `/studio` | In-browser Studio: editor, live preview, open (template / folder / .zip / my game, `?open={gameId}`), publish & publish update | – (publishing needs a session) |
| `/admin` | Moderation queue (`?status=open\|resolved&page=`); needs the `admin` role | 🔒 |
| `/u/:username` | Profile (`?page=`) | – |
| `/u/:username/followers`, `/u/:username/following` | Follow lists (`?page=`) | – |
| `/settings` | Profile, avatar, `platform.extraSettings` | 🔒 |
| `/login`, `/register` | Auth (`?next=/path` redirect) | – |
| `/docs` | "Make a game" creator guide | – |
| `*` | 404 | – |

## Exports

Everything is exported from the package root (`src/index.ts` is the source of truth). Main groups:

- **App:** `WebGameApp`, `WebGameProviders` (config + api + auth + toasts, no router), `WebGameRoutes` (the `<Routes>`; render inside your own router + `WebGameProviders` if you need full control).
- **API:** `ApiClient`, `ApiError` (`code`, `status`, `message`, `retryAfter`), `isApiError`, `buildQuery`, `resolveApiUrl`, `parseRetryAfter`, `rateLimitMessage`, `KEEPALIVE_MAX_BODY_BYTES`, and every type from `docs/API.md` (`export type *`).
- **Hooks / context:** `useApi()`, `useAuth()` (`user`, `token`, `loading`, `login`, `register`, `logout`, `setUser`, `refresh`), `useToast()`, `useConfig()`, `usePlatform()`, `useResolveUrl()`, `useModal()`, `TOKEN_STORAGE_KEY` (`"webgame.token"`), `readStoredToken()`, and the providers.
- **Player:** `GamePlayer`, `GAME_IFRAME_SANDBOX`, local/cloud save helpers (`readGameSave`, `writeGameSave`, …), leaderboard throttle constants, `usePauseReasons`.
- **Components:** `GameCard`, `GameGrid`, `GameCardSkeleton`, `StarRating`, `Leaderboard` (+ `leaderboard.ts` view helpers), `Comments`, `FileDrop`, `FavoriteButton`/`FavoritesProvider`, `FollowButton`/`FollowProvider`, `FeedItem`, `GameAchievements`/`RecentAchievements`, `ReportButton`/`ReportDialog`, `PlaysChart`, `RelatedGames`, `VersionHistory`, `ReleaseNotesField`, `Tabs`/`TabPanel`/`ToggleGroup`, `Layout`, `Header`, `Footer`, `Logo`, `RequireAuth`, and the primitives in `common.tsx` (`Avatar`, `UserLink`, `Thumbnail`, `Pagination`, `ProgressBar`, `Skeleton`, `Spinner`, `Alert`, `ConfirmDialog`, `EmptyState`, `ErrorState`, `LoadError`, …).
- **Screenshots (F005):** `useScreenshotCapture`, `ScreenshotTray`, `ScreenshotDialog`, `ScreenshotGallery`, `launderImage`, `sniffImage`, `readImageHeader`, `fitImageForUpload`, `browserImageCodec`, `screenshotFileName`, `sanitizeScreenshotCaption`, the `SCREENSHOT_*` limits, `SCREENSHOTS_CHANGED_EVENT`, `PLAYER_SCREENSHOT_EVENT`.
- **Controls (F009):** `ControlsPanel`, `ControlsSummary`, `KeyCaptureButton`, the action/override helpers from `controls.ts` (`validateActions`, `effectiveActions`, `readOverrides`, `useStoredOverrides`, `keyLabel`, …), `PLAYER_CONTROLS_EVENT`.
- **Studio:** `StudioPreview`, `CodeEditor`, `PublishDialog`, `OpenGameDialog`, `STUDIO_TEMPLATES`, the zip writer/reader (`createZip`, `createZipAsync`, `readZip`, `MAX_OPEN_ZIP_BYTES`) and the project helpers (`buildBundleZip`, `validateProject`, `projectFromZip`, `projectFromFileList`, …), `STUDIO_OPEN_FOLDER_EVENT`.
- **Pages:** `HomePage`, `GamePage`, `UploadPage`, `EditGamePage`, `DashboardPage`, `GameStatsPage`, `FavoritesPage`, `FeedPage`, `StudioPage`, `AdminPage`, `ProfilePage`, `FollowListPage`, `SettingsPage`, `LoginPage`, `RegisterPage`, `DocsPage`, `NotFoundPage`.
- **Utils:** `formatCount`, `formatDate`, `timeAgo`, `formatScore`, `formatTimeUntil`, `errorMessage`, `looksLikeZip`, `gameVersionsPath`, …

### ApiClient

```ts
const api = new ApiClient({ baseUrl: "http://localhost:8080", token });
await api.listGames({ sort: "top", tag: "arcade", page: 1, perPage: 24 });
await api.createGame({ title, bundle: zipFile, tags: ["arcade"] }, ({ fraction }) => setProgress(fraction));
```

JSON calls use `fetch`; multipart uploads (`createGame`, `replaceBundle`, `replaceThumbnail`, `uploadAvatar`,
`postScreenshot`) use `XMLHttpRequest` for upload progress. Every failure throws `ApiError`: server error envelopes
keep their `code` (and `retryAfter` on 429); network failures use `code: "network"`, `status: 0`.

## Game player security

`GamePlayer` renders `<iframe src="{apiBaseUrl}/play/{id}?v={version}" sandbox="allow-scripts allow-pointer-lock"
allow="fullscreen; gamepad; autoplay">`: **never** `allow-same-origin`, so game code has an opaque origin and cannot
read the token. `StudioPreview` uses the same sandbox on `/play/studio`. Messages are only accepted when
`event.source === iframe.contentWindow`, and malformed messages are ignored.

The full message table and the parent's rules are normative in [`docs/GAME_FORMAT.md`](../../docs/GAME_FORMAT.md);
this is the list of what the player handles:

| message | direction | what the parent does |
|---|---|---|
| `webgame:ready` | game → parent | `POST /api/games/{id}/play` once per load; enables 📷. |
| `webgame:hello` / `webgame:load` | game → parent / reply | Answers with the save (server copy when logged in, else localStorage); may send a later `load` with the server copy. Then `webgame:controls` if the game has actions. |
| `webgame:save` | game → parent | Writes localStorage (`webgame.save.{gameId}`, ≤ 256 KB), debounced `PUT …/save` when logged in. |
| `webgame:score` / `webgame:score-result` | game → parent / reply | Submits the score when logged in (toast + leaderboard refresh); with `requestId`, replies with a result or `anonymous` / `rate_limited` / `failed` (`studio` in the Studio). |
| `webgame:leaderboard-get` / `webgame:leaderboard` | game → parent / reply | Cached, throttled, sanitised `LeaderboardView` (no ids, tokens or avatars); sample data in the Studio. |
| `webgame:achievement` | game → parent | Unlocks via the API (toast); "would unlock" in the Studio. |
| `webgame:error` | game → parent | Error overlay with restart (Studio: console with file/line). |
| `webgame:fullscreen` | game → parent | Fullscreens the player wrapper (not the iframe). |
| `webgame:screenshot-request` / `webgame:screenshot` | parent → game / reply | 📷 capture: one in flight, 5 s timeout. |
| `webgame:screenshot` (`source: "game"`) / `webgame:screenshot-result` | game → parent / reply | Game share: 1 per 3 s and 20 per mount (a failed share keeps its slot), else `rate_limited`; `invalid` when laundering fails. |
| `webgame:mute` | parent → game | Mute button. |
| `webgame:pause` / `webgame:resume` | parent → game | Tab hidden, controls panel open. |
| `webgame:controls` | parent → game | Key overrides from the controls panel (F009). |
| `webgame:studio-ready` / `webgame:studio-load` | page → parent / reply | Studio only: the parent sends the in-memory project. |

Screenshot images from a game are untrusted: `launderImage` checks the size (≤ 8 MiB), the magic bytes (PNG, JPEG
or WebP only) and the header dimensions (each side 1–4096, ≤ 4096² pixels) **before** `createImageBitmap`, then
re-encodes to PNG. Only that PNG is ever displayed, downloaded, copied or uploaded.

Owner preview of an unpublished game appends `?token=` as specified for `/play/{id}`.

## Embedding in the desktop app (Tauri)

```tsx
import { WebGameApp } from "@webgame/ui";
import "@webgame/ui/style.css";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

async function pickFile(accept: string): Promise<File | null> {
  const exts = accept.split(",").map((s) => s.trim()).filter((s) => s.startsWith(".")).map((s) => s.slice(1));
  const path = await open({ multiple: false, filters: exts.length ? [{ name: "Files", extensions: exts }] : [] });
  if (typeof path !== "string") return null;
  const bytes = await readFile(path);
  return new File([bytes], path.split(/[\\/]/).pop() ?? "file");
}

createRoot(root).render(
  <WebGameApp
    config={{
      apiBaseUrl: serverUrl, // absolute, e.g. "http://localhost:8080" (must be in backend CORS_ORIGINS)
      routerMode: "hash",
      platform: { name: "Desktop", pickFile, extraSettings: <ServerUrlSettings /> },
    }}
  />,
);
```

Notes for desktop:
- Use `routerMode: "hash"` (the Tauri origin has no SPA fallback).
- `apiBaseUrl` must be absolute; changing it at runtime: re-mount `<WebGameApp key={serverUrl} …>`.
- The token lives in the webview's `localStorage` under `webgame.token`.
- `window.confirm` is never used (in-page dialogs instead), so no dialog plugin is required by the UI itself.
