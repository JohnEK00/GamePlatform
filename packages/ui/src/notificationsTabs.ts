// F018: one polling tab per browser (spec § 2.6). Pure helpers plus a small Web Locks + BroadcastChannel wrapper.
// Nothing here touches React; the provider (`context/notifications.tsx`) owns the poll loop and the state.
import type { UnreadCount } from "./api/types";
import { normalizePollSecs } from "./notifications";

/** A hidden leader keeps polling while a follower pinged `visible` within this window. */
export const VISIBLE_TTL_MS = 75_000;
/** Visible followers ping the leader this often. */
export const VISIBLE_PING_MS = 30_000;
/** A follower that got no `count` this long after starting requests the count itself (once). */
export const FOLLOWER_START_GRACE_MS = 5_000;

/** Follower watchdog: request the count directly when no `count` arrived for `max(3 × pollAfterSecs, 180)` s. */
export function followerWatchdogMs(pollAfterSecs: unknown): number {
  return Math.max(3 * normalizePollSecs(pollAfterSecs), 180) * 1000;
}

/** Coordination scope: per API server and user. The lock is `scope + ".leader"`, the channel is `scope`. */
export function tabScope(apiBaseUrl: string, userId: string): string {
  return "webgame.notifications." + encodeURIComponent(apiBaseUrl) + "." + userId;
}

/** Message bodies (without the `v` / `userId` envelope). They never carry tokens, items or excerpts. */
export type TabMessageBody =
  | { type: "count"; count: UnreadCount }
  | { type: "unread"; unread: number }
  | { type: "poll" }
  | { type: "visible" }
  | { type: "unsupported" };

export type TabMessage = TabMessageBody & { v: 1; userId: string };

const clampUnread = (n: number) => Math.min(100, Math.max(0, Math.floor(n)));
const finiteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Validates a received message for `userId`: wrong `v`, another user, unknown types and bad shapes → null.
 * Counts are clamped like F007 (`unread` to 0–100, `pollAfterSecs` to 15–600). The result is a fresh object.
 */
export function parseTabMessage(data: unknown, userId: string): TabMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.v !== 1 || typeof m.userId !== "string" || m.userId !== userId || !userId) return null;
  const env = { v: 1 as const, userId };
  switch (m.type) {
    case "count": {
      const c = m.count as Record<string, unknown> | null | undefined;
      if (!c || typeof c !== "object" || !finiteNumber(c.unread)) return null;
      if (c.latestAt !== null && typeof c.latestAt !== "string") return null;
      if (typeof c.latestAt === "string" && !Number.isFinite(Date.parse(c.latestAt))) return null;
      return {
        ...env,
        type: "count",
        count: { unread: clampUnread(c.unread), latestAt: (c.latestAt as string | null) ?? null, pollAfterSecs: normalizePollSecs(c.pollAfterSecs) },
      };
    }
    case "unread":
      return finiteNumber(m.unread) ? { ...env, type: "unread", unread: clampUnread(m.unread) } : null;
    case "poll":
    case "visible":
    case "unsupported":
      return { ...env, type: m.type };
    default:
      return null;
  }
}

// ---------- Coordinator ----------

/** The part of `navigator.locks` the coordinator uses. */
export interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<unknown> | unknown): Promise<unknown>;
}

/** The part of `BroadcastChannel` the coordinator uses (messages are never delivered to the sender). */
export interface ChannelLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

/**
 * Injected platform APIs. `undefined` uses the browser default (`navigator.locks`, `new BroadcastChannel`);
 * `null` means "not available" (per-tab polling). `isVisible` overrides `document.visibilityState` (tests).
 */
export type TabDeps = {
  locks?: LockManagerLike | null;
  createChannel?: ((name: string) => ChannelLike | null) | null;
  isVisible?: () => boolean;
};

export type TabHandlers = {
  /** This tab got the leader lock (it keeps it until `stop()` or unload). */
  onLeader: () => void;
  /** A validated message from another tab of the same user and server. */
  onMessage: (m: TabMessage) => void;
};

export type TabSession = {
  readonly scope: string;
  /** True once this tab holds the leader lock. */
  isLeader: () => boolean;
  /** Broadcast to the other tabs (adds the `v` / `userId` envelope). Errors are swallowed. */
  post: (body: TabMessageBody) => void;
  /** Abort the queued lock request or release the held lock, close the channel. Idempotent. */
  stop: () => void;
};

export type TabCoordinator = {
  /** Joins the election for `tabScope(apiBaseUrl, userId)`; null when the channel can't be created. */
  join: (apiBaseUrl: string, userId: string, handlers: TabHandlers) => TabSession | null;
};

function defaultLocks(): LockManagerLike | null {
  try {
    const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManagerLike }).locks : undefined;
    return locks && typeof locks.request === "function" ? locks : null;
  } catch {
    return null;
  }
}

function defaultCreateChannel(): ((name: string) => ChannelLike | null) | null {
  if (typeof BroadcastChannel !== "function") return null;
  return (name) => new BroadcastChannel(name) as unknown as ChannelLike;
}

/** The coordinator, or null when Web Locks or BroadcastChannel is unavailable (every tab polls on its own). */
export function createTabCoordinator(deps: TabDeps = {}): TabCoordinator | null {
  const locks = deps.locks === undefined ? defaultLocks() : deps.locks;
  const createChannel = deps.createChannel === undefined ? defaultCreateChannel() : deps.createChannel;
  if (!locks || typeof locks.request !== "function" || typeof createChannel !== "function") return null;

  return {
    join(apiBaseUrl, userId, handlers) {
      const scope = tabScope(apiBaseUrl, userId);
      let channel: ChannelLike | null;
      try {
        channel = createChannel(scope);
      } catch {
        channel = null;
      }
      if (!channel) return null;
      const ch = channel;

      let stopped = false;
      let leader = false;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const abort = typeof AbortController === "function" ? new AbortController() : null;

      ch.onmessage = (ev) => {
        if (stopped) return;
        const m = parseTabMessage(ev?.data, userId);
        if (m) handlers.onMessage(m);
      };

      try {
        const p = locks.request(scope + ".leader", abort ? { signal: abort.signal } : {}, () => {
          if (stopped) return undefined;
          leader = true;
          try {
            handlers.onLeader();
          } catch {
            /* the provider handles its own errors */
          }
          return held;
        });
        Promise.resolve(p).catch(() => {
          /* AbortError after stop(), or a lock failure: this tab simply never leads */
        });
      } catch {
        /* synchronous failure: stay a follower; the watchdog keeps the count fresh */
      }

      return {
        scope,
        isLeader: () => leader && !stopped,
        post(body) {
          if (stopped) return;
          try {
            ch.postMessage({ v: 1, userId, ...body });
          } catch {
            /* closed or uncloneable: best effort */
          }
        },
        stop() {
          if (stopped) return;
          stopped = true;
          leader = false;
          try {
            abort?.abort();
          } catch {
            /* ignore */
          }
          release();
          ch.onmessage = null;
          try {
            ch.close();
          } catch {
            /* ignore */
          }
        },
      };
    },
  };
}
