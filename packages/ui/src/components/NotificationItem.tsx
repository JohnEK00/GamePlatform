import { Fragment, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import type { Notification } from "../api/types";
import { isKnownNotification, muteActionFor, notificationParts, safeNotificationPath, type MuteAction } from "../notifications";
import { timeAgo } from "../util";
import { Avatar } from "./common";

export type NotificationItemProps = {
  item: Notification;
  /** Called on activation (before the link navigates). Mark the item read and close containers here. */
  onActivate?: (item: Notification, e: MouseEvent<HTMLAnchorElement>) => void;
  /** "panel": one-line excerpt; "page": up to 2 lines. */
  variant?: "panel" | "page";
  /**
   * F018 § 2.3: show the "Mute game" / "Mute thread" button after the link (the full page only). Items without a
   * mute target (follows, missing fields) get none.
   */
  showMute?: boolean;
  /** F018: the mute button was activated. */
  onMute?: (item: Notification, action: MuteAction) => void;
  /** F018: a mute request for this item is in flight (the button ignores clicks but keeps focus). */
  muteBusy?: boolean;
};

/** One notification row: a single link (one Tab stop) with avatars, summary, excerpt and time (spec § 2.2). */
export function NotificationItem({ item, onActivate, variant = "panel", showMute = false, onMute, muteBusy = false }: NotificationItemProps) {
  if (!isKnownNotification(item)) return null;
  const parts = notificationParts(item);
  const unread = !item.read;
  const actors = item.actors.slice(0, 2);
  const mute = showMute && onMute ? muteActionFor(item) : null;
  return (
    <li className={`pf-notif pf-notif--${variant}${unread ? " pf-notif--unread" : ""}${mute ? " pf-notif--mutable" : ""}`} data-notif-id={item.id}>
      <Link to={safeNotificationPath(item.path)} className="pf-notif__link" onClick={(e) => onActivate?.(item, e)}>
        <span className={`pf-notif__avatars${actors.length > 1 ? " pf-notif__avatars--stack" : ""}`} aria-hidden="true">
          {actors.map((a) => (
            <Avatar key={a.id} user={a} size={actors.length > 1 ? 28 : 36} />
          ))}
        </span>
        <span className="pf-notif__body">
          <span className="pf-notif__text">
            {unread && <span className="pf-sr-only">Unread: </span>}
            {parts.map((p, i) =>
              p.type === "name" ? (
                <strong key={i}>{p.text}</strong>
              ) : p.type === "title" ? (
                <span key={i} className="pf-notif__game">
                  {p.text}
                </span>
              ) : (
                <Fragment key={i}>{p.text}</Fragment>
              ),
            )}
          </span>
          {item.excerpt && <span className="pf-notif__excerpt">“{item.excerpt}”</span>}
          <span className="pf-notif__meta">
            {item.kind === "heart" && item.creatorHeart && (
              <span className="pf-heart-creator" role="img" aria-label="Hearted by the creator">
                <span aria-hidden="true">♥ Creator</span>
              </span>
            )}
            {item.kind === "pinned" && (
              <span className="pf-notif__kind pf-notif__kind--pinned" aria-hidden="true">
                📌
              </span>
            )}
            {item.kind === "addedToCollection" && (
              <span className="pf-notif__kind pf-notif__kind--collection" aria-hidden="true">
                📚
              </span>
            )}
            <time dateTime={item.updatedAt}>{timeAgo(item.updatedAt)}</time>
          </span>
        </span>
        {unread && <span className="pf-notif__dot" aria-hidden="true" />}
      </Link>
      {mute && (
        <button
          type="button"
          className="pf-linkbtn pf-notif__mute"
          aria-label={mute.label}
          aria-busy={muteBusy || undefined}
          onClick={() => {
            if (!muteBusy) onMute?.(item, mute);
          }}
        >
          {mute.target === "thread" ? "Mute thread" : "Mute game"}
        </button>
      )}
    </li>
  );
}
