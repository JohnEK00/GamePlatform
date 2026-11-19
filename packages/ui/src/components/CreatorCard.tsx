import { Link } from "react-router-dom";
import type { Creator } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { creatorStatsText } from "../creators";
import { profilePath } from "../profile";
import { Avatar, Skeleton } from "./common";
import { FollowButton, useFollows } from "./Follow";

/** Avatar size on a creator card (it overlaps the banner by half). */
const AVATAR = 56;

/**
 * F035 card of the Explore creators page: banner (or the F028 empty gradient), avatar, name, `@username`, a
 * 2-line bio excerpt, stats and a Follow button (or `Your profile` on the viewer's own card).
 */
export function CreatorCard({ creator }: { creator: Creator }) {
  const api = useApi();
  const { user: me } = useAuth();
  const follows = useFollows();
  const { user } = creator;
  const name = user.displayName || user.username;
  const path = profilePath(user.username);
  const nameId = `creator-${user.id || user.username}-name`;
  const followers = follows?.peek(user.username)?.followers ?? creator.followers;
  const banner = creator.bannerUrl ? api.url(creator.bannerUrl) : null;
  const isMe = !!me && me.id === user.id;

  return (
    <article className="pf-creator-card" aria-labelledby={nameId}>
      <div className={`pf-creator-card__banner pf-profile__banner${banner ? " has-image" : ""}`}>
        {banner ? <img src={banner} alt="" loading="lazy" /> : null}
      </div>
      <div className="pf-creator-card__body">
        <Link to={path} className="pf-creator-card__avatar" tabIndex={-1} aria-hidden="true" style={{ marginTop: -AVATAR / 2 }}>
          <Avatar user={user} size={AVATAR} />
        </Link>
        <h2 id={nameId} className="pf-creator-card__name">
          <Link to={path}>{name}</Link>
        </h2>
        <p className="pf-creator-card__handle pf-muted pf-small">@{user.username}</p>
        {creator.bioExcerpt ? <p className="pf-creator-card__bio">{creator.bioExcerpt}</p> : null}
        <p className="pf-creator-card__stats pf-muted pf-small">{creatorStatsText(creator.games, creator.plays, followers)}</p>
        <div className="pf-creator-card__actions">
          {isMe ? (
            <Link className="pf-btn pf-btn--ghost pf-btn--sm" to="/me">
              Your profile
            </Link>
          ) : (
            <FollowButton username={user.username} isFollowing={creator.isFollowing} followers={creator.followers} displayName={name} variant="compact" />
          )}
        </div>
      </div>
    </article>
  );
}

/** Loading placeholder of {@link CreatorCard}: banner block, avatar circle and two text lines. */
export function CreatorCardSkeleton() {
  return (
    <div className="pf-creator-card pf-creator-card--skeleton" aria-hidden="true">
      <Skeleton className="pf-creator-card__banner" width="100%" height="auto" radius={0} />
      <div className="pf-creator-card__body">
        <div className="pf-creator-card__avatar" style={{ marginTop: -AVATAR / 2 }}>
          <Skeleton width={AVATAR} height={AVATAR} radius={AVATAR / 2} />
        </div>
        <Skeleton width="60%" height={18} />
        <Skeleton width="85%" height={12} />
      </div>
    </div>
  );
}
