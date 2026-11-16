// F018: shared mute calls (spec § 2.1–2.4). The server returns the unread count after a mute; it is adopted into
// the bell and shared with the other tabs through `syncUnread`.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MuteState, MuteTarget } from "../api/types";
import { useApi } from "../context/config";
import { useNotifications } from "../context/notifications";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";

/** Toast texts (normative, spec § 2.1 / § 2.2). */
export const muteToastText = {
  gameMuted: (title: string) => `Muted notifications for ${title}`,
  gameUnmuted: (title: string) => `You'll get notifications for ${title} again`,
  threadMuted: "Thread muted. Replies, hearts and pins in it won't notify you.",
  threadUnmuted: "Thread unmuted.",
} as const;

/** `setMute(target, id, muted)`: PUT / DELETE the mute and adopt `MuteState.unread`. Rejects on failure. */
export function useSetMute(): (target: MuteTarget, id: string, muted: boolean) => Promise<MuteState> {
  const api = useApi();
  const { syncUnread } = useNotifications();
  return useCallback(
    async (target, id, muted) => {
      const call =
        target === "game" ? (muted ? api.muteGame(id) : api.unmuteGame(id)) : muted ? api.muteThread(id) : api.unmuteThread(id);
      const r = await call;
      if (r && typeof r.unread === "number") syncUnread(r.unread);
      return { muted: r && typeof r.muted === "boolean" ? r.muted : muted, unread: r?.unread ?? 0 };
    },
    [api, syncUnread],
  );
}

/** Shows the success toast for a confirmed mute change; a mute gets an Undo action that calls `undo`. */
export function useMuteToasts() {
  const toast = useToast();
  return useCallback(
    (muted: boolean, texts: { muted: string; unmuted: string }, undo: () => void) => {
      if (muted) toast.show({ kind: "success", title: texts.muted, action: { label: "Undo", onClick: undo } });
      else toast.success(texts.unmuted);
    },
    [toast],
  );
}

/**
 * Optimistic mute toggle for one target (spec § 2.1 / § 2.2): flips at once, confirms with the server, reverts and
 * shows the server's error on failure. Only the newest click's response is applied. `initial` undefined = the
 * server doesn't support muting (callers hide their button).
 */
export function useMuteToggle(target: MuteTarget, id: string, initial: boolean | undefined, texts: { muted: string; unmuted: string }) {
  const setMute = useSetMute();
  const toast = useToast();
  const showToast = useMuteToasts();
  const [muted, setMuted] = useState<boolean | undefined>(initial);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const seq = useRef(0);
  const textsRef = useRef(texts);
  textsRef.current = texts;

  // A different target or a fresh server value replaces local state (and drops in-flight responses).
  useEffect(() => {
    seq.current++;
    setMuted(initial);
  }, [target, id, initial]);

  const toggleRef = useRef<(next: boolean) => Promise<void>>(async () => {});
  const toggle = useCallback(
    async (next: boolean) => {
      const s = ++seq.current;
      const before = mutedRef.current;
      setMuted(next);
      try {
        const r = await setMute(target, id, next);
        if (s !== seq.current) return;
        setMuted(r.muted);
        showToast(r.muted, textsRef.current, () => void toggleRef.current(false));
      } catch (e) {
        if (s !== seq.current) return;
        setMuted(before);
        toast.error(next ? "Couldn't mute notifications" : "Couldn't unmute notifications", errorMessage(e));
      }
    },
    [setMute, showToast, toast, target, id],
  );
  toggleRef.current = toggle;

  return { muted, toggle };
}
