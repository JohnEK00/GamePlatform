import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { FeedItem as FeedItemData, FeedItemKind } from "../api/types";
import { normalizeLeaderboardConfig } from "../leaderboard";
import { formatScore, timeAgo } from "../util";
import { AchievementIcon } from "./Achievements";
import { Avatar, Skeleton, Thumbnail } from "./common";

/** The feed item kinds this client understands; anything else is ignored (forward compatibility). */
export const FEED_ITEM_KINDS: readonly FeedItemKind[] = ["gamePublished", "gameUpdated", "personalBest", "achievementUnlocked"];

export function isKnownFeedItem(item: { kind?: unknown } | null | undefined): item is FeedItemData {
  return !!item && FEED_ITEM_KINDS.includes(item.kind as FeedItemKind);
}

/** "Best time 1:02.345": the score formatted per the game's current leaderboard config, prefixed by its label. */
export function feedScoreDisplay(score: NonNullable<FeedItemData["score"]>): string {
  const cfg = normalizeLeaderboardConfig(score.leaderboard);
  const value = formatScore(score.value, cfg.format);
  const label = cfg.label.trim();
  return label ? `${label} ${value}` : value;
}

/** The sentence for one item, with links on the actor and game names. Null when the item can't be shown. */
function sentence(item: FeedItemData): ReactNode {
  const actor = (
    <Link to={`/u/${encodeURIComponent(item.actor.username)}`} className="pf-feeditem__actor">
      <strong>{item.actor.displayName || item.actor.username}</strong>
    </Link>
  );
  const game = (
    <Link to={`/games/${encodeURIComponent(item.game.id)}`} className="pf-feeditem__gamename">
      <strong>{item.game.title}</strong>
    </Link>
  );
  switch (item.kind) {
    case "gamePublished":
      return (
        <>
          {actor} published {game}
        </>
      );
    case "gameUpdated":
      return item.version != null ? (
        <>
          {actor} updated {game} to v{item.version}
        </>
      ) : (
        <>
          {actor} updated {game}
        </>
      );
    case "personalBest": {
      if (!item.score) return null;
      const display = feedScoreDisplay(item.score);
      return item.score.first ? (
        <>
          {actor} scored {display} in {game}
        </>
      ) : (
        <>
          {actor} set a new personal best in {game}: {display}
        </>
      );
    }
    case "achievementUnlocked": {
      const a = item.achievement;
      if (!a) return null;
      const more = Math.max(0, Math.floor(a.count) - 1);
      return more > 0 ? (
        <>
          {actor} unlocked <strong>{a.name}</strong> and {more} more in {game}
        </>
      ) : (
        <>
          {actor} unlocked <strong>{a.name}</strong> in {game}
        </>
      );
    }
    default:
      return null;
  }
}

/** One activity-feed row: actor avatar, sentence, time, and a compact link to the game. Unknown kinds render nothing. */
export function FeedItem({ item }: { item: FeedItemData }) {
  if (!isKnownFeedItem(item)) return null;
  const text = sentence(item);
  if (text === null) return null;
  const ach = item.kind === "achievementUnlocked" ? item.achievement : null;
  return (
    <article className="pf-feeditem" data-kind={item.kind}>
      <Link to={`/u/${encodeURIComponent(item.actor.username)}`} className="pf-feeditem__avatar" tabIndex={-1} aria-hidden="true">
        <Avatar user={item.actor} size={40} />
      </Link>
      <div className="pf-feeditem__body">
        <p className="pf-feeditem__text">{text}</p>
        <div className="pf-feeditem__meta pf-small pf-muted">
          <time dateTime={item.createdAt}>{timeAgo(item.createdAt)}</time>
          {item.reason === "favorite" && <span className="pf-feeditem__tag">From your favorites</span>}
        </div>
        <Link to={`/games/${encodeURIComponent(item.game.id)}`} className="pf-feeditem__game">
          <span className="pf-feeditem__thumb">
            <Thumbnail src={item.game.thumbnailUrl} seed={item.game.id} alt="" />
          </span>
          <span className="pf-feeditem__gametitle">{item.game.title}</span>
        </Link>
      </div>
      {ach?.iconUrl && (
        <span className="pf-feeditem__ach">
          <AchievementIcon iconUrl={ach.iconUrl} seed={`${item.game.id}:${ach.id}`} size={40} />
        </span>
      )}
    </article>
  );
}

/** Placeholder row while the feed loads. */
export function FeedItemSkeleton() {
  return (
    <div className="pf-feeditem pf-feeditem--skeleton" aria-hidden="true">
      <Skeleton width={40} height={40} radius={20} />
      <div className="pf-feeditem__body">
        <Skeleton width="70%" height={16} />
        <Skeleton width={80} height={12} />
        <Skeleton width={220} height={44} radius={8} />
      </div>
    </div>
  );
}
