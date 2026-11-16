import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Game, Score, ScoreSubmitResult, UnlockAchievementResponse } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage, formatScore } from "../util";
import { Spinner } from "./common";
import { AchievementIcon } from "./Achievements";
import { ScreenshotTray } from "./ScreenshotTray";
import { useScreenshotCapture } from "./useScreenshotCapture";
import { ControlsPanel } from "./ControlsPanel";
import { usePauseReasons } from "./usePauseReasons";
import {
  controlsMessage,
  hasControls,
  normalizeActions,
  PLAYER_CONTROLS_EVENT,
  readOverrides,
  subscribeOverrides,
  takeControlsHint,
  useStoredOverrides,
  writeOverrides,
} from "../controls";
import {
  GAME_LEADERBOARD_MAX_LIMIT,
  isRequestId,
  parseLeaderboardRequest,
  scoreToastText,
  sliceLeaderboardView,
  toLeaderboardView,
  toScoreResultView,
  type LeaderboardView,
} from "../leaderboard";

export type GamePlayerGame = Pick<Game, "id" | "title" | "width" | "height"> &
  Partial<Pick<Game, "playUrl" | "version" | "published" | "isOwner" | "leaderboard" | "actions" | "controlsHint">>;

/** F009: how long the one-time "See and change the controls" hint stays up. */
export const CONTROLS_HINT_MS = 8000;

export type GamePlayerProps = {
  game: GamePlayerGame;
  /** Called after POST /play succeeded (once per load, when the game reports ready). */
  onPlayRecorded?: (plays: number) => void;
  /** Called after a score was saved to the API (use it to refresh the leaderboard). F001: receives the ScoreSubmitResult. */
  onScoreSubmitted?: (score: Score & Partial<ScoreSubmitResult>) => void;
  /** Called after POST …/achievements/{id} succeeded (v2), whether or not it was new. */
  onAchievementUnlocked?: (result: UnlockAchievementResponse) => void;
  /** F005: after "Set as thumbnail" from the screenshot tray (owner only). */
  onGameUpdated?: (game: Game) => void;
  className?: string;
};

/** How long `webgame:hello` waits for the cloud save prefetch before answering with local data (GAME_FORMAT v2). */
export const CLOUD_LOAD_TIMEOUT_MS = 400;
/** Minimum delay between a `webgame:save` and the cloud PUT (and between PUTs). */
export const CLOUD_SAVE_DEBOUNCE_MS = 2000;

/** F001: how long a per-period leaderboard answer is reused for in-game requests. */
export const GAME_LEADERBOARD_CACHE_MS = 10_000;
/**
 * N4: per player instance, at most this many in-game leaderboard API fetches per
 * `GAME_LEADERBOARD_THROTTLE_WINDOW_MS`. Requests beyond that (that aren't served from cache or an
 * in-flight fetch) are answered locally with `error: "rate_limited"` without hitting the API, so a game
 * can't drain the viewer's shared leaderboard rate-limit bucket.
 */
export const GAME_LEADERBOARD_THROTTLE_MAX = 10;
export const GAME_LEADERBOARD_THROTTLE_WINDOW_MS = 10_000;

type LbOutcome = { leaderboard: LeaderboardView } | { error: "unavailable" | "rate_limited" };
type LbCacheEntry = { at: number; value?: LbOutcome; inflight?: Promise<LbOutcome> };

const ACHIEVEMENT_ID_RE = /^[a-z0-9_-]{1,32}$/;
const ACH_HINT_KEY = "webgame.achievementHintShown";
let achHintShownFallback = false;

/** True the first time per browser session (used for the "Log in to earn achievements" hint). */
function takeAchievementHint(): boolean {
  try {
    if (sessionStorage.getItem(ACH_HINT_KEY)) return false;
    sessionStorage.setItem(ACH_HINT_KEY, "1");
    return true;
  } catch {
    if (achHintShownFallback) return false;
    achHintShownFallback = true;
    return true;
  }
}

type CloudWriter = { discard: () => Promise<void> };
const cloudWriters = new Map<string, Set<CloudWriter>>();

/**
 * Drops any not-yet-sent cloud save for a game and waits for an in-flight PUT to finish. Call this before
 * DELETE …/save so a pending debounced write can't resurrect the data.
 */
