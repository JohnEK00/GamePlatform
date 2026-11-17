// F016: account sync of control bindings (ARCHITECTURE.md § F016 "Sync algorithm"). Mounted by GamePlayer only;
// anonymous players and the Studio never sync. The device store stays the source the game is fed from: this hook
// only writes it (adopting the account copy) and uploads it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client";
import type { ControlAction, ControlBindings, User } from "./api/types";
import type { ControlsSyncState } from "./components/ControlsPanel";
import {
  isEmptyBindings,
  parkOtherUsersChange,
  pruneBindings,
  readBindings,
  readUnsynced,
  sameBindings,
  sanitizeBindings,
  takeParkedChange,
  writeBindings,
} from "./controls";

export type { ControlsSyncState };

/** Changes within this window coalesce into one `PUT …/controls`. */
export const CONTROLS_SYNC_DEBOUNCE_MS = 1000;

/** The client the hook uses. `token` (as on `ApiClient`) is checked before each upload to detect account switches. */
export type ControlsSyncApi = Pick<ApiClient, "getControls" | "putControls"> & { token?: string | null };

export type ControlsSync = {
  /** For the panel footer. */
  syncState: ControlsSyncState;
  /** The panel's `onChange`: writes the device store at once (marked unsynced when signed in), then a debounced `PUT`. */
  change: (bindings: ControlBindings) => void;
};

type AuthSnapshot = { uid: string; token: string | null | undefined };

function tokenOf(api: ControlsSyncApi): string | null | undefined {
  return api.token;
}

// ---------- one upload in flight per game ----------

type Lane = { busy: boolean; next: (() => Promise<void>) | null };
const lanes = new Map<string, Lane>();

/**
 * Runs `job` when no other upload for the game is in flight; otherwise it replaces any job already waiting (each job
 * reads the latest device bindings when it runs, so the waiting one always sends the newest copy). Requests therefore
 * reach the server in the order they were sent.
 */
function enqueueUpload(gameId: string, job: () => Promise<void>): void {
  let lane = lanes.get(gameId);
  if (!lane) lanes.set(gameId, (lane = { busy: false, next: null }));
  if (lane.busy) {
    lane.next = job;
    return;
  }
  const l = lane;
  const run = (j: () => Promise<void>) => {
    l.busy = true;
    void j()
      .catch(() => {})
      .then(() => {
        l.busy = false;
        const n = l.next;
        l.next = null;
        if (n) run(n);
        else if (lanes.get(gameId) === l) lanes.delete(gameId);
      });
  };
  run(job);
}

/** Test helper: forgets uploads in flight or waiting. */
export function resetControlsSyncForTests(): void {
  lanes.clear();
}

/**
 * Syncs a game's bindings with the signed-in user's account (ARCHITECTURE § F016):
 * 1. A session starts on mount and whenever the user or the client token changes. Its user id and token are recorded
 *    once; every upload of the session is sent only while both are unchanged. Otherwise nothing is sent, the entry
 *    stays unsynced for its owner, and the footer shows "failed" until a session for that user uploads it.
 * 2. Session start: another user's unconfirmed change is parked for its owner, and this user's parked change (if any)
 *    is restored. Then an unsynced change of this user is uploaded without reading the account copy; otherwise `GET`
 *    adopts the account copy, or uploads non-empty device bindings when the account has none. A failed `GET` leaves
 *    the device copy in charge (no retry loop).
 * 3. `change` writes the device store at once with `unsynced = user.id` and debounces a `PUT` by 1000 ms.
 * 4. One `PUT` is in flight per game; a later one waits and then sends the latest bindings. A success clears
 *    `unsynced` and adopts the server's copy only when the device still holds exactly what was sent.
 * 5. A failed `PUT` keeps `unsynced` and reports "failed"; it is retried on the next change or session (no timer).
 * 6. Unmount (and `pagehide`) with a pending debounce queues the `PUT` at once with `keepalive`.
 * Signed-out changes clear any marker. Games without actions never sync.
 */
