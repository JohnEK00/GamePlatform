// F007: notification summary text, OS-notification watermark and the poll cadence (pure helpers).
import type { Notification, NotificationKind, UserRef } from "./api/types";

/** Kinds this client knows how to render. Others are ignored (API § F007). */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ["comment", "reply", "heart", "follow", "gamePublished", "pinned", "addedToCollection"];

export function isKnownNotification(n: unknown): n is Notification {
  if (!n || typeof n !== "object") return false;
  const x = n as Partial<Notification>;
  return (
    typeof x.id === "string" &&
    typeof x.kind === "string" &&
    (NOTIFICATION_KINDS as readonly string[]).includes(x.kind) &&
    Array.isArray(x.actors) &&
    typeof x.updatedAt === "string" &&
    typeof x.path === "string"
  );
}

/** A piece of a notification summary. `name` parts are rendered in <strong>, `title` parts are game titles. */
export type NotificationPart = { type: "text" | "name" | "title"; text: string };

function displayName(u: UserRef | undefined): string {
  if (!u) return "Someone";
  return u.displayName || u.username || "Someone";
}

/** F021: the collection title of an addedToCollection item, or "" when missing (older or defensive). */
function collectionTitle(n: Notification): string {
  const c = n.collection;
  return c && typeof c === "object" && typeof c.title === "string" ? c.title : "";
}

/** The normative summary (spec § 2.5) as parts; [] for unknown kinds. */
export function notificationParts(n: Notification): NotificationPart[] {
  if (!isKnownNotification(n)) return [];
  const t = (text: string): NotificationPart => ({ type: "text", text });
  const name = (u: UserRef | undefined): NotificationPart => ({ type: "name", text: displayName(u) });
  const title: NotificationPart = { type: "title", text: n.game?.title || "a game" };

  const actorCount = Math.max(1, Math.floor(Number(n.actorCount) || 1));
  const eventCount = Math.max(actorCount, Math.floor(Number(n.eventCount) || actorCount));
  const [a, b] = n.actors;
  // "A", "A and B", "A and {k} other(s)"
  const who: NotificationPart[] = [name(a)];
  if (actorCount === 2 && b) who.push(t(" and "), name(b));
  else if (actorCount >= 2) {
    const others = actorCount - 1;
    who.push(t(` and ${others} ${others === 1 ? "other" : "others"}`));
  }

  switch (n.kind) {
    case "comment":
      if (actorCount === 1 && eventCount > 1) return [...who, t(` left ${eventCount} comments on `), title];
      return [...who, t(" commented on "), title];
    case "reply": {
      const target = n.ownsThread ? " to your comment on " : " to you on ";
      const verb = actorCount === 1 && eventCount > 1 ? ` replied ${eventCount} times` : " replied";
      return [...who, t(verb + target), title];
    }
    case "heart":
      return [...who, t(" hearted your comment on "), title];
    case "follow":
      return [...who, t(" followed you")];
    case "gamePublished":
      return [name(a), t(" published "), title];
    case "pinned":
      // F018 § 2.5: only the newest actor is named.
      return [name(a), t(" pinned your comment on "), title];
    case "addedToCollection": {
      // F021 § 2.3: only the curator is named.
      const coll = collectionTitle(n);
      return coll ? [name(a), t(" added "), title, t(" to "), { type: "title", text: coll }] : [name(a), t(" added "), title, t(" to a collection")];
    }
    default:
      return [];
  }
}

/** F018 § 2.3: the "Mute" action of an item on the /notifications page, or null when it has none. */
export type MuteAction = { target: "game" | "thread"; id: string; label: string };

export function muteActionFor(n: Notification): MuteAction | null {
  if (!isKnownNotification(n)) return null;
  const title = n.game?.title || "this game";
  const threadId = typeof n.threadId === "string" && n.threadId ? n.threadId : null;
  switch (n.kind) {
    case "reply":
    case "heart":
    case "pinned":
      if (!threadId) return null;
      return { target: "thread", id: threadId, label: `Mute notifications for this thread on ${title}` };
    case "comment":
    case "gamePublished":
    case "addedToCollection":
      if (!n.game || typeof n.game.id !== "string" || !n.game.id) return null;
      return { target: "game", id: n.game.id, label: `Mute notifications for ${title}` };
    default:
      return null;
  }
}

/** The normative summary as plain text; "" for unknown kinds. */
export function notificationText(n: Notification): string {
  return notificationParts(n)
    .map((p) => p.text)
    .join("");
}

/**
 * F021 § 2.3: the body of an OS notification. Equals `notificationText` except for `addedToCollection`, whose
 * collection title (free text written by another user) never goes to the OS: "{actor} added {game} to a collection".
 */
export function osNotificationText(n: Notification): string {
  if (!isKnownNotification(n)) return "";
  if (n.kind === "addedToCollection") return notificationText({ ...n, collection: null });
  return notificationText(n);
}

/** Only in-app absolute paths are followed; anything else falls back to the notifications page. */
export function safeNotificationPath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return "/notifications";
  if (/[\u0000-\u001f]/.test(path)) return "/notifications";
  return path;
}

