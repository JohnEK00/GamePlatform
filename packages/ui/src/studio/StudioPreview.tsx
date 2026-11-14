import { useEffect, useRef } from "react";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { GAME_IFRAME_SANDBOX } from "../components/GamePlayer";
import { asManifest, leaderboardOf, manifestForBundle, type StudioProject } from "./project";
import { isRequestId, parseLeaderboardRequest, sampleLeaderboardView } from "../leaderboard";

export type StudioConsoleLevel = "info" | "success" | "warn" | "error";
export type StudioConsoleEntry = {
  level: StudioConsoleLevel;
  message: string;
  /** 1-based source position, when the error carries one */
  line?: number;
  column?: number;
  file?: string;
};

export type StudioPreviewProps = {
  project: StudioProject;
  /** Changing this re-creates the iframe and runs the project as it is at that moment. */
  runId: number;
  onLog: (entry: StudioConsoleEntry) => void;
  className?: string;
};

/** How long to wait for `webgame:studio-ready` before warning that the player page may be missing. */
export const STUDIO_READY_TIMEOUT_MS = 10_000;

const SAMPLE_NOTE_KEY = "webgame.studio.lbSampleNoted";
let sampleNotedFallback = false;

/** True the first time per browser session (for the "sample leaderboard data" note). */
function takeSampleNote(): boolean {
  try {
    if (sessionStorage.getItem(SAMPLE_NOTE_KEY)) return false;
    sessionStorage.setItem(SAMPLE_NOTE_KEY, "1");
    return true;
  } catch {
    if (sampleNotedFallback) return false;
    sampleNotedFallback = true;
    return true;
  }
}

function num(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

/**
 * Live preview of an unsaved project in a sandboxed iframe at `{api}/play/studio` (Studio protocol,
 * GAME_FORMAT.md). Messages are accepted ONLY from this iframe's window. Score / achievement messages are
 * reported as "would submit / would unlock" — no API calls are made for studio sessions.
 */
export function StudioPreview({ project, runId, onLog, className = "" }: StudioPreviewProps) {
  const api = useApi();
  const toast = useToast();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Snapshot of the project taken when this run started.
  const run = useRef({ id: runId, project });
  if (run.current.id !== runId) run.current = { id: runId, project };
  const save = useRef<Record<string, unknown> | null>(null);
  const latest = useRef({ onLog, toast });
  latest.current = { onLog, toast };

  useEffect(() => {
    let readySeen = false;
    const log = (e: StudioConsoleEntry) => latest.current.onLog(e);
    const timer = setTimeout(() => {
      if (!readySeen)
        log({ level: "warn", message: "The preview didn't respond. Is the backend running (and serving /play/studio)?" });
    }, STUDIO_READY_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; [k: string]: unknown } | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;
      const source = event.source as Window;
      const { project: p } = run.current;
      const manifest = asManifest(p.manifest);
      switch (data.type) {
        case "webgame:studio-ready": {
          readySeen = true;
          source.postMessage({ type: "webgame:studio-load", manifest: manifestForBundle(p.manifest), files: { ...p.files } }, "*");
          return;
        }
        case "webgame:hello":
          source.postMessage({ type: "webgame:load", data: save.current }, "*");
          return;
        case "webgame:save": {
          const d = data.data;
          if (d && typeof d === "object" && !Array.isArray(d)) save.current = d as Record<string, unknown>;
          return;
        }
        case "webgame:ready":
          log({ level: "info", message: "Game loaded and running." });
          return;
        case "webgame:error": {
          const message = typeof data.message === "string" && data.message ? data.message.slice(0, 2000) : "Unknown error";
          log({
            level: "error",
            message,
            line: num(data.line, data.lineno, data.lineNumber),
            column: num(data.column, data.col, data.colno, data.columnNumber),
            file: typeof data.file === "string" ? data.file : typeof data.filename === "string" ? data.filename : typeof data.source === "string" ? data.source : undefined,
          });
          return;
        }
        case "webgame:score": {
          const n = typeof data.score === "number" ? data.score : Number(data.score);
          if (!Number.isFinite(n)) return;
          const msg = `Would submit score ${Math.round(n).toLocaleString()}`;
          log({ level: "success", message: `${msg} (not saved — studio preview)` });
          latest.current.toast.info(msg, "Studio preview: scores aren't saved.");
          if (isRequestId(data.requestId))
            source.postMessage({ type: "webgame:score-result", requestId: data.requestId, result: null, error: "studio" }, "*");
          return;
        }
        case "webgame:leaderboard-get": {
          const req = parseLeaderboardRequest(data);
          if (!req) return;
          const leaderboard = sampleLeaderboardView(req.period, req.limit, leaderboardOf(p.manifest));
          source.postMessage({ type: "webgame:leaderboard", requestId: req.requestId, leaderboard }, "*");
          if (takeSampleNote()) {
            log({ level: "info", message: "getLeaderboard(): the preview returns sample leaderboard data." });
            latest.current.toast.info("Sample leaderboard data", "Studio preview: getLeaderboard() returns sample entries.");
          }
          return;
        }
        case "webgame:achievement": {
          const id = typeof data.id === "string" ? data.id : "";
          const def = Array.isArray(manifest.achievements) ? manifest.achievements.find((a) => a && a.id === id) : undefined;
          if (!def) {
            log({ level: "warn", message: `unlockAchievement("${id}"): no achievement with this id in game.json` });
            return;
          }
          log({ level: "success", message: `Would unlock achievement "${def.name}" (${id})` });
          latest.current.toast.info(`Would unlock: ${def.name}`, "Studio preview: achievements aren't saved.");
          return;
        }
        case "webgame:fullscreen": {
          const wrap = wrapRef.current;
          try {
            const r = wrap?.requestFullscreen?.();
            if (r && typeof r.catch === "function") r.catch(() => {});
          } catch {
            /* ignore */
          }
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [runId]);

  const m = asManifest(run.current.project.manifest);
  const w = typeof m.width === "number" && m.width > 0 ? m.width : 16;
  const h = typeof m.height === "number" && m.height > 0 ? m.height : 9;

  return (
    <div className={`pf-studio-preview ${className}`} ref={wrapRef}>
      <div className="pf-studio-preview__stage" style={{ aspectRatio: `${w} / ${h}` }}>
        <iframe
          key={runId}
          ref={iframeRef}
          src={api.url("/play/studio")}
          title="Game preview"
          sandbox={GAME_IFRAME_SANDBOX}
          allow="fullscreen; gamepad; autoplay"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
