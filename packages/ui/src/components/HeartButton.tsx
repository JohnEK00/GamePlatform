import { useRef, useState } from "react";
import type { Comment } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";

export type HeartState = Pick<Comment, "hearts" | "myHeart" | "creatorHeart">;

export type HeartButtonProps = {
  comment: Pick<Comment, "id" | "author"> & HeartState;
  /** Signed in and not the author. Otherwise a plain count is shown (only when > 0). */
  interactive: boolean;
  /** Called with the optimistic state, then the server's, or the previous state when the request fails. */
  onChange?: (next: HeartState) => void;
  /** F031: what is hearted, used in the aria-label ("Heart comment by …" / "Heart post by …"). Default "comment". */
  subject?: "comment" | "post";
  /**
   * F031: performs the toggle instead of `api.setCommentHeart` (e.g. `api.setPostHeart`) and resolves with the
   * server's state. Same optimistic update and rollback.
   */
  onToggle?: (on: boolean) => Promise<HeartState>;
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * F006 heart toggle (spec § 2.3). Optimistic: the count and pressed state change at once and are reconciled with
 * the response; clicks while a request is in flight are ignored (the button stays enabled so focus stays put).
 * Also renders the "♥ Creator" mark when the game's owner hearted the comment.
 */
export function HeartButton({ comment, interactive, onChange, subject = "comment", onToggle }: HeartButtonProps) {
  const api = useApi();
  const toast = useToast();
  const fromProps: HeartState = { hearts: comment.hearts, myHeart: comment.myHeart, creatorHeart: comment.creatorHeart };
  const propKey = `${comment.id}|${comment.hearts}|${comment.myHeart}|${comment.creatorHeart}`;
  const [view, setView] = useState<HeartState>(fromProps);
  const [seenKey, setSeenKey] = useState(propKey);
  if (seenKey !== propKey) {
    // The parent changed the comment (e.g. persisted our update, or reloaded): follow it.
    setSeenKey(propKey);
    setView(fromProps);
  }
  const [pop, setPop] = useState(false);
  const inFlight = useRef(false);
  // The latest view, read when a request settles (never a value captured when the click happened).
  const latest = useRef(view);
  latest.current = view;

  const name = comment.author.displayName || comment.author.username;

  const apply = (next: HeartState) => {
    latest.current = next;
    setView(next);
    onChange?.(next);
  };

  const toggle = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const before = latest.current;
    const on = !before.myHeart;
    apply({ ...before, myHeart: on, hearts: Math.max(0, before.hearts + (on ? 1 : -1)) });
    setPop(on);
    try {
      if (onToggle) {
        const r = await onToggle(on);
        apply({ myHeart: r.myHeart, hearts: Math.max(0, r.hearts), creatorHeart: r.creatorHeart });
      } else {
        const r = await api.setCommentHeart(comment.id, on);
        apply({ myHeart: r.hearted, hearts: Math.max(0, r.hearts), creatorHeart: r.creatorHeart });
      }
    } catch (e) {
      apply(before);
      setPop(false);
      toast.error(errorMessage(e));
    } finally {
      inFlight.current = false;
    }
  };

  const creatorMark = view.creatorHeart ? (
    <span className="pf-heart-creator" role="img" aria-label="Hearted by the creator">
      <span aria-hidden="true">♥ Creator</span>
    </span>
  ) : null;

  if (!interactive) {
    return (
      <>
        {view.hearts > 0 && (
          <span className="pf-heart pf-heart--static" role="img" aria-label={plural(view.hearts, "heart", "hearts")}>
            <span aria-hidden="true">♥ {view.hearts}</span>
          </span>
        )}
        {creatorMark}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`pf-heart${pop ? " pf-heart--pop" : ""}`}
        aria-pressed={view.myHeart}
        aria-label={`Heart ${subject} by ${name}${view.hearts > 0 ? `, ${plural(view.hearts, "heart", "hearts")}` : ""}`}
        onClick={() => void toggle()}
        onAnimationEnd={() => setPop(false)}
      >
        <span className="pf-heart__icon" aria-hidden="true">
          ♥
        </span>
        {view.hearts > 0 && (
          <span className="pf-heart__count" aria-hidden="true">
            {view.hearts}
          </span>
        )}
      </button>
      {creatorMark}
    </>
  );
}
