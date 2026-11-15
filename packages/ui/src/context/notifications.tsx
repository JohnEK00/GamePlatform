// F007: unread count polling, the polite live region and the desktop OS-notification step.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isApiError, type ApiClient } from "../api/client";
import type { Notification, UnreadCount } from "../api/types";
import {
  isKnownNotification,
  normalizePollSecs,
  notificationPollDelay,
  osNotificationsFor,
  POLL_STALE_MS,
  readOsWatermark,
  writeOsWatermark,
  DEFAULT_POLL_SECS,
  type PollOutcome,
} from "../notifications";
import { useAuth } from "./auth";
import { useApi, usePlatform, type PlatformConfig } from "./config";

export type NotificationsState = {
  /** False when the server has no notifications API (404) or there is no provider: hide the bell. */
  supported: boolean;
  /** True once the first count response arrived for the current user. */
  ready: boolean;
  /** Unread count (capped at 100 by the server). */
  unread: number;
  /** updatedAt of the newest unread notification, or null. */
  latestAt: string | null;
  /** Increments whenever a poll sees newer notifications (an open list should refetch). */
  lastChange: number;
  /** Fetch the count now (no-op while a request is in flight or after a 401/404). */
  refresh: () => Promise<void>;
  /** Optimistically mark one item read (`upTo` = its updatedAt); failures are ignored. */
  markRead: (item: Notification) => Promise<void>;
  /** Mark everything up to `upTo` read; resolves with the server's unread count, rejects on failure. */
  markAllRead: (upTo: string) => Promise<number>;
  /** Adopt an unread count the server returned elsewhere (e.g. NotificationPage.unread). */
  syncUnread: (unread: number) => void;
  /** Polite screen-reader announcement through the provider's single live region. */
  announce: (message: string) => void;
};

const noop = async () => {};
const INERT: NotificationsState = {
  supported: false,
  ready: false,
  unread: 0,
  latestAt: null,
  lastChange: 0,
  refresh: noop,
  markRead: noop,
  markAllRead: async () => 0,
  syncUnread: () => {},
  announce: () => {},
};

const NotificationsContext = createContext<NotificationsState | null>(null);

/** Notification state; an inert, unsupported state outside `NotificationsProvider`. */
export function useNotifications(): NotificationsState {
  return useContext(NotificationsContext) ?? INERT;
}

type ViewState = { supported: boolean; ready: boolean; unread: number; latestAt: string | null; lastChange: number };
const INITIAL_VIEW: ViewState = { supported: true, ready: false, unread: 0, latestAt: null, lastChange: 0 };

/** Mutable poll-loop state, read when timers fire (never captured in closures). */
type Loop = {
  gen: number;
  userId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  lastResponseAt: number;
  outcome: PollOutcome;
  retryAfter?: number;
  errorStreak: number;
  pollAfterSecs: number;
  /** Last unread value from the server (null before the first response). */
  unread: number | null;
  latestAt: string | null;
  osPrevEnabled: boolean | null;
  osBusy: boolean;
};

function freshLoop(gen: number, userId: string | null): Loop {
  return {
    gen,
    userId,
    timer: null,
    inFlight: null,
    lastResponseAt: 0,
    outcome: "ok",
    errorStreak: 0,
    pollAfterSecs: DEFAULT_POLL_SECS,
    unread: null,
    latestAt: null,
    osPrevEnabled: null,
    osBusy: false,
  };
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const windowHasFocus = () => (typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : true);
const clampUnread = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.floor(n))) : 0);
const newer = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) > Date.parse(b);
};