export function useControlsSync(
  gameId: string,
  defaults: readonly ControlAction[],
  user: Pick<User, "id"> | null | undefined,
  api: ControlsSyncApi,
  /**
   * The auth token as React state, kept consistent with `user` by the host (`useAuth().token`: AuthProvider clears the
   * user whenever the token changes to one it hasn't confirmed). A change restarts the session. When omitted, a raw
   * `api.token` change never restarts a session; it only cancels its uploads.
   */
  token?: string | null,
): ControlsSync {
  const userId = user?.id ?? null;
  const enabled = defaults.length > 0;
  const authToken = token;
  const [syncState, setSyncState] = useState<ControlsSyncState>(userId && enabled ? "account" : "device");
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const session = useRef<{ change: (b: ControlBindings) => void } | null>(null);
  // The signed-in user as of the latest render: updated before an effect's cleanup runs, so a flush during a user
  // switch sees the new user.
  const currentUser = useRef(userId);
  currentUser.current = userId;

  useEffect(() => {
    if (!userId || !enabled) {
      setSyncState("device");
      session.current = null;
      return;
    }
    const uid = userId;
    /** Recorded once per session; never refreshed (review 7, M1). */
    const auth: AuthSnapshot = { uid, token: tokenOf(api) };
    const stillSignedIn = () => currentUser.current === auth.uid && tokenOf(api) === auth.token;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setSyncState("account");

    const job = (keepalive: boolean) => async () => {
      // Nothing left to send: an earlier upload (or an adopted copy) already covers the device entry.
      if (readUnsynced(gameId) !== uid) return;
      if (!stillSignedIn()) {
        // The account changed since this session started: never send this user's change with someone else's token.
        if (alive) setSyncState("failed");
        return;
      }
      const sent = pruneBindings(readBindings(gameId), defaultsRef.current);
      try {
        const r = await api.putControls(gameId, sent, keepalive ? { keepalive: true } : {});
        if (readUnsynced(gameId) === uid && sameBindings(pruneBindings(readBindings(gameId), defaultsRef.current), sent)) {
          writeBindings(gameId, sanitizeBindings(r?.bindings), defaultsRef.current, { unsynced: null });
        }
        if (alive && timer === null) setSyncState("account");
      } catch {
        if (alive) setSyncState("failed");
      }
    };
    const upload = (keepalive = false) => enqueueUpload(gameId, job(keepalive));

    const flush = (keepalive = false) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      upload(keepalive);
    };

    session.current = {
      change: (b) => {
        writeBindings(gameId, b, defaultsRef.current, { unsynced: uid });
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          upload();
        }, CONTROLS_SYNC_DEBOUNCE_MS);
        if (alive) setSyncState((st) => (st === "failed" ? st : "account"));
      },
    };

    // Shared devices (review 7, L2b): another user's unconfirmed change is set aside for them, and this user's own
    // parked change comes back, so nobody edits on top of someone else's bindings.
    parkOtherUsersChange(gameId, uid);
    const mine = takeParkedChange(gameId, uid);
    if (mine) writeBindings(gameId, mine, defaultsRef.current, { unsynced: uid });

    if (readUnsynced(gameId) === uid) upload();
    else {
      api.getControls(gameId).then(
        (r) => {
          if (!alive || !stillSignedIn()) return;
          // A change made while the GET was in flight is newer: its debounced PUT wins.
          if (readUnsynced(gameId) !== null || timer !== null) return;
          if (r && r.bindings != null) {
            writeBindings(gameId, sanitizeBindings(r.bindings), defaultsRef.current, { unsynced: null });
          } else if (!isEmptyBindings(pruneBindings(readBindings(gameId), defaultsRef.current))) {
            writeBindings(gameId, readBindings(gameId), defaultsRef.current, { unsynced: uid });
            upload();
          }
        },
        () => {
          if (!alive) return;
          // The device copy stays in charge until the next session; say so when it holds something the account may lack.
          if (!isEmptyBindings(pruneBindings(readBindings(gameId), defaultsRef.current))) setSyncState("failed");
        },
      );
    }

    const onPageHide = () => flush(true);
    window.addEventListener("pagehide", onPageHide);
    const own = session.current;
    return () => {
      alive = false;
      window.removeEventListener("pagehide", onPageHide);
      flush(true);
      if (session.current === own) session.current = null;
    };
  }, [gameId, userId, enabled, api, authToken]);

  const change = useCallback(
    (b: ControlBindings) => {
      if (session.current) session.current.change(b);
      // Signed out: the latest change is nobody's account change, so any pending marker goes (review 7, L2a).
      else writeBindings(gameId, b, defaultsRef.current, { unsynced: null });
    },
    [gameId],
  );

  return { syncState: userId && enabled ? syncState : "device", change };
}
