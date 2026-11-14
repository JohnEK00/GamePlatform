import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isApiError, type ApiClient } from "../api/client";
import type { FollowResponse } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast, type ToastApi } from "../context/toast";
import { errorMessage } from "../util";

/** Follow state for one user. `followers` is undefined when the count is unknown (e.g. a game page). */
export type FollowState = { following: boolean; followers?: number };

export type FollowsApi = {
  /** Current state for a user: the cached (optimistic / confirmed) state wins over the given fallback. */
  get: (username: string, fallback: FollowState) => FollowState;
  /** The cached state, or undefined when nothing is known yet. */
  peek: (username: string) => FollowState | undefined;
  /** Records server truth (e.g. from a freshly loaded profile). Ignored while a toggle for that user is in flight. */
  seed: (username: string, state: FollowState) => void;
  /** Optimistically toggles; resolves with the confirmed state (or the reverted one on error). */
  toggle: (username: string, current: FollowState) => Promise<FollowState>;
  isPending: (username: string) => boolean;
};

const FollowContext = createContext<FollowsApi | null>(null);

const key = (username: string) => username.toLowerCase();

function flipped(current: FollowState): FollowState {
  const following = !current.following;
  return {
    following,
    followers: current.followers === undefined ? undefined : Math.max(0, current.followers + (following ? 1 : -1)),
  };
}

function toastFollowError(toast: ToastApi, follow: boolean, e: unknown) {
  if (isApiError(e) && (e.status === 429 || e.code === "rate_limited")) {
    toast.error(e.retryAfter ? `Slow down — try again in ${e.retryAfter}s` : "Slow down — try again in a moment");
    return;
  }
  toast.error(follow ? "Couldn't follow" : "Couldn't unfollow", errorMessage(e));
}

/** PUT/DELETE the follow; returns the confirmed state or throws. */
async function sendFollow(api: ApiClient, username: string, follow: boolean): Promise<{ state: FollowState; response: FollowResponse }> {
  const r = await api.setFollowing(username, follow);
  return { state: { following: !!r.following, followers: r.followers }, response: r };
}

/**
 * Follow-state cache (username, case-insensitive → isFollowing + follower count) so that every FollowButton for the
 * same user on one screen stays in sync. Same pattern as FavoritesProvider. Reset when the signed-in user changes.
 */
export function FollowProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { user } = useAuth();
  const toast = useToast();
  const [cache, setCache] = useState<Record<string, FollowState>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef(new Set<string>());
  const userId = user?.id ?? null;

  useEffect(() => {
    setCache({});
  }, [userId]);

  const setPendingFor = (k: string, on: boolean) => {
    if (on) pendingRef.current.add(k);
    else pendingRef.current.delete(k);
    setPending(new Set(pendingRef.current));
  };

  const get = useCallback((username: string, fallback: FollowState) => cache[key(username)] ?? fallback, [cache]);
  const peek = useCallback((username: string) => cache[key(username)], [cache]);

  const seed = useCallback((username: string, state: FollowState) => {
    const k = key(username);
    if (pendingRef.current.has(k)) return;
    setCache((c) => {
      const prev = c[k];
      if (prev && prev.following === state.following && prev.followers === state.followers) return c;
      return { ...c, [k]: { following: state.following, followers: state.followers ?? prev?.followers } };
    });
  }, []);

  const toggle = useCallback(
    async (username: string, current: FollowState): Promise<FollowState> => {
      const k = key(username);
      if (pendingRef.current.has(k)) return current;
      const next = flipped(current);
      setCache((c) => ({ ...c, [k]: next }));
      setPendingFor(k, true);
      try {
        const { state } = await sendFollow(api, username, next.following);
        setCache((c) => ({ ...c, [k]: state }));
        return state;
      } catch (e) {
        setCache((c) => ({ ...c, [k]: current }));
        toastFollowError(toast, next.following, e);
        return current;
      } finally {
        setPendingFor(k, false);
      }
    },
    [api, toast],
  );

  const value = useMemo<FollowsApi>(
    () => ({ get, peek, seed, toggle, isPending: (u) => pending.has(key(u)) }),
    [get, peek, seed, toggle, pending],
  );
  return <FollowContext.Provider value={value}>{children}</FollowContext.Provider>;
}

/** Follow-state cache, or null outside a FollowProvider. */
export function useFollows(): FollowsApi | null {
  return useContext(FollowContext);
}

export type FollowButtonProps = {
  username: string;
  isFollowing: boolean;
  /** The target's follower count, when known (kept in the cache so other views can show it). */
  followers?: number;
  /** Shown to screen readers ("Follow Sam"); defaults to the username. */
  displayName?: string;
  variant?: "default" | "compact";
  /** Called with the server's response after a successful follow / unfollow. */
  onChange?: (r: FollowResponse) => void;
};

/**
 * Follow / Following toggle with optimistic updates. "Following" turns into "Unfollow" on hover/focus.
 * Anonymous viewers are sent to the login page; hidden when the viewer is that user.
 */
export function FollowButton({ username, isFollowing, followers, displayName, variant = "default", onChange }: FollowButtonProps) {
  const store = useFollows();
  const api = useApi();
  const toast = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [local, setLocal] = useState<FollowState | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [hot, setHot] = useState(false);

  const fallback: FollowState = { following: isFollowing, followers };
  const state = store ? store.get(username, fallback) : local ?? fallback;
  const busy = store ? store.isPending(username) : localBusy;

  if (user && user.username.toLowerCase() === username.toLowerCase()) return null;

  const onClick = async () => {
    if (!user) {
      navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    if (busy) return;
    const target = !state.following;
    if (store) {
      const r = await store.toggle(username, state);
      if (r.following === target && r.followers !== undefined) onChange?.({ following: r.following, followers: r.followers });
      return;
    }
    // Standalone (no provider): same behaviour with local state.
    setLocal(flipped(state));
    setLocalBusy(true);
    try {
      const { state: confirmed, response } = await sendFollow(api, username, target);
      setLocal(confirmed);
      onChange?.(response);
    } catch (e) {
      setLocal(state);
      toastFollowError(toast, target, e);
    } finally {
      setLocalBusy(false);
    }
  };

  const following = state.following;
  const text = following ? (hot ? "Unfollow" : "Following") : "Follow";
  const cls = [
    "pf-btn",
    following ? "pf-btn--ghost" : "pf-btn--primary",
    "pf-follow",
    variant === "compact" ? "pf-btn--sm pf-follow--compact" : "",
    following ? "is-following" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={cls}
      onClick={() => void onClick()}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      aria-label={`${text} ${displayName || username}`}
      aria-busy={busy || undefined}
      data-following={following ? "true" : "false"}
    >
      {!following && (
        <span aria-hidden="true" className="pf-follow__plus">
          +
        </span>
      )}
      <span>{text}</span>
    </button>
  );
}
