// F007: unread count polling, the polite live region and the desktop OS-notification step.
// F018: tabs of the same user and server share one poll (Web Locks leader + BroadcastChannel, spec § 2.6).
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
import {
  createTabCoordinator,
  FOLLOWER_START_GRACE_MS,
  followerWatchdogMs,
  VISIBLE_PING_MS,
  VISIBLE_TTL_MS,
  type TabDeps,
  type TabMessage,
  type TabMessageBody,
  type TabSession,
} from "../notificationsTabs";
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
  /**
   * Increments when a poll sees genuinely new unread notifications: the count went up AND latestAt moved past the
   * newest value seen so far (so a heart toggled off and on, 1 → 0 → 1 with the same latestAt, is not "new").
   * Drives the live-region announcement and the bell animation.
   */
  arrivals: number;
  /** Fetch the count now (no-op while a request is in flight or after a 401/404); the result is shared with other tabs. */
  refresh: () => Promise<void>;
  /** Optimistically mark one item read (`upTo` = its updatedAt); failures are ignored. */
  markRead: (item: Notification) => Promise<void>;
  /** Mark everything up to `upTo` read; resolves with the server's unread count, rejects on failure. */
  markAllRead: (upTo: string) => Promise<number>;
  /** Adopt an unread count the server returned elsewhere (NotificationPage.unread, MuteState.unread); shared with other tabs. */
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
  arrivals: 0,
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

type ViewState = { supported: boolean; ready: boolean; unread: number; latestAt: string | null; lastChange: number; arrivals: number };
const INITIAL_VIEW: ViewState = { supported: true, ready: false, unread: 0, latestAt: null, lastChange: 0, arrivals: 0 };

/** Mutable poll-loop state, read when timers fire (never captured in closures). */
type Loop = {
  gen: number;
  userId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** When `timer` fires (ms epoch). */
  timerDue: number;
  inFlight: Promise<void> | null;
  lastResponseAt: number;
  outcome: PollOutcome;
  retryAfter?: number;
  errorStreak: number;
  pollAfterSecs: number;
  /** Last unread value from the server (null before the first response). */
  unread: number | null;
  latestAt: string | null;
  /** Newest latestAt ever seen for this user/session (not reset when the count drops to 0). */
  seenAt: string | null;
  osPrevEnabled: boolean | null;
  osBusy: boolean;
  /** F018: "solo" = uncoordinated (F007 per-tab polling); else this tab's role in the election. */
  mode: "solo" | "leader" | "follower";
  session: TabSession | null;
  /** F018 leader: when a follower last pinged `visible` (0 = never). */
  lastVisiblePing: number;
  /** F018: when the last count (own or received) was applied (0 = none yet). */
  lastCountAt: number;
  lastCount: UnreadCount | null;
  /** F018 follower: when this tab joined, and when its watchdog last requested the count itself. */
  followerStart: number;
  lastWatchdogAt: number;
  watchdog: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setTimeout> | null;
};

function freshLoop(gen: number, userId: string | null): Loop {
  return {
    gen,
    userId,
    timer: null,
    timerDue: 0,
    inFlight: null,
    lastResponseAt: 0,
    outcome: "ok",
    errorStreak: 0,
    pollAfterSecs: DEFAULT_POLL_SECS,
    unread: null,
    latestAt: null,
    seenAt: null,
    osPrevEnabled: null,
    osBusy: false,
    mode: "solo",
    session: null,
    lastVisiblePing: 0,
    lastCountAt: 0,
    lastCount: null,
    followerStart: 0,
    lastWatchdogAt: 0,
    watchdog: null,
    pingTimer: null,
  };
}

const documentVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const windowHasFocus = () => (typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : true);
const clampUnread = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.floor(n))) : 0);
const newer = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) > Date.parse(b);
};

export type NotificationsProviderProps = {
  children: ReactNode;
  /**
   * F018: tab-coordination platform APIs (tests inject in-memory fakes). Omitted: `navigator.locks` and
   * `BroadcastChannel` when both exist, else every tab polls on its own (F007). Read when the loop (re)starts.
   */
  tabs?: TabDeps;
};

/**
 * Owns the unread-count poll (spec § 2.7: one timer per tab, next fetch scheduled after each response,
 * paused while hidden unless OS notifications are on, 429/error backoff, stop on 404; a 401 revalidates the session
 * through auth and stops only when that signs out), the live region
 * (§ 2.6) and the desktop OS-notification step (§ 2.8). Mount inside AuthProvider and ToastProvider.
 *
 * F018 (§ 2.6): with Web Locks and BroadcastChannel, tabs of the same user and server elect one leader that polls
 * and broadcasts each count; followers apply received counts through the same function, ping `visible`, and
 * request the count themselves only on `refresh()` or when their watchdog fires. Only the leader shows OS
 * notifications.
 */
