import { useCallback, useEffect, useRef } from "react";

/** F009: why the parent paused the game. The engine has a single host pause flag, so the parent keeps the set. */
export type PauseReason = "visibility" | "controls";

/**
 * The parent's pause reasons (ARCHITECTURE § F009): posts `webgame:pause` when the set becomes non-empty and
 * `webgame:resume` when it becomes empty. Tracks `visibility` (the tab is hidden) itself.
 */
export function usePauseReasons(post: (msg: object) => void): (reason: PauseReason, on: boolean) => void {
  const reasons = useRef(new Set<PauseReason>());
  const postRef = useRef(post);
  postRef.current = post;

  const setReason = useCallback((reason: PauseReason, on: boolean) => {
    const s = reasons.current;
    const was = s.size > 0;
    if (on) s.add(reason);
    else s.delete(reason);
    const now = s.size > 0;
    if (!was && now) postRef.current({ type: "webgame:pause" });
    else if (was && !now) postRef.current({ type: "webgame:resume" });
  }, []);

  useEffect(() => {
    const onVis = () => setReason("visibility", document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [setReason]);

  return setReason;
}