/**
 * Merges a page into a list: known kinds only, deduplicated by `id`. When an id is already listed, the copy
 * with the newer `updatedAt` wins (kept at the existing position).
 */
export function mergeNotifications(prev: Notification[], next: Notification[]): Notification[] {
  const out = prev.slice();
  const index = new Map(out.map((n, i) => [n.id, i]));
  for (const n of next) {
    if (!isKnownNotification(n)) continue;
    const i = index.get(n.id);
    if (i === undefined) {
      index.set(n.id, out.length);
      out.push(n);
    } else if (Date.parse(n.updatedAt) > Date.parse(out[i].updatedAt)) {
      out[i] = n;
    }
  }
  return out;
}

/** Badge text: "" at 0, "1"–"99", "99+" at 100 (the server's cap). */
export function unreadBadgeText(unread: number): string {
  if (!(unread > 0)) return "";
  return unread >= 100 ? "99+" : String(Math.floor(unread));
}

/** The bell's accessible name. */
export function bellLabel(unread: number): string {
  if (!(unread > 0)) return "Notifications";
  if (unread >= 100) return "Notifications, more than 99 unread";
  return `Notifications, ${Math.floor(unread)} unread`;
}

// ---------- OS notification watermark (desktop) ----------

export const OS_WATERMARK_PREFIX = "webgame.notifications.osShown.";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validIso(v: unknown): v is string {
  return typeof v === "string" && RFC3339.test(v) && Number.isFinite(Date.parse(v));
}

/** The device watermark for `userId` (RFC3339), or null when missing or malformed. */
export function readOsWatermark(userId: string): string | null {
  try {
    const v = localStorage.getItem(OS_WATERMARK_PREFIX + userId);
    return validIso(v) ? v : null;
  } catch {
    return null;
  }
}

/** Stores the watermark; malformed values are ignored. */
export function writeOsWatermark(userId: string, iso: string): void {
  if (!validIso(iso)) return;
  try {
    localStorage.setItem(OS_WATERMARK_PREFIX + userId, iso);
  } catch {
    /* storage unavailable */
  }
}

/** Title of every OS notification. */
export const OS_NOTIFICATION_TITLE = "Pixelforge Arcade";
/** At most this many individual OS notifications per poll; more become one summary. */
export const OS_NOTIFICATION_MAX = 3;

/** What to show for the given new items (oldest first, summary text only, never excerpts). */
export function osNotificationsFor(items: Notification[]): { title: string; body: string }[] {
  const known = items.filter(isKnownNotification);
  if (known.length === 0) return [];
  if (known.length > OS_NOTIFICATION_MAX) return [{ title: OS_NOTIFICATION_TITLE, body: `You have ${known.length} new notifications` }];
  return known
    .slice()
    .sort((x, y) => Date.parse(x.updatedAt) - Date.parse(y.updatedAt))
    .map((n) => ({ title: OS_NOTIFICATION_TITLE, body: osNotificationText(n) }));
}

// ---------- Poll cadence (spec § 2.7) ----------

export const DEFAULT_POLL_SECS = 60;
/** Max error backoff. */
export const POLL_MAX_BACKOFF_SECS = 600;
/** On focus / becoming visible: refetch when the last response is older than this. */
export const POLL_STALE_MS = 15_000;

/** The server's suggested delay, sanitised to 15–600 s (default 60). */
export function normalizePollSecs(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_SECS;
  return Math.min(600, Math.max(15, Math.round(n)));
}

export type PollOutcome = "ok" | "rateLimited" | "error" | "unauthorized" | "unsupported";

export type PollDelayInput = {
  /** Last `pollAfterSecs` from the server (or the default). */
  pollAfterSecs: number;
  /** `document.visibilityState !== "hidden"`. */
  visible: boolean;
  /** `platform.osNotifications?.isEnabled()`. */
  osEnabled: boolean;
  /** Result of the last count request. */
  outcome: PollOutcome;
  /** 429: the Retry-After seconds. */
  retryAfter?: number;
  /** Consecutive failures (network/5xx), including the last one; 0 after a success. */
  errorStreak?: number;
};

/**
 * Milliseconds from the last response to the next count request, or null to not schedule one
 * (hidden tab without OS notifications, 401, or a server without F007).
 */
export function notificationPollDelay(input: PollDelayInput): number | null {
  const base = normalizePollSecs(input.pollAfterSecs);
  if (input.outcome === "unauthorized" || input.outcome === "unsupported") return null;
  if (!input.visible && !input.osEnabled) return null;
  if (input.outcome === "rateLimited") {
    const ra = typeof input.retryAfter === "number" && Number.isFinite(input.retryAfter) ? input.retryAfter : 0;
    return Math.max(ra, base) * 1000;
  }
  if (input.outcome === "error") {
    const streak = Math.max(1, Math.floor(input.errorStreak ?? 1));
    const secs = Math.min(POLL_MAX_BACKOFF_SECS, base * 2 ** Math.min(streak, 10));
    return secs * 1000;
  }
  return (input.visible ? base : base * 2) * 1000;
}
