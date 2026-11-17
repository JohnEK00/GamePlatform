import { useAuth } from "../context/auth";
import { useNotifications } from "../context/notifications";
import { muteToastText, useMuteToggle } from "./muteSupport";

export type MuteGameButtonProps = {
  gameId: string;
  gameTitle: string;
  /** `Game.notificationsMuted`; undefined (older servers) hides the button. */
  muted: boolean | undefined;
  className?: string;
};

function BellIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20a2 2 0 0 0 4 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * F018 § 2.1: "Mute notifications" / "Unmute notifications" on the game page. The visible text is the accessible
 * name and changes with the state, so there is no `aria-pressed` (review 6, L1); the muted state is also styled.
 * Signed-in users only, and only when the server sends `notificationsMuted` and supports notifications.
 */
export function MuteGameButton({ gameId, gameTitle, muted: initial, className = "pf-btn pf-btn--ghost pf-btn--sm pf-mute-btn" }: MuteGameButtonProps) {
  const { user } = useAuth();
  const { supported } = useNotifications();
  const { muted, toggle } = useMuteToggle("game", gameId, typeof initial === "boolean" ? initial : undefined, {
    muted: muteToastText.gameMuted(gameTitle),
    unmuted: muteToastText.gameUnmuted(gameTitle),
  });
  if (!user || !supported || typeof initial !== "boolean" || typeof muted !== "boolean") return null;
  return (
    <button
      type="button"
      className={`${className}${muted ? " is-on" : ""}`}
      title={muted ? "Click to get notifications about this game again" : "Stop notifications about this game: comments, replies, hearts and pins"}
      onClick={() => void toggle(!muted)}
    >
      <BellIcon off={muted} />
      <span>{muted ? "Unmute notifications" : "Mute notifications"}</span>
    </button>
  );
}
