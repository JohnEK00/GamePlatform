import { muteToastText, useMuteToggle } from "./muteSupport";

export type MuteThreadButtonProps = {
  /** The thread's top-level comment. */
  commentId: string;
  /** `Comment.threadMuted` of the top-level comment. */
  muted: boolean;
  /** The top-level comment's author name (for the accessible name). */
  authorName: string;
};

/** F018 § 2.2: link-style "Mute thread" / "Unmute thread" in a top-level comment's action row. */
export function MuteThreadButton({ commentId, muted: initial, authorName }: MuteThreadButtonProps) {
  const { muted, toggle } = useMuteToggle("thread", commentId, initial, {
    muted: muteToastText.threadMuted,
    unmuted: muteToastText.threadUnmuted,
  });
  const on = muted === true;
  return (
    <button
      type="button"
      id={`mute-btn-${commentId}`}
      className={`pf-linkbtn pf-comment__mute${on ? " is-on" : ""}`}
      aria-pressed={on}
      aria-label={`${on ? "Unmute" : "Mute"} notifications for the thread by ${authorName}`}
      onClick={() => void toggle(!on)}
    >
      {on ? "Unmute thread" : "Mute thread"}
    </button>
  );
}
