import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useToast } from "../context/toast";
import { isRequestId } from "../leaderboard";
import { launderImage, PLAYER_SCREENSHOT_EVENT, sanitizeScreenshotCaption, SCREENSHOT_MAX_BLOB_BYTES } from "../screenshot";

/** Timeout of a player (📷) request (GAME_FORMAT § F005). */
export const SCREENSHOT_REQUEST_TIMEOUT_MS = 5000;
/** Game shares: at most one accepted per this interval… */
export const SCREENSHOT_SHARE_INTERVAL_MS = 3000;
/** …and this many per player mount. */
export const SCREENSHOT_SHARE_MAX_PER_MOUNT = 20;
/** Tray size; the oldest item is evicted (and its object URL revoked). */
export const SCREENSHOT_TRAY_MAX = 12;

/** A tray item. `blob` is always the parent's re-encoded PNG, never the game's Blob. */
export type ScreenshotItem = {
  id: number;
  blob: Blob;
  /** Object URL of `blob` (revoked on evict / remove / unmount). */
  url: string;
  width: number;
  height: number;
  /** ms since epoch */
  capturedAt: number;
  source: "player" | "game";
  /** Sanitised caption suggested by the game ("" for player captures). */
  caption: string;
};

export type ScreenshotCaptureOptions = {
  mode: "player" | "studio";
  /** Game title (toasts, file names). */
  title: string;
  /** The game reported `webgame:ready`. */
  ready: boolean;
};

export type ScreenshotCapture = {
  items: ScreenshotItem[];
  /** A player request is in flight (or its image is being re-encoded). */
  capturing: boolean;
  canCapture: boolean;
  capture: () => void;
  remove: (id: number) => void;
  clear: () => void;
  /** Increments on every successful player capture (drive the flash animation with it as a key). */
  flashKey: number;
  /** Text for a polite live region. */
  announcement: string;
};

const PLAYER_ERRORS: Record<string, string> = {
  unavailable: "The game is still loading",
  busy: "Try again in a moment",
  failed: "This game can't take screenshots right now",
};
const CAPTURE_FAILED = "Couldn't capture a screenshot";

type Inflight = { requestId: string; timer: ReturnType<typeof setTimeout> };

/**
 * F005 capture flow shared by GamePlayer and StudioPreview: the 📷 request/reply with the game iframe, game-initiated
 * shares (`source: "game"`), the PLAYER_SCREENSHOT_EVENT window event, laundering, and the in-memory tray.
 *
 * Messages are accepted only from `iframeRef.current.contentWindow`. The game's Blob is never given an object URL:
 * only the PNG returned by `launderImage` is.
 */
