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
| `platform?.pickFile` | `(accept: string) => Promise<File \| null>` | Native file picker used by every file field (bundle, thumbnail, avatar). `accept` is an `<input accept>` string such as `".zip,application/zip,application/x-zip-compressed"`. Return `null` on cancel. If absent, a hidden `<input type=file>` is used. Drag-and-drop always works. |
| `platform?.extraSettings` | `ReactNode` | Rendered as an extra panel on `/settings` (rendered inside the router + providers, so it may use `useAuth`, `useApi`, `useToast`, `Link`). |

`<WebGameApp>` also accepts `client?: ApiClient` (custom fetch / tests) and `extraRoutes?: ReactNode`
(extra `<Route>` elements rendered inside the main layout, e.g. a desktop-only page).

## Routes

| path | page | auth |
|---|---|---|
| `/` | Home / browse (`?q=&tag=&sort=new\|popular\|top&page=`) | – |
| `/games/:id` | Game detail + player, rating, leaderboard, comments, owner actions | – |
| `/games/:id/edit` | Edit game (details, thumbnail, bundle, delete) | 🔒 |
| `/upload` | Upload a game | 🔒 |
| `/dashboard` | My games (publish toggle, stats) | 🔒 |
| `/u/:username` | Profile | – |
| `/settings` | Profile, avatar, `platform.extraSettings` | 🔒 |
| `/login`, `/register` | Auth (`?next=/path` redirect) | – |
| `/docs` | "Make a game" creator guide | – |
| `*` | 404 | – |

## Exports

- **App:** `WebGameApp`, `WebGameProviders` (config + api + auth + toasts, no router), `WebGameRoutes` (the `<Routes>`; render inside your own router + `WebGameProviders` if you need full control).
- **API:** `ApiClient`, `ApiError` (`code`, `status`, `message`), `isApiError`, `buildQuery`, `resolveApiUrl`, and all types from `docs/API.md` (`User`, `UserRef`, `Game`, `GameSummary`, `Page<T>`, `Comment`, `Score`, `TagCount`, `AuthResponse`, request types…).
- **Hooks / context:** `useApi()`, `useAuth()` (`user`, `token`, `loading`, `login`, `register`, `logout`, `setUser`, `refresh`), `useToast()`, `useConfig()`, `usePlatform()`, `useResolveUrl()`, `TOKEN_STORAGE_KEY` (`"webgame.token"`), `readStoredToken()`.
- **Components:** `GamePlayer`, `GAME_IFRAME_SANDBOX`, `GameCard`, `GameGrid`, `GameCardSkeleton`, `StarRating`, `Leaderboard`, `Comments`, `FileDrop`, `Layout`, `Header`, `Footer`, `Logo`, `RequireAuth`, `Avatar`, `UserLink`, `Thumbnail`, `FallbackArt`, `TagChip`, `Pagination`, `ProgressBar`, `Skeleton`, `Spinner`, `EmptyState`, `ErrorState`, `Alert`, `ConfirmDialog`, `StarsDisplay`.
- **Pages:** `HomePage`, `GamePage`, `UploadPage`, `EditGamePage`, `DashboardPage`, `ProfilePage`, `SettingsPage`, `LoginPage`, `RegisterPage`, `DocsPage`, `NotFoundPage`.

### ApiClient

```ts
const api = new ApiClient({ baseUrl: "http://localhost:8080", token });
await api.listGames({ sort: "top", tag: "arcade", page: 1, perPage: 24 });
await api.createGame({ title, bundle: zipFile, tags: ["arcade"] }, ({ fraction }) => setProgress(fraction));
```

JSON calls use `fetch`; multipart uploads (`createGame`, `replaceBundle`, `replaceThumbnail`, `uploadAvatar`) use
`XMLHttpRequest` for upload progress. Every failure throws `ApiError` — server error envelopes keep their `code`;
network failures use `code: "network"`, `status: 0`.

## Game player security

`GamePlayer` renders `<iframe src="{apiBaseUrl}/play/{id}?v={version}" sandbox="allow-scripts allow-pointer-lock"
allow="fullscreen; gamepad; autoplay">` — **never** `allow-same-origin`, so game code has an opaque origin and cannot
read the token. Messages are only accepted when `event.source === iframe.contentWindow`:

- `webgame:ready` → `POST /api/games/{id}/play` once per load.
- `webgame:score` → `POST /api/games/{id}/scores` if logged in (toast + leaderboard refresh), else a "log in" toast.
- `webgame:error` → error overlay with restart.
- The player posts `webgame:mute` (mute button), `webgame:pause`/`webgame:resume` (tab hidden/visible).
- Fullscreen is requested on the player wrapper, not the iframe.
- Owner preview of an unpublished game appends `?token=` as specified for `/play/{id}`.

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