/**
 * Owns the unread-count poll (spec § 2.7: one timer per tab, next fetch scheduled after each response,
 * paused while hidden unless OS notifications are on, 429/error backoff, stop on 401/404), the live region
 * (§ 2.6) and the desktop OS-notification step (§ 2.8). Mount inside AuthProvider and ToastProvider.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { user } = useAuth();
  const platform = usePlatform();
  const userId = user?.id ?? null;

  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [live, setLive] = useState<{ text: string; n: number }>({ text: "", n: 0 });

  const apiRef = useRef<ApiClient>(api);
  apiRef.current = api;
  const platformRef = useRef<PlatformConfig>(platform);
  platformRef.current = platform;
  const loopRef = useRef<Loop>(freshLoop(0, null));

  // One controller for the provider's lifetime; every function reads the refs above.
  const ctrl = useMemo(() => {
    const osApi = () => platformRef.current.osNotifications;
    const osEnabled = () => {
      try {
        return !!osApi()?.isEnabled();
      } catch {
        return false;
      }
    };

    const announce = (text: string) => setLive((l) => ({ text, n: l.n + 1 }));

    const clearTimer = () => {
      const L = loopRef.current;
      if (L.timer !== null) clearTimeout(L.timer);
      L.timer = null;
    };

    const delay = () => {
      const L = loopRef.current;
      return notificationPollDelay({
        pollAfterSecs: L.pollAfterSecs,
        visible: isVisible(),
        osEnabled: osEnabled(),
        outcome: L.outcome,
        retryAfter: L.retryAfter,
        errorStreak: L.errorStreak,
      });
    };

    const schedule = () => {
      clearTimer();
      const L = loopRef.current;
      if (!L.userId || L.inFlight) return;
      const d = delay();
      if (d === null) return;
      L.timer = setTimeout(tick, Math.max(0, L.lastResponseAt + d - Date.now()));
    };

    const tick = () => {
      const L = loopRef.current;
      L.timer = null;
      if (!L.userId || L.inFlight) return;
      const d = delay();
      if (d === null) return; // paused (hidden) or stopped; a wake-up resumes
      if (Date.now() < L.lastResponseAt + d) return schedule(); // cadence changed since scheduling
      void poll();
    };

    const setServerUnread = (n: number) => {
      const L = loopRef.current;
      const v = clampUnread(n);
      L.unread = v;
      setView((s) => ({ ...s, unread: v }));
    };

    const osStep = async (c: UnreadCount) => {
      const L = loopRef.current;
      const os = osApi();
      if (!os || !L.userId) return;
      const enabled = osEnabled();
      const wasEnabled = L.osPrevEnabled;
      L.osPrevEnabled = enabled;
      if (!enabled) return;
      const uid = L.userId;
      const watermark = readOsWatermark(uid);
      if (watermark === null || wasEnabled === false) {
        // Just turned on (or no watermark yet): start from now so old notifications don't burst out.
        writeOsWatermark(uid, c.latestAt ?? new Date().toISOString());
        return;
      }
      if (!newer(c.latestAt, watermark)) return;
      if (windowHasFocus()) {
        // The user is looking at the app (and its bell); don't toast these later.
        writeOsWatermark(uid, c.latestAt!);
        return;
      }
      if (L.osBusy) return;
      L.osBusy = true;
      const gen = L.gen;
      try {
        const page = await apiRef.current.listNotifications({ unread: true, limit: 5 });
        if (gen !== loopRef.current.gen || !osEnabled()) return;
        const wm = Date.parse(watermark);
        const fresh = (page?.items ?? []).filter((n) => isKnownNotification(n) && Date.parse(n.updatedAt) > wm);
        if (!windowHasFocus()) {
          for (const n of osNotificationsFor(fresh)) {
            try {
              await os.show(n);
            } catch {
              /* best effort */
            }
          }
        }
        let next = c.latestAt!;
        for (const n of fresh) if (newer(n.updatedAt, next)) next = n.updatedAt;
        writeOsWatermark(uid, next);
      } catch {
        /* try again on the next poll */
      } finally {
        if (gen === loopRef.current.gen) loopRef.current.osBusy = false;
      }
    };

    const poll = (): Promise<void> => {
      const L = loopRef.current;
      if (!L.userId || L.outcome === "unauthorized" || L.outcome === "unsupported") return Promise.resolve();
      if (L.inFlight) return L.inFlight;
      clearTimer();
      const gen = L.gen;
      const run = (async () => {
        // Yield once so `L.inFlight` is set before any (even synchronous) failure reaches `finally`.
        await null;
        try {
          const c = await apiRef.current.unreadNotificationCount();
          if (gen !== loopRef.current.gen) return;
          const unread = clampUnread(c?.unread);
          const latestAt = typeof c?.latestAt === "string" ? c.latestAt : null;
          L.lastResponseAt = Date.now();
          L.outcome = "ok";
          L.retryAfter = undefined;
          L.errorStreak = 0;
          L.pollAfterSecs = normalizePollSecs(c?.pollAfterSecs);
          const prev = L.unread;
          const changed = prev !== null && newer(latestAt, L.latestAt);
          if (prev !== null && unread > prev) {
            const d = unread - prev;
            announce(`${d} new notification${d === 1 ? "" : "s"}`);
          }
          L.unread = unread;
          L.latestAt = latestAt;
          setView((s) => ({
            ...s,
            supported: true,
            ready: true,
            unread,
            latestAt,
            lastChange: changed ? s.lastChange + 1 : s.lastChange,
          }));
          void osStep({ unread, latestAt, pollAfterSecs: L.pollAfterSecs });
        } catch (e) {
          if (gen !== loopRef.current.gen) return;
          L.lastResponseAt = Date.now();
          if (isApiError(e) && e.status === 404) {
            L.outcome = "unsupported";
            setView((s) => ({ ...s, supported: false, ready: true, unread: 0, latestAt: null }));
            return;
          }
          if (isApiError(e) && e.status === 401) {
            L.outcome = "unauthorized";
          } else if (isApiError(e) && e.status === 429) {
            L.outcome = "rateLimited";
            L.retryAfter = e.retryAfter;
          } else {
            L.outcome = "error";
            L.errorStreak += 1;
          }
          setView((s) => (s.ready ? s : { ...s, ready: true }));
        } finally {
          if (gen === loopRef.current.gen) {
            L.inFlight = null;
            schedule();
          }
        }
      })();
      L.inFlight = run;
      return run;
    };

    /** Window focus / tab visible: fetch at once when the last response is stale, else keep the cadence. */
    const wake = () => {
      const L = loopRef.current;
      if (!L.userId || L.inFlight) return;
      if (L.outcome === "unauthorized" || L.outcome === "unsupported") return;
      if (L.outcome === "ok" && Date.now() - L.lastResponseAt >= POLL_STALE_MS) {
        void poll();
        return;
      }
      schedule();
    };

    const start = (uid: string | null) => {
      clearTimer();
      const gen = loopRef.current.gen + 1;
      loopRef.current = freshLoop(gen, uid);
      setView(INITIAL_VIEW);
      if (uid) void poll();
    };

    const stop = () => {
      clearTimer();
      loopRef.current = freshLoop(loopRef.current.gen + 1, null);
    };

    return { announce, poll, wake, start, stop, schedule, setServerUnread };
  }, []);

  // (Re)start on sign-in / user change / client change; stop and clear on sign-out.
  useEffect(() => {
    ctrl.start(userId);
    return () => ctrl.stop();
  }, [ctrl, userId, api]);

  useEffect(() => {
    const onVisibility = () => (isVisible() ? ctrl.wake() : ctrl.schedule());
    const onFocus = () => ctrl.wake();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [ctrl]);

  const markRead = useCallback(
    async (item: Notification) => {
      const L = loopRef.current;
      if (!L.userId || item.read) return;
      const gen = L.gen;
      const current = L.unread ?? 0;
      ctrl.setServerUnread(Math.max(0, current - 1));
      try {
        const r = await apiRef.current.markNotificationsRead({ ids: [item.id], upTo: item.updatedAt });
        if (gen === loopRef.current.gen) ctrl.setServerUnread(r?.unread ?? 0);
      } catch {
        /* the next poll corrects the count */
      }
    },
    [ctrl],
  );

  const markAllRead = useCallback(
    async (upTo: string) => {
      const gen = loopRef.current.gen;
      const r = await apiRef.current.markNotificationsRead({ upTo });
      const unread = clampUnread(r?.unread);
      if (gen === loopRef.current.gen) ctrl.setServerUnread(unread);
      return unread;
    },
    [ctrl],
  );

  const value = useMemo<NotificationsState>(
    () => ({
      supported: !!userId && view.supported,
      ready: view.ready,
      unread: view.unread,
      latestAt: view.latestAt,
      lastChange: view.lastChange,
      refresh: ctrl.poll,
      markRead,
      markAllRead,
      syncUnread: ctrl.setServerUnread,
      announce: ctrl.announce,
    }),
    [userId, view, ctrl, markRead, markAllRead],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <div className="pf-sr-only pf-notif-live" aria-live="polite" aria-atomic="true">
        {live.text && <span key={live.n}>{live.text}</span>}
      </div>
    </NotificationsContext.Provider>
  );
}
