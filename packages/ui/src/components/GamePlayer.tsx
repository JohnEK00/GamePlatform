import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Game, Score } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";
import { Spinner } from "./common";

export type GamePlayerGame = Pick<Game, "id" | "title" | "width" | "height"> &
  Partial<Pick<Game, "playUrl" | "version" | "published" | "isOwner">>;

export type GamePlayerProps = {
  game: GamePlayerGame;
  /** Called after POST /play succeeded (once per load, when the game reports ready). */
  onPlayRecorded?: (plays: number) => void;
  /** Called after a score was saved to the API (use it to refresh the leaderboard). */
  onScoreSubmitted?: (score: Score) => void;
  className?: string;
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
  | { type: "webgame:score"; score: number }
  | { type: "webgame:error"; message?: string }
  | { type: "webgame:hello" }
  | { type: "webgame:save"; data: unknown }
  | { type: "webgame:fullscreen" }
  | { type: string; [k: string]: unknown };

/**
 * Sandboxed iframe player. Untrusted game code runs at an opaque origin and can only talk to us via
 * postMessage; messages are accepted ONLY when `event.source === iframe.contentWindow`.
 */
export function GamePlayer({ game, onPlayRecorded, onScoreSubmitted, className = "" }: GamePlayerProps) {
  const api = useApi();
  const { user, token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const playRecorded = useRef(false);
  const pausedByVisibility = useRef(false);

  // Latest values for the message handler without re-subscribing.
  const latest = useRef({ user, onPlayRecorded, onScoreSubmitted, game });
  latest.current = { user, onPlayRecorded, onScoreSubmitted, game };

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
      const { user: u, onPlayRecorded: onPlay, onScoreSubmitted: onScore, game: g } = latest.current;

      switch (data.type) {
        case "webgame:hello": {
          // Reply directly to the verified source (the game frame); opaque origin => "*".
          (event.source as Window).postMessage({ type: "webgame:load", data: readGameSave(g.id) }, "*");
          return;
        }
        case "webgame:save": {
          writeGameSave(g.id, (data as { data?: unknown }).data);
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
        case "webgame:score": {
          const raw = (data as { score?: unknown }).score;
          const n = typeof raw === "number" ? raw : Number(raw);
          if (!Number.isFinite(n)) return;
          const score = Math.round(n);
          if (!u) {
            toast.show({
              kind: "info",
              title: `You scored ${score.toLocaleString()}!`,
              message: "Log in to save your score to the leaderboard.",
              action: { label: "Log in", onClick: () => navigate(`/login?next=${encodeURIComponent(`/games/${g.id}`)}`) },
              duration: 8000,
            });
            return;
          }
          api.submitScore(g.id, score).then(
            (s) => {
              toast.success(`Score saved: ${s.score.toLocaleString()}`, s.rank ? `You're #${s.rank} on the leaderboard.` : undefined);
              onScore?.(s);
            },
            (e) => toast.error("Couldn't save your score", errorMessage(e)),
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

  // Pause when the tab is hidden, resume when visible again.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        pausedByVisibility.current = true;
        post({ type: "webgame:pause" });
      } else if (pausedByVisibility.current) {
        pausedByVisibility.current = false;
        post({ type: "webgame:resume" });
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [post]);

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
      </div>
      <div className="pf-player__bar">
        <span className="pf-player__title">{game.title}</span>
        <div className="pf-player__controls">
          <button type="button" className="pf-iconbtn" onClick={() => setReloadKey((k) => k + 1)} aria-label="Restart game" title="Restart">
            ↻
          </button>
          <button type="button" className="pf-iconbtn" onClick={toggleMute} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
            {muted ? "🔇" : "🔊"}
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
    </div>
  );
}