export function NotificationsProvider({ children, tabs }: NotificationsProviderProps) {
  const api = useApi();
  const { user, token, refresh: authRefresh } = useAuth();
  const platform = usePlatform();
  const userId = user?.id ?? null;

  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [live, setLive] = useState<{ text: string; n: number }>({ text: "", n: 0 });

  const apiRef = useRef<ApiClient>(api);
  apiRef.current = api;
  const platformRef = useRef<PlatformConfig>(platform);
  platformRef.current = platform;
  const authRefreshRef = useRef(authRefresh);
  authRefreshRef.current = authRefresh;
  const tabsRef = useRef<TabDeps | undefined>(tabs);
  tabsRef.current = tabs;
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

    const isVisible = () => {
      const v = tabsRef.current?.isVisible;
      return v ? v() : documentVisible();
    };
    /** The leader polls for itself and for followers that pinged `visible` within VISIBLE_TTL_MS. */
    const pollVisible = () => {
      const L = loopRef.current;
      return isVisible() || (L.mode === "leader" && Date.now() - L.lastVisiblePing < VISIBLE_TTL_MS);
    };
    const post = (body: TabMessageBody) => loopRef.current.session?.post(body);
    const halted = () => {
      const o = loopRef.current.outcome;
      return o === "unauthorized" || o === "unsupported";
    };

    const clearTimer = () => {
      const L = loopRef.current;
      if (L.timer !== null) clearTimeout(L.timer);
      L.timer = null;
    };
    const clearFollowerTimers = () => {
      const L = loopRef.current;
      if (L.watchdog !== null) clearTimeout(L.watchdog);
      if (L.pingTimer !== null) clearTimeout(L.pingTimer);
      L.watchdog = null;
      L.pingTimer = null;
    };

    const delay = () => {
      const L = loopRef.current;
      return notificationPollDelay({
        pollAfterSecs: L.pollAfterSecs,
        visible: pollVisible(),
        osEnabled: osEnabled(),
        outcome: L.outcome,
        retryAfter: L.retryAfter,
        errorStreak: L.errorStreak,
      });
    };

    const schedule = () => {
      clearTimer();
      const L = loopRef.current;
      if (L.mode === "follower") return armWatchdog(); // followers never schedule count requests
      if (!L.userId || L.inFlight) return;
      const d = delay();
      if (d === null) return;
      L.timerDue = L.lastResponseAt + d;
      L.timer = setTimeout(tick, Math.max(0, L.timerDue - Date.now()));
    };

    const tick = () => {
      const L = loopRef.current;
      L.timer = null;
      if (!L.userId || L.inFlight || L.mode === "follower") return;
      const d = delay();
      if (d === null) return; // paused (hidden) or stopped; a wake-up resumes
      if (Date.now() < L.lastResponseAt + d) return schedule(); // cadence changed since scheduling
      void poll();
    };

    /** Adopt a server unread value in this tab only (also used for received `unread` messages). */
    const setServerUnread = (n: number) => {
      const L = loopRef.current;
      const v = clampUnread(n);
      L.unread = v;
      setView((s) => ({ ...s, unread: v }));
      return v;
    };
    /** Adopt a server unread value and share it with the other tabs. */
    const syncUnread = (n: number) => {
      const v = setServerUnread(n);
      if (loopRef.current.userId) post({ type: "unread", unread: v });
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

    /**
     * Applies a count, from this tab's own request or from another tab (`fromPeer`). unread, latestAt, lastChange,
     * arrivals and the live-region announcement behave the same in every tab. Only the leader (or an uncoordinated
     * tab) runs the OS-notification step. Returns the normalised count.
     */
    const applyCount = (c: Partial<UnreadCount> | null | undefined, fromPeer: boolean): UnreadCount => {
      const L = loopRef.current;
      const unread = clampUnread(c?.unread);
      const latestAt = typeof c?.latestAt === "string" ? c.latestAt : null;
      const now = Date.now();
      // A received count is a fresh response for the leader's schedule too (a follower's refresh never double-polls).
      L.lastResponseAt = now;
      L.lastCountAt = now;
      if (!fromPeer || !halted()) {
        L.outcome = "ok";
        L.retryAfter = undefined;
        L.errorStreak = 0;
      }
      L.pollAfterSecs = normalizePollSecs(c?.pollAfterSecs);
      const prev = L.unread;
      const changed = prev !== null && newer(latestAt, L.latestAt);
      // Only latestAt moving past the newest value seen so far means something new arrived; a count going
      // back up with the same latestAt (heart/follow toggled off and on while unread) is not announced.
      const advanced = newer(latestAt, L.seenAt);
      const arrived = prev !== null && advanced && unread > prev;
      if (arrived) {
        const d = unread - prev;
        announce(`${d} new notification${d === 1 ? "" : "s"}`);
      }
      L.unread = unread;
      L.latestAt = latestAt;
      if (advanced) L.seenAt = latestAt;
      const count: UnreadCount = { unread, latestAt, pollAfterSecs: L.pollAfterSecs };
      L.lastCount = count;
      setView((s) => ({
        ...s,
        supported: true,
        ready: true,
        unread,
        latestAt,
        lastChange: changed ? s.lastChange + 1 : s.lastChange,
        arrivals: arrived ? s.arrivals + 1 : s.arrivals,
      }));
      if (L.mode !== "follower") void osStep(count);
      return count;
    };

    const markUnsupported = () => {
      loopRef.current.outcome = "unsupported";
      clearTimer();
      clearFollowerTimers();
      setView((s) => ({ ...s, supported: false, ready: true, unread: 0, latestAt: null }));
    };

    /**
     * A 401 from the count: ask auth to revalidate the session (review 4, L7). If it signs out (or a new token
     * arrives), the provider effect stops / restarts the loop; if the session is still good, retry with backoff.
     */
    const reauth = async (gen: number) => {
      try {
        await authRefreshRef.current();
      } catch {
        /* treated like "still signed in" below */
      }
      const L = loopRef.current;
      if (gen !== L.gen || !L.userId || L.outcome !== "unauthorized") return;
      if (!apiRef.current.token) return; // signed out: the effect stops the loop on the next render
      L.outcome = "error";
      L.errorStreak += 1;
      schedule();
    };

    /** Requests the count in this tab (any role) and shares a success or a 404 with the other tabs. */
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
          const count = applyCount(c, false);
          post({ type: "count", count });
        } catch (e) {
          if (gen !== loopRef.current.gen) return;
          L.lastResponseAt = Date.now();
          if (isApiError(e) && e.status === 404) {
            markUnsupported();
            post({ type: "unsupported" });
            return;
          }
          // 401 and 429 are not broadcast: each tab's auth handles 401, followers keep their last count.
          if (isApiError(e) && e.status === 401) {
            L.outcome = "unauthorized";
            void reauth(gen);
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

    // ---------- F018 follower: watchdog and visible pings ----------

    const watchdogDue = () => {
      const L = loopRef.current;
      if (!L.lastCountAt && !L.lastWatchdogAt) return L.followerStart + FOLLOWER_START_GRACE_MS;
      return Math.max(L.lastCountAt, L.lastWatchdogAt) + followerWatchdogMs(L.pollAfterSecs);
    };

    const armWatchdog = () => {
      const L = loopRef.current;
      if (L.watchdog !== null) clearTimeout(L.watchdog);
      L.watchdog = null;
      if (!L.userId || L.mode !== "follower" || L.inFlight || halted()) return;
      L.watchdog = setTimeout(fireWatchdog, Math.max(0, watchdogDue() - Date.now()));
    };

    const fireWatchdog = () => {
      const L = loopRef.current;
      L.watchdog = null;
      if (!L.userId || L.mode !== "follower" || L.inFlight || halted()) return;
      if (Date.now() < watchdogDue()) return armWatchdog(); // a count arrived since arming
      if (!isVisible()) return; // only visible followers step in; becoming visible re-arms
      L.lastWatchdogAt = Date.now();
      void poll();
    };

    const pingTick = () => {
      const L = loopRef.current;
      L.pingTimer = null;
      if (!L.userId || L.mode !== "follower" || halted() || !isVisible()) return;
      post({ type: "visible" });
      L.pingTimer = setTimeout(pingTick, VISIBLE_PING_MS);
    };

    /** A follower that starts or wakes: ping `visible`, ask for a fresh count when its own is stale, re-arm the watchdog. */
    const followerWake = () => {
      const L = loopRef.current;
      if (!L.userId || L.mode !== "follower" || halted()) return;
      if (L.pingTimer !== null) clearTimeout(L.pingTimer);
      L.pingTimer = null;
      pingTick();
      if (Date.now() - L.lastCountAt >= POLL_STALE_MS) post({ type: "poll" });
      armWatchdog();
    };

    /** Window focus / tab visible: fetch at once when the last response is stale, else keep the cadence. */
    const wake = () => {
      const L = loopRef.current;
      if (L.mode === "follower") return followerWake();
      if (!L.userId || L.inFlight) return;
      if (L.outcome === "unauthorized" || L.outcome === "unsupported") return;
      if (L.outcome === "ok" && Date.now() - L.lastResponseAt >= POLL_STALE_MS) {
        void poll();
        return;
      }
      schedule();
    };

    // ---------- F018: election and messages ----------

    const becomeLeader = () => {
      const L = loopRef.current;
      if (!L.userId || L.mode === "leader") return;
      L.mode = "leader";
      clearFollowerTimers();
      if (halted()) return;
      if (Date.now() - L.lastCountAt >= POLL_STALE_MS) void poll();
      else schedule();
    };

    const onMessage = (m: TabMessage) => {
      const L = loopRef.current;
      if (!L.userId || m.userId !== L.userId) return;
      switch (m.type) {
        case "count":
          if (L.outcome === "unsupported") return;
          applyCount(m.count, true);
          schedule();
          return;
        case "unread":
          setServerUnread(m.unread);
          return;
        case "poll":
          if (L.mode !== "leader") return;
          if (L.outcome === "unsupported") return post({ type: "unsupported" });
          if (L.outcome === "unauthorized" || L.inFlight) return; // an in-flight result is broadcast anyway
          if (!L.lastCount || Date.now() - L.lastResponseAt >= POLL_STALE_MS) void poll();
          else post({ type: "count", count: L.lastCount });
          return;
        case "visible":
          if (L.mode !== "leader") return;
          L.lastVisiblePing = Date.now();
          // Wake a paused loop (hidden leader without OS notifications) like a focus event. A running loop only
          // re-plans when the ping makes the next poll earlier (hidden leader with OS notifications: 2× cadence).
          if (L.timer === null && !L.inFlight) wake();
          else if (L.timer !== null) {
            const d = delay();
            if (d !== null && L.lastResponseAt + d < L.timerDue) schedule();
          }
          return;
        case "unsupported":
          markUnsupported();
          return;
      }
    };

    const leave = () => {
      clearTimer();
      clearFollowerTimers();
      const L = loopRef.current;
      const session = L.session;
      L.session = null;
      session?.stop();
    };

    const start = (uid: string | null) => {
      leave();
      const gen = loopRef.current.gen + 1;
      const L = freshLoop(gen, uid);
      loopRef.current = L;
      setView(INITIAL_VIEW);
      if (!uid) return;
      let session: TabSession | null = null;
      try {
        session =
          createTabCoordinator(tabsRef.current ?? {})?.join(apiRef.current.baseUrl ?? "", uid, {
            onLeader: () => {
              if (gen === loopRef.current.gen) becomeLeader();
            },
            onMessage: (m) => {
              if (gen === loopRef.current.gen) onMessage(m);
            },
          }) ?? null;
      } catch {
        session = null;
      }
      if (gen !== loopRef.current.gen) {
        session?.stop();
        return;
      }
      if (!session) {
        void poll(); // uncoordinated: F007 per-tab polling
        return;
      }
      L.session = session;
      // A follower until the lock is granted (at once when no other tab holds it).
      if (L.mode === "solo") {
        L.mode = "follower";
        L.followerStart = Date.now();
        followerWake();
      }
    };

    const stop = () => {
      leave();
      loopRef.current = freshLoop(loopRef.current.gen + 1, null);
    };

    return { announce, poll, wake, start, stop, schedule, setServerUnread, syncUnread, isVisible };
  }, []);

  // (Re)start on sign-in / user change / token change (e.g. the same user signed in again in another tab after a
  // 401) / client change (F018: a new server is a new coordination scope); stop and clear on sign-out.
  useEffect(() => {
    ctrl.start(userId);
    return () => ctrl.stop();
  }, [ctrl, userId, token, api]);

  useEffect(() => {
    const onVisibility = () => (ctrl.isVisible() ? ctrl.wake() : ctrl.schedule());
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
        if (gen === loopRef.current.gen) ctrl.syncUnread(r?.unread ?? 0);
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
      if (gen === loopRef.current.gen) ctrl.syncUnread(unread);
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
      arrivals: view.arrivals,
      refresh: ctrl.poll,
      markRead,
      markAllRead,
      syncUnread: ctrl.syncUnread,
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
