// F016: account sync of control bindings (ARCHITECTURE.md § F016 "Sync algorithm"). Mounted by GamePlayer only;
// anonymous players and the Studio never sync. The device store stays the source the game is fed from: this hook
// only writes it (adopting the account copy) and uploads it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client";
import type { ControlAction, ControlBindings, User } from "./api/types";
import type { ControlsSyncState } from "./components/ControlsPanel";
import { isEmptyBindings, pruneBindings, readBindings, readUnsynced, sameBindings, sanitizeBindings, writeBindings } from "./controls";

export type { ControlsSyncState };

/** Changes within this window coalesce into one `PUT …/controls`. */
export const CONTROLS_SYNC_DEBOUNCE_MS = 1000;

/** The client the hook uses. `token` (as on `ApiClient`) is compared before each upload to detect account switches. */
export type ControlsSyncApi = Pick<ApiClient, "getControls" | "putControls"> & { token?: string | null };

type AuthSnapshot = { uid: string; token: string | null | undefined };

function tokenOf(api: ControlsSyncApi): string | null | undefined {
  return api.token;
}

function snapshot(uid: string, api: ControlsSyncApi): AuthSnapshot {
  return { uid, token: tokenOf(api) };
}

export type ControlsSync = {
  /** For the panel footer. */
  syncState: ControlsSyncState;
  /** The panel's `onChange`: writes the device store at once (marked unsynced when signed in), then a debounced `PUT`. */
  change: (bindings: ControlBindings) => void;
};

/**
 * Syncs a game's bindings with the signed-in user's account:
 * 1. On mount and whenever the user changes: an unsynced change of this user on the device is uploaded without reading
 *    the account copy; otherwise `GET` adopts the account copy, or uploads non-empty device bindings when the account
 *    has none. A failed `GET` leaves the device copy in charge (no retry loop).
 * 2. `change` writes the device store at once with `unsynced = user.id` and debounces a `PUT` by 1000 ms.
 * 3. A successful `PUT` clears `unsynced` and adopts the server's normalised copy, only when the device still holds
 *    exactly what was sent.
 * 4. A failed `PUT` keeps `unsynced` and reports `"failed"`; it is retried on the next change or mount (no timer).
 * 5. Unmount (and `pagehide`) with a pending debounce sends the `PUT` at once with `keepalive`.
 * Every upload is tied to the user (and client token) of the change or session that scheduled it. If either changed
 * by the time it would be sent, no `PUT` is made and the entry stays unsynced for its owner. While the device holds
 * another user's unsynced change, a different signed-in user neither adopts nor uploads it.
 * Games without actions never sync.
 */
export function useControlsSync(
  gameId: string,
  defaults: readonly ControlAction[],
  user: Pick<User, "id"> | null | undefined,
  api: ControlsSyncApi,
): ControlsSync {
  const userId = user?.id ?? null;
  const enabled = defaults.length > 0;
  const [syncState, setSyncState] = useState<ControlsSyncState>(userId && enabled ? "account" : "device");
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const session = useRef<{ change: (b: ControlBindings) => void } | null>(null);
  // The signed-in user as of the latest render. It is updated before an effect's cleanup runs, so a flush during a
  // user switch sees the new user.
  const currentUser = useRef(userId);
  currentUser.current = userId;

  useEffect(() => {
    if (!userId || !enabled) {
      setSyncState("device");
      session.current = null;
      return;
    }
    const uid = userId;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Auth snapshot taken when the pending upload was scheduled (debounce) or when this session started. */
    let scheduled: AuthSnapshot = snapshot(uid, api);
    setSyncState("account");

    // An upload belongs to the user who made the change. If the signed-in user or the client's token changed since
    // (a direct account switch, a sign-in in another tab, sign-out), don't send it: the device entry stays marked
    // unsynced for that user and is uploaded at their next sign-in.
    const stillSignedIn = (s: AuthSnapshot) => currentUser.current === s.uid && tokenOf(api) === s.token;

    const upload = (s: AuthSnapshot, keepalive = false) => {
      if (!stillSignedIn(s)) return;
      const sent = pruneBindings(readBindings(gameId), defaultsRef.current);
      api.putControls(gameId, sent, keepalive ? { keepalive: true } : {}).then(
        (r) => {
          // Clear the marker only if nothing changed on the device since this upload (and it is still this user's).
          if (readUnsynced(gameId) === uid && sameBindings(pruneBindings(readBindings(gameId), defaultsRef.current), sent)) {
            writeBindings(gameId, sanitizeBindings(r?.bindings), defaultsRef.current, { unsynced: null });
          }
          if (alive && timer === null) setSyncState("account");
        },
        () => {
          if (alive) setSyncState("failed");
        },
      );
    };

    const flush = (keepalive = false) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      upload(scheduled, keepalive);
    };

    session.current = {
      change: (b) => {
        writeBindings(gameId, b, defaultsRef.current, { unsynced: uid });
        if (timer !== null) clearTimeout(timer);
        const s = snapshot(uid, api);
        scheduled = s;
        timer = setTimeout(() => {
          timer = null;
          upload(s);
        }, CONTROLS_SYNC_DEBOUNCE_MS);
        if (alive) setSyncState((st) => (st === "failed" ? st : "account"));
      },
    };

    const start = scheduled;
    const pendingFor = readUnsynced(gameId);
    if (pendingFor === uid) upload(start);
    else if (pendingFor !== null) {
      // Another account's change is still waiting for its owner: neither adopt this account's copy over it nor
      // upload it here. This user's own next change takes the entry over.
      setSyncState("device");
    } else {
      api.getControls(gameId).then(
        (r) => {
          if (!alive || !stillSignedIn(start)) return;
          // A change made while the GET was in flight is newer: its debounced PUT wins.
          if (readUnsynced(gameId) !== null || timer !== null) return;
          if (r && r.bindings != null) {
            writeBindings(gameId, sanitizeBindings(r.bindings), defaultsRef.current, { unsynced: null });
          } else if (!isEmptyBindings(pruneBindings(readBindings(gameId), defaultsRef.current))) {
            upload(start);
          }
        },
        () => {
          if (!alive) return;
          // The device copy stays in charge until the next mount; say so when it holds something the account may lack.
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
  }, [gameId, userId, enabled, api]);

  const change = useCallback(
    (b: ControlBindings) => {
      if (session.current) session.current.change(b);
      else writeBindings(gameId, b, defaultsRef.current);
    },
    [gameId],
  );

  return { syncState: userId && enabled ? syncState : "device", change };
}