export function useScreenshotCapture(iframeRef: RefObject<HTMLIFrameElement | null>, opts: ScreenshotCaptureOptions): ScreenshotCapture {
  const toast = useToast();
  const [items, setItems] = useState<ScreenshotItem[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  // Everything timers / listeners need is read from refs at call time (never captured when scheduled).
  const latest = useRef({ opts, toast });
  latest.current = { opts, toast };
  const itemsRef = useRef<ScreenshotItem[]>([]);
  const inflight = useRef<Inflight | null>(null);
  const alive = useRef(true);
  const seq = useRef({ request: 0, item: 0 });
  const shares = useRef({ count: 0, lastAt: -Infinity });

  const publish = useCallback(() => setItems(itemsRef.current.slice()), []);

  const addItem = useCallback(
    (it: Omit<ScreenshotItem, "id" | "url">) => {
      const url = URL.createObjectURL(it.blob);
      const item: ScreenshotItem = { ...it, id: ++seq.current.item, url };
      const next = [item, ...itemsRef.current];
      for (const old of next.splice(SCREENSHOT_TRAY_MAX)) URL.revokeObjectURL(old.url);
      itemsRef.current = next;
      publish();
    },
    [publish],
  );

  const remove = useCallback(
    (id: number) => {
      const it = itemsRef.current.find((x) => x.id === id);
      if (!it) return;
      URL.revokeObjectURL(it.url);
      itemsRef.current = itemsRef.current.filter((x) => x.id !== id);
      publish();
    },
    [publish],
  );

  const clear = useCallback(() => {
    for (const it of itemsRef.current) URL.revokeObjectURL(it.url);
    itemsRef.current = [];
    publish();
  }, [publish]);

  const finishInflight = useCallback(() => {
    const cur = inflight.current;
    if (cur) clearTimeout(cur.timer);
    inflight.current = null;
  }, []);

  const fail = useCallback((reason: string) => {
    latest.current.toast.error(CAPTURE_FAILED, reason);
  }, []);

  const capture = useCallback(() => {
    if (!alive.current || inflight.current) return;
    const win = iframeRef.current?.contentWindow;
    if (!latest.current.opts.ready || !win) return;
    const requestId = `ps-${++seq.current.request}`;
    const timer = setTimeout(() => {
      // Only if this request is still the one in flight (read at fire time).
      if (inflight.current?.requestId !== requestId) return;
      inflight.current = null;
      if (!alive.current) return;
      setCapturing(false);
      fail(PLAYER_ERRORS.failed);
    }, SCREENSHOT_REQUEST_TIMEOUT_MS);
    inflight.current = { requestId, timer };
    setCapturing(true);
    try {
      win.postMessage({ type: "webgame:screenshot-request", requestId }, "*");
    } catch {
      finishInflight();
      setCapturing(false);
      fail(PLAYER_ERRORS.failed);
    }
  }, [iframeRef, fail, finishInflight]);

  const captureRef = useRef(capture);
  captureRef.current = capture;

  // Mount / unmount: revoke every object URL and drop the pending request.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const cur = inflight.current;
      if (cur) clearTimeout(cur.timer);
      inflight.current = null;
      for (const it of itemsRef.current) URL.revokeObjectURL(it.url);
      itemsRef.current = [];
    };
  }, []);

  // Host-triggered capture (desktop menu accelerator).
  useEffect(() => {
    const onEvent = () => captureRef.current();
    window.addEventListener(PLAYER_SCREENSHOT_EVENT, onEvent);
    return () => window.removeEventListener(PLAYER_SCREENSHOT_EVENT, onEvent);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object" || data.type !== "webgame:screenshot") return;
      const { requestId, source: kind } = data;
      if (!isRequestId(requestId)) return;
      const win = event.source as Window;
      const image = data.image;
      const validImage = image instanceof Blob && image.size > 0 && image.size <= SCREENSHOT_MAX_BLOB_BYTES;

      if (kind === "player") {
        // Only the reply to OUR in-flight request; made-up ids are ignored.
        if (inflight.current?.requestId !== requestId) return;
        const err = data.error;
        if (typeof err === "string") {
          finishInflight();
          setCapturing(false);
          fail(PLAYER_ERRORS[err] ?? PLAYER_ERRORS.failed);
          return;
        }
        if (!validImage) return; // malformed: ignored (the timeout still applies)
        finishInflight();
        launderImage(image).then(
          (img) => {
            if (!alive.current) return;
            setCapturing(false);
            addItem({ blob: img.blob, width: img.width, height: img.height, capturedAt: Date.now(), source: "player", caption: "" });
            setFlashKey((k) => k + 1);
            // Alternate a trailing NBSP so screen readers announce repeated captures.
            setAnnouncement((a) => (a === "Screenshot captured" ? "Screenshot captured\u00a0" : "Screenshot captured"));
          },
          () => {
            if (!alive.current) return;
            setCapturing(false);
            fail(PLAYER_ERRORS.failed);
          },
        );
        return;
      }

      if (kind === "game") {
        if (!validImage) return;
        const reply = (accepted: boolean, error?: "rate_limited" | "invalid" | "unavailable") => {
          try {
            win.postMessage(error ? { type: "webgame:screenshot-result", requestId, accepted, error } : { type: "webgame:screenshot-result", requestId, accepted }, "*");
          } catch {
            /* frame gone */
          }
        };
        const now = Date.now();
        const sh = shares.current;
        if (sh.count >= SCREENSHOT_SHARE_MAX_PER_MOUNT || now - sh.lastAt < SCREENSHOT_SHARE_INTERVAL_MS) {
          reply(false, "rate_limited");
          return;
        }
        // Reserve the slot now so concurrent shares can't slip through while this one is decoded.
        const prevLast = sh.lastAt;
        sh.count++;
        sh.lastAt = now;
        const caption = sanitizeScreenshotCaption(data.caption);
        launderImage(image).then(
          (img) => {
            if (!alive.current) return;
            addItem({ blob: img.blob, width: img.width, height: img.height, capturedAt: Date.now(), source: "game", caption });
            reply(true);
            const title = latest.current.opts.title || "The game";
            latest.current.toast.info(`${title} captured a screenshot`, caption || undefined);
          },
          () => {
            sh.count--;
            if (sh.lastAt === now) sh.lastAt = prevLast;
            reply(false, "invalid");
          },
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef, addItem, fail, finishInflight]);

  return {
    items,
    capturing,
    canCapture: opts.ready && !capturing,
    capture,
    remove,
    clear,
    flashKey,
    announcement,
  };
}