export async function discardPendingCloudSave(gameId: string): Promise<void> {
  const set = cloudWriters.get(gameId);
  if (!set) return;
  await Promise.all([...set].map((w) => w.discard()));
}

type CloudState = {
  status: "off" | "pending" | "done" | "failed";
  data: Record<string, unknown> | null;
  /** A webgame:save arrived: local data is now newer than the prefetched server copy. */
  savedSinceFetch: boolean;
  listeners: Set<() => void>;
};

/** The exact sandbox for untrusted game code. NEVER add allow-same-origin. */
export const GAME_IFRAME_SANDBOX = "allow-scripts allow-pointer-lock";

/** Treat preview tokens as expired slightly early to absorb clock skew / load latency. */
const PREVIEW_EXPIRY_SKEW_MS = 30_000;

/** Max serialized size (UTF-8 bytes of the JSON) of a game's persisted storage (GAME_FORMAT.md). */
export const GAME_SAVE_MAX_BYTES = 256 * 1024;

/** localStorage key holding a game's persisted `engine.storage` data. */
export function gameSaveKey(gameId: string): string {
  return `webgame.save.${gameId}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (Object.prototype.toString.call(v) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(v);
  // postMessage structured-clones into our realm, so the prototype is our Object.prototype (or null).
  return proto === Object.prototype || proto === null;
}

/** Reads a game's saved data (a plain object) or null. Never throws. */
export function readGameSave(gameId: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(gameSaveKey(gameId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persists a game's saved data. Returns false (and warns) if it is not a plain object, too large, or storage fails. */
export function writeGameSave(gameId: string, data: unknown): boolean {
  if (!isPlainObject(data)) {
    console.warn("[webgame] ignoring save: data must be a plain object");
    return false;
  }
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    console.warn("[webgame] ignoring save: data is not serializable");
    return false;
  }
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > GAME_SAVE_MAX_BYTES) {
    console.warn(`[webgame] ignoring save: ${bytes} bytes exceeds the ${GAME_SAVE_MAX_BYTES} byte limit`);
    return false;
  }
  try {
    localStorage.setItem(gameSaveKey(gameId), json);
    return true;
  } catch (e) {
    console.warn("[webgame] could not persist save data", e);
    return false;
  }
}

/** Removes a game's saved data. Never throws. */
export function clearGameSave(gameId: string): void {
  try {
    localStorage.removeItem(gameSaveKey(gameId));
  } catch {
    /* storage unavailable */
  }
}

/** True if the game has saved data in this browser. */
export function hasGameSave(gameId: string): boolean {
  try {
    return localStorage.getItem(gameSaveKey(gameId)) !== null;
  } catch {
    return false;
  }
}

type GameMessage =
  | { type: "webgame:ready" }
  | { type: "webgame:score"; score: number; requestId?: string }
  | { type: "webgame:leaderboard-get"; requestId: string; period: string; limit: number }
  | { type: "webgame:error"; message?: string }
  | { type: "webgame:hello" }
  | { type: "webgame:save"; data: unknown }
  | { type: "webgame:fullscreen" }
  | { type: "webgame:achievement"; id: string }
  | { type: string; [k: string]: unknown };

/**
 * Sandboxed iframe player. Untrusted game code runs at an opaque origin and can only talk to us via
 * postMessage; messages are accepted ONLY when `event.source === iframe.contentWindow`.
 */
export function GamePlayer({ game, onPlayRecorded, onScoreSubmitted, onAchievementUnlocked, onGameUpdated, className = "" }: GamePlayerProps) {
  const api = useApi();
  const { user, token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cameraRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const playRecorded = useRef(false);
  // F005: 📷 requests, game shares, PLAYER_SCREENSHOT_EVENT and the in-memory tray.
  const shots = useScreenshotCapture(iframeRef, { mode: "player", title: game.title, ready: ready && !error });

  // F009: declared actions (defaults), the hint, on-device overrides and the ⌨ panel.
  const defaults = useMemo(() => normalizeActions(game.actions), [game.actions]);
  const controlsHint = (game.controlsHint ?? "").trim();
  const showControls = hasControls(defaults, controlsHint);
  const overrides = useStoredOverrides(game.id);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [controlsHinting, setControlsHinting] = useState(false);

  // Latest values for the message handler without re-subscribing.
  const latest = useRef({ user, token, onPlayRecorded, onScoreSubmitted, onAchievementUnlocked, game, defaults, showControls, controlsOpen });
  latest.current = { user, token, onPlayRecorded, onScoreSubmitted, onAchievementUnlocked, game, defaults, showControls, controlsOpen };
  /** Achievement ids already sent (or being sent) by this player instance. */
  const unlocked = useRef(new Set<string>());
  /**
   * F001/N4: per-(viewer, period) cache with single flight for in-game leaderboard reads. Always fetches
   * the maximum page (25) and slices to the requested limit, so at most 3 keys exist per viewer.
   */
  const lbCache = useRef(new Map<string, LbCacheEntry>());
  /** N4: timestamps of recent in-game leaderboard API fetches (sliding-window throttle). */
  const lbFetches = useRef<number[]>([]);
  useEffect(() => {
    lbCache.current = new Map();
    lbFetches.current = [];
  }, [game.id]);

  // ---- Cloud saves (GAME_FORMAT v2): prefetch as soon as the player mounts when logged in ----
  const cloud = useRef<CloudState>({ status: "off", data: null, savedSinceFetch: false, listeners: new Set() });
  useEffect(() => {
    const st: CloudState = { status: token ? "pending" : "off", data: null, savedSinceFetch: false, listeners: new Set() };
    cloud.current = st;
    if (!token) return;
    let alive = true;
    const settle = (status: CloudState["status"], data: Record<string, unknown> | null) => {
      if (!alive) return;
      st.status = status;
      st.data = data;
      const ls = [...st.listeners];
      st.listeners.clear();
      ls.forEach((l) => l());
    };
    api.getSave(game.id).then(
      (r) => settle("done", isPlainObject(r?.data) ? r.data : null),
      () => settle("failed", null),
    );
    return () => {
      alive = false;
    };
  }, [api, game.id, token]);

  // Debounced cloud writer: at most one PUT per CLOUD_SAVE_DEBOUNCE_MS, always sending the latest data;
  // flushed on unmount / pagehide.
  const cloudWrite = useRef<((data: Record<string, unknown>) => void) | null>(null);
  useEffect(() => {
    const gameId = game.id;
    let pending: Record<string, unknown> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: Promise<void> | null = null;
    const arm = (ms: number) => {
      if (timer === null) timer = setTimeout(() => flush(), ms);
    };
    // `final`: the page is going away (pagehide / unmount). Use fetch keepalive so the browser doesn't cancel
    // the PUT; ApiClient falls back to a normal request for bodies over the keepalive quota. The data is
    // already in localStorage either way (written before the debounce).
    function flush(final = false) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const data = pending;
      pending = null;
      if (!data || !latest.current.token) return;
      const p: Promise<void> = (final ? api.putSave(gameId, data, { keepalive: true }) : api.putSave(gameId, data)).then(
        () => {},
        (e: unknown) => {
          if (isApiError(e) && e.code === "rate_limited") {
            if (!pending) pending = data;
            arm(Math.max(CLOUD_SAVE_DEBOUNCE_MS, (e.retryAfter ?? 5) * 1000));
          } else {
            console.warn("[webgame] cloud save failed", e);
          }
        },
      );
      inflight = p;
      void p.then(() => {
        if (inflight === p) inflight = null;
      });
    }
    const writer: CloudWriter = {
      discard: async () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        pending = null;
        if (inflight) await inflight;
      },
    };
    let set = cloudWriters.get(gameId);
    if (!set) cloudWriters.set(gameId, (set = new Set()));
    const writers = set;
    writers.add(writer);
    cloudWrite.current = (data) => {
      pending = data;
      arm(CLOUD_SAVE_DEBOUNCE_MS);
    };
    const onPageHide = () => flush(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flush(true);
      cloudWrite.current = null;
      writers.delete(writer);
      if (writers.size === 0 && cloudWriters.get(gameId) === writers) cloudWriters.delete(gameId);
    };
  }, [api, game.id]);

  // Owner preview of an unpublished game (see API.md /play/{id}): the iframe gets a short-lived,
  // preview-scoped token from POST /api/games/{id}/preview-token. The session JWT NEVER goes into
  // the iframe URL (untrusted code + URLs leak via history, logs, etc.).
  const needsPreview = game.published === false && !!game.isOwner && !!token;
  const [preview, setPreview] = useState<{ gameId: string; token: string; expiresAt: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  // Expiry is only checked when (re)loading the iframe (effect below), never on plain re-renders, so a
  // running game is not torn down when its already-used token expires.
  const previewReady = !!preview && preview.gameId === game.id;

  useEffect(() => {
    if (!needsPreview) return;
    // A token minted for this game that is still valid can be reused; otherwise (first mount,
    // remount, restart after expiry, game switch) mint a fresh one before loading the iframe.
    const cur = previewRef.current;
    if (cur && cur.gameId === game.id && cur.expiresAt - PREVIEW_EXPIRY_SKEW_MS > Date.now()) return;
    let cancelled = false;
    setPreviewError(null);
    setPreview(null);
    api.createPreviewToken(game.id).then(
      (r) => {
        if (cancelled) return;
        const exp = Date.parse(r.expiresAt);
        setPreview({ gameId: game.id, token: r.token, expiresAt: Number.isFinite(exp) ? exp : Date.now() + 60_000 });
      },
      (e) => {
        if (!cancelled) setPreviewError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, game.id, needsPreview, token, reloadKey, previewRetry]);

  let src: string | null = api.url(game.playUrl || `/play/${encodeURIComponent(game.id)}`);
  const params: string[] = [];
  if (needsPreview) {
    if (previewReady) params.push(`token=${encodeURIComponent(preview!.token)}`);
    else src = null; // wait for the preview token
  }
  if (game.version !== undefined) params.push(`v=${game.version}`);
  if (src && params.length) src += (src.includes("?") ? "&" : "?") + params.join("&");

  const post = useCallback((msg: object) => {
    // Opaque-origin iframe: "*" is the only usable target origin.
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  useEffect(() => {
    setReady(false);
    setError(null);
    playRecorded.current = false;
  }, [game.id, game.version, reloadKey]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return;
      const data = event.data as GameMessage | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;
      const { user: u, onPlayRecorded: onPlay, onScoreSubmitted: onScore, onAchievementUnlocked: onAch, game: g } = latest.current;

      switch (data.type) {
        case "webgame:hello": {
          // Reply directly to the verified source (the game frame); opaque origin => "*".
          const source = event.source as Window;
          let controlsSent = false;
          const reply = (d: Record<string, unknown> | null) => {
            source.postMessage({ type: "webgame:load", data: d }, "*");
            // F009: right after the first load reply to each hello (restarts too). Reads the latest actions and
            // overrides when it runs, which may be after the cloud-load timeout.
            if (controlsSent) return;
            controlsSent = true;
            const { defaults: d0, game: g0 } = latest.current;
            if (d0.length > 0) source.postMessage(controlsMessage(d0, readOverrides(g0.id)), "*");
          };
          const st = cloud.current;
          const best = (): Record<string, unknown> | null => {
            if (st.status === "done" && st.data && !st.savedSinceFetch) {
              writeGameSave(g.id, st.data); // keep the local fallback in sync with the server copy
              return st.data;
            }
            return readGameSave(g.id);
          };
          if (st.status !== "pending") {
            reply(best());
            return;
          }
          // Wait briefly for the prefetch; fall back to local data after CLOUD_LOAD_TIMEOUT_MS.
          let answered = false;
          const timer = setTimeout(() => {
            answered = true;
            reply(readGameSave(g.id));
          }, CLOUD_LOAD_TIMEOUT_MS);
          st.listeners.add(() => {
            if (!answered) {
              answered = true;
              clearTimeout(timer);
              reply(best());
              return;
            }
            // Late arrival: send the server copy as an extra webgame:load (the engine merges it) — only to the
            // same, still-mounted frame, and only if the game hasn't saved newer data meanwhile.
            if (st.status === "done" && st.data && !st.savedSinceFetch && iframeRef.current?.contentWindow === source) {
              writeGameSave(g.id, st.data);
              reply(st.data);
            }
          });
          return;
        }
        case "webgame:save": {
          const saveData = (data as { data?: unknown }).data;
          if (!writeGameSave(g.id, saveData)) return;
          cloud.current.savedSinceFetch = true;
          if (latest.current.token) cloudWrite.current?.(saveData as Record<string, unknown>);
          return;
        }
        case "webgame:achievement": {
          const achId = (data as { id?: unknown }).id;
          if (typeof achId !== "string" || !ACHIEVEMENT_ID_RE.test(achId)) return;
          if (!u) {
            if (takeAchievementHint())
              toast.show({
                kind: "info",
                title: "Log in to earn achievements",
                message: "Achievements unlocked while logged out aren't saved.",
                action: { label: "Log in", onClick: () => navigate(`/login?next=${encodeURIComponent(`/games/${g.id}`)}`) },
                duration: 8000,
              });
            return;
          }
          if (unlocked.current.has(achId)) return;
          unlocked.current.add(achId);
          api.unlockAchievement(g.id, achId).then(
            (r) => {
              const a = r.achievement;
              if (r.new)
                toast.show({
                  kind: "success",
                  title: `Achievement unlocked: ${a.name}`,
                  message: a.description || undefined,
                  icon: <AchievementIcon iconUrl={a.iconUrl} seed={`${g.id}:${a.id}`} size={36} />,
                  duration: 6000,
                });
              onAch?.(r);
            },
            (e: unknown) => {
              if (isApiError(e) && e.status === 404) {
                console.warn(`[webgame] achievement "${achId}" is not defined in game.json`);
                return;
              }
              unlocked.current.delete(achId); // allow a retry on the next unlock
              if (isApiError(e) && e.code === "rate_limited") toast.error("Couldn't save achievement", e.message);
            },
          );
          return;
        }
        case "webgame:fullscreen": {
          const wrap = wrapRef.current;
          if (!wrap || document.fullscreenElement === wrap) return;
          // Browsers may reject this without a user gesture; fail silently.
          try {
            const p = wrap.requestFullscreen?.();
            if (p && typeof p.catch === "function") p.catch(() => {});
          } catch {
            /* ignore */
          }
          return;
        }
        case "webgame:ready": {
          setReady(true);
          setError(null);
          // F009: the one-time "See and change the controls" hint (games with actions only).
          if (latest.current.defaults.length > 0 && !latest.current.controlsOpen && takeControlsHint(g.id)) setControlsHinting(true);
          if (playRecorded.current) return;
          playRecorded.current = true;
          api.recordPlay(g.id).then(
            (r) => onPlay?.(r.plays),
            () => {
              /* non-critical */
            },
          );
          return;
        }
        case "webgame:leaderboard-get": {
          const req = parseLeaderboardRequest(data as Record<string, unknown>);
          if (!req) return;
          const source = event.source as Window;
          const key = `${u?.id ?? ""}|${req.period}`;
          const cache = lbCache.current;
          const now = Date.now();
          const entry = cache.get(key);
          let outcome: Promise<LbOutcome>;
          if (entry?.inflight) outcome = entry.inflight;
          else if (entry?.value && now - entry.at < GAME_LEADERBOARD_CACHE_MS) outcome = Promise.resolve(entry.value);
          else {
            const fetches = lbFetches.current.filter((t) => now - t < GAME_LEADERBOARD_THROTTLE_WINDOW_MS);
            lbFetches.current = fetches;
            if (fetches.length >= GAME_LEADERBOARD_THROTTLE_MAX) {
              try {
                source.postMessage({ type: "webgame:leaderboard", requestId: req.requestId, leaderboard: null, error: "rate_limited" }, "*");
              } catch {
                /* frame gone */
              }
              return;
            }
            fetches.push(now);
            const viewerId = u?.id ?? null;
            const fallback = g.leaderboard;
            const e: LbCacheEntry = { at: now };
            e.inflight = api.getLeaderboard(g.id, { period: req.period, limit: GAME_LEADERBOARD_MAX_LIMIT }).then(
              (lb): LbOutcome => ({ leaderboard: toLeaderboardView(lb, viewerId, fallback) }),
              (err: unknown): LbOutcome => ({ error: isApiError(err) && err.code === "rate_limited" ? "rate_limited" : "unavailable" }),
            );
            e.inflight.then((v) => {
              e.inflight = undefined;
              if ("leaderboard" in v) {
                e.value = v;
                e.at = Date.now();
              } else if (cache.get(key) === e) cache.delete(key);
            });
            cache.set(key, e);
            outcome = e.inflight;
          }
          outcome.then((v) => {
            const msg = "leaderboard" in v
              ? { type: "webgame:leaderboard", requestId: req.requestId, leaderboard: sliceLeaderboardView(v.leaderboard, req.limit) }
              : { type: "webgame:leaderboard", requestId: req.requestId, leaderboard: null, error: v.error };
            try {
              source.postMessage(msg, "*");
            } catch {
              /* frame gone */
            }
          });
          return;
        }
        case "webgame:score": {
          const raw = (data as { score?: unknown }).score;
          const n = typeof raw === "number" ? raw : Number(raw);
          if (!Number.isFinite(n)) return;
          const score = Math.round(n);
          const rid = (data as { requestId?: unknown }).requestId;
          const requestId = isRequestId(rid) ? rid : null;
          const source = event.source as Window;
          const replyScore = (result: ReturnType<typeof toScoreResultView> | null, err?: "anonymous" | "rate_limited" | "failed") => {
            if (!requestId) return;
            try {
              source.postMessage(
                err ? { type: "webgame:score-result", requestId, result: null, error: err } : { type: "webgame:score-result", requestId, result },
                "*",
              );
            } catch {
              /* frame gone */
            }
          };
          const format = g.leaderboard?.format === "time" ? "time" : "number";
          if (!u) {
            replyScore(null, "anonymous");
            toast.show({
              kind: "info",
              title: `You scored ${formatScore(score, format)}!`,
              message: "Log in to save your score to the leaderboard.",
              action: { label: "Log in", onClick: () => navigate(`/login?next=${encodeURIComponent(`/games/${g.id}`)}`) },
              duration: 8000,
            });
            return;
          }
          api.submitScore(g.id, score).then(
            (s) => {
              const t = scoreToastText(s, format);
              toast.success(t.title, t.message);
              replyScore(toScoreResultView(s, format));
              // Drop cached boards so the game's next read reflects this score.
              lbCache.current.clear();
              onScore?.(s);
            },
            (e) => {
              replyScore(null, isApiError(e) && e.code === "rate_limited" ? "rate_limited" : "failed");
              toast.error("Couldn't save your score", errorMessage(e));
            },
          );
          return;
        }
        case "webgame:error": {
          const m = (data as { message?: unknown }).message;
          setError(typeof m === "string" && m ? m.slice(0, 500) : "The game crashed.");
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [api, toast, navigate]);

  // Parent pause reasons (F009): the tab is hidden and/or the controls panel is open. Pause when the set becomes
  // non-empty, resume only when it is empty again.
  const setPause = usePauseReasons(post);
  const wasControlsOpen = useRef(false);
  useEffect(() => {
    setPause("controls", controlsOpen);
    if (controlsOpen) setControlsHinting(false);
    else if (wasControlsOpen.current) iframeRef.current?.focus(); // keys go back to the game
    wasControlsOpen.current = controlsOpen;
  }, [controlsOpen, setPause]);

  useEffect(() => {
    if (!showControls) setControlsOpen(false);
  }, [showControls]);

  // F009: every override change (this panel, another tab) goes to the running game at once.
  useEffect(
    () =>
      subscribeOverrides(game.id, (o) => {
        const d = latest.current.defaults;
        if (d.length > 0) post(controlsMessage(d, o));
      }),
    [game.id, post],
  );

  // F009: hosts (desktop View → Controls) open the panel with a window event.
  useEffect(() => {
    const onOpen = () => {
      if (latest.current.showControls) setControlsOpen(true);
    };
    window.addEventListener(PLAYER_CONTROLS_EVENT, onOpen);
    return () => window.removeEventListener(PLAYER_CONTROLS_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!controlsHinting) return;
    const t = setTimeout(() => setControlsHinting(false), CONTROLS_HINT_MS);
    return () => clearTimeout(t);
  }, [controlsHinting]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current && !!wrapRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Re-apply mute after (re)load.
  useEffect(() => {
    if (ready && muted) post({ type: "webgame:mute", muted: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    post({ type: "webgame:mute", muted: m });
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await wrapRef.current?.requestFullscreen();
      iframeRef.current?.focus();
    } catch {
      toast.error("Fullscreen is not available");
    }
  };

  const w = game.width > 0 ? game.width : 16;
  const h = game.height > 0 ? game.height : 9;

  return (
    <div className={`pf-player ${fullscreen ? "is-fullscreen" : ""} ${className}`} ref={wrapRef}>
      <div className="pf-player__stage" style={{ aspectRatio: `${w} / ${h}` }}>
        {src && (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={src}
            title={`${game.title} (game)`}
            sandbox={GAME_IFRAME_SANDBOX}
            allow="fullscreen; gamepad; autoplay"
            referrerPolicy="no-referrer"
            onLoad={() => {
              // Fallback in case the runtime never reports ready.
              window.setTimeout(() => setReady(true), 6000);
            }}
          />
        )}
        {previewError && !src && (
          <div className="pf-player__overlay pf-player__overlay--error" role="alert">
            <strong>Couldn't start the preview</strong>
            <code>{previewError}</code>
            <button type="button" className="pf-btn pf-btn--sm" onClick={() => setPreviewRetry((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {!ready && !error && !(previewError && !src) && (
          <div className="pf-player__overlay" aria-live="polite">
            <Spinner size={32} label="Loading game" />
            <span>Loading {game.title}…</span>
          </div>
        )}
        {error && (
          <div className="pf-player__overlay pf-player__overlay--error" role="alert">
            <strong>The game hit an error</strong>
            <code>{error}</code>
            <button type="button" className="pf-btn pf-btn--sm" onClick={() => setReloadKey((k) => k + 1)}>
              Restart
            </button>
          </div>
        )}
        {shots.flashKey > 0 && <div key={shots.flashKey} className="pf-shot-flash" aria-hidden="true" />}
      </div>
      <span className="pf-sr-only" aria-live="polite">
        {shots.announcement}
      </span>
      <div className="pf-player__bar">
        <span className="pf-player__title">{game.title}</span>
        <div className="pf-player__controls">
          <button type="button" className="pf-iconbtn" onClick={() => setReloadKey((k) => k + 1)} aria-label="Restart game" title="Restart">
            ↻
          </button>
          {showControls && (
            <span className="pf-player__ctrl">
              <button
                type="button"
                className="pf-iconbtn"
                onClick={() => setControlsOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={controlsOpen}
                aria-label="Controls"
                title="Controls"
              >
                ⌨
              </button>
              {controlsHinting && (
                <span className="pf-controls-hint" role="status">
                  <span>See and change the controls</span>
                  <button type="button" className="pf-controls-hint__close" aria-label="Dismiss" onClick={() => setControlsHinting(false)}>
                    ×
                  </button>
                </span>
              )}
            </span>
          )}
          <button type="button" className="pf-iconbtn" onClick={toggleMute} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
            {muted ? "🔇" : "🔊"}
          </button>
          <button
            type="button"
            className="pf-iconbtn"
            ref={cameraRef}
            onClick={shots.capture}
            // aria-disabled, not disabled: the button keeps focus while a capture runs (review 3, L1a).
            aria-disabled={!shots.canCapture}
            aria-busy={shots.capturing || undefined}
            aria-label="Take screenshot"
            title="Screenshot"
          >
            {shots.capturing ? <Spinner size={14} label="Capturing screenshot" /> : "📷"}
          </button>
          <button
            type="button"
            className="pf-iconbtn"
            onClick={toggleFullscreen}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? "⤡" : "⤢"}
          </button>
        </div>
      </div>
      <ScreenshotTray
        items={shots.items}
        mode="player"
        game={{ id: game.id, title: game.title, published: game.published, isOwner: game.isOwner }}
        onRemove={shots.remove}
        onClear={shots.clear}
        onGameUpdated={onGameUpdated}
        emptyFocusRef={cameraRef}
      />
      {controlsOpen && showControls && (
        // Inside the player wrapper so it also shows in fullscreen.
        <ControlsPanel
          mode="player"
          title={game.title}
          hint={controlsHint}
          actions={defaults}
          overrides={overrides}
          onChange={(o) => writeOverrides(game.id, o, defaults)}
          onClose={() => setControlsOpen(false)}
        />
      )}
    </div>
  );
}
