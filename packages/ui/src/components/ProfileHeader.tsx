import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ProfileLink, UserProfileResponse } from "../api/types";
import { useApi, useConfig } from "../context/config";
import { isSafeProfileUrl, linkHost, profilePath } from "../profile";
import { profileShareUrl } from "../share";
import { formatCount, formatMonthYear } from "../util";
import { Avatar, Skeleton } from "./common";
import { CopyLinkButton } from "./CopyLinkButton";
import { FollowButton, useFollows } from "./Follow";
import { useMediaQuery } from "./Layout";
import { ReportButton } from "./Report";

/** F028: at or below this width the header is centred and the avatar shrinks (keep in sync with styles.css). */
export const PROFILE_COMPACT_QUERY = "(max-width: 640px)";
/** F028: at or below this width the banner is 140 px high (112 px at the compact width). */
export const PROFILE_BANNER_MEDIUM_QUERY = "(max-width: 860px)";

export type ProfileHeaderProps = { profile: UserProfileResponse; isMe: boolean };

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

/** The safe links of a user, in order (anything not passing the server URL rule is dropped). */
function displayableLinks(links: ProfileLink[] | undefined): ProfileLink[] {
  if (!Array.isArray(links)) return [];
  return links.filter((l) => !!l && typeof l.url === "string" && isSafeProfileUrl(l.url));
}

/**
 * F028 profile header card: banner, avatar overlapping it, name, `@username · Joined Month YYYY`, bio, links, stats
 * and actions (Edit profile / Follow, Copy link, Report). Seeds the follow cache with the profile's server truth.
 */
export function ProfileHeader({ profile, isMe }: ProfileHeaderProps) {
  const api = useApi();
  const config = useConfig();
  const follows = useFollows();
  const compact = useMediaQuery(PROFILE_COMPACT_QUERY);
  const [fallbackSlot, setFallbackSlot] = useState<HTMLDivElement | null>(null);
  const { user, stats } = profile;
  const name = user.displayName || user.username;

  // Fresh profile data is the server truth for the follow cache (keeps other buttons for this user in sync).
  const seed = follows?.seed;
  useEffect(() => {
    if (seed && typeof profile.isFollowing === "boolean") {
      seed(profile.user.username, { following: profile.isFollowing, followers: profile.followers });
    }
  }, [profile, seed]);

  const gamesTotal = typeof profile.gamesTotal === "number" ? profile.gamesTotal : profile.games.length;
  const followState = follows?.get(user.username, { following: !!profile.isFollowing, followers: profile.followers }) ?? {
    following: !!profile.isFollowing,
    followers: profile.followers,
  };
  const followers = followState.followers ?? profile.followers ?? 0;
  const joined = formatMonthYear(user.createdAt);
  const links = displayableLinks(user.links);
  const base = profilePath(user.username);
  const avatarSize = compact ? 88 : 112;

  return (
    <section className="pf-profile">
      <div className={`pf-profile__banner${user.bannerUrl ? " has-image" : ""}`}>{user.bannerUrl ? <img src={api.url(user.bannerUrl)} alt="" /> : null}</div>
      <div className="pf-profile__body">
        <div className="pf-profile__avatar" style={{ marginTop: -avatarSize / 2 }}>
          <Avatar user={user} size={avatarSize} />
        </div>
        <div className="pf-profile__row">
          <div className="pf-profile__info">
            <h1>{name}</h1>
            <p className="pf-muted">
              @{user.username}
              {joined ? ` · Joined ${joined}` : ""}
            </p>
            {user.bio ? <p className="pf-profile__bio">{user.bio}</p> : isMe ? <p className="pf-muted">You haven't written a bio yet.</p> : null}
            {links.length > 0 && (
              <ul className="pf-profile__links" aria-label="Links">
                {links.map((l, i) => {
                  const text = l.label || linkHost(l.url);
                  return (
                    <li key={`${i}:${l.url}`}>
                      <a href={l.url.trim()} target="_blank" rel="noopener noreferrer nofollow ugc" title={text}>
                        <span aria-hidden="true">🔗</span> <span className="pf-profile__link-text">{text}</span>
                        <span className="pf-sr-only"> (opens in a new tab)</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="pf-profile__stats">
              <span>
                <strong>{formatCount(gamesTotal)}</strong> {plural(gamesTotal, "game", "games")}
              </span>
              {stats && typeof stats.plays === "number" && (
                <span>
                  <strong>{formatCount(stats.plays)}</strong> {plural(stats.plays, "play", "plays")}
                </span>
              )}
              {typeof profile.followers === "number" && (
                <Link to={`${base}/followers`} className="pf-profile__stat-link">
                  <strong>{formatCount(followers)}</strong> {plural(followers, "follower", "followers")}
                </Link>
              )}
              {typeof profile.following === "number" && (
                <Link to={`${base}/following`} className="pf-profile__stat-link">
                  <strong>{formatCount(profile.following)}</strong> following
                </Link>
              )}
              {stats && typeof stats.achievements === "number" && (
                <span>
                  <strong>{formatCount(stats.achievements)}</strong> {plural(stats.achievements, "achievement", "achievements")}
                </span>
              )}
            </div>
          </div>
          <div className="pf-profile__actions">
            {isMe ? (
              <>
                <Link to="/settings" className="pf-btn pf-btn--ghost pf-profile__edit">
                  Edit profile
                </Link>
                <CopyLinkButton url={profileShareUrl(config, user.username)} fallbackContainer={fallbackSlot} />
              </>
            ) : (
              <>
                <FollowButton username={user.username} displayName={user.displayName} isFollowing={!!profile.isFollowing} followers={profile.followers} />
                <CopyLinkButton url={profileShareUrl(config, user.username)} fallbackContainer={fallbackSlot} />
                <ReportButton targetType="user" targetId={user.id} targetLabel={`@${user.username}`} className="pf-btn pf-btn--ghost pf-btn--sm">
                  ⚑ Report
                </ReportButton>
              </>
            )}
          </div>
        </div>
        <div className="pf-profile__share" ref={setFallbackSlot} />
      </div>
    </section>
  );
}

/** Loading state of {@link ProfileHeader}: banner, avatar circle and three text bars. */
export function ProfileHeaderSkeleton() {
  const compact = useMediaQuery(PROFILE_COMPACT_QUERY);
  const medium = useMediaQuery(PROFILE_BANNER_MEDIUM_QUERY);
  const avatarSize = compact ? 88 : 112;
  const bannerHeight = compact ? 112 : medium ? 140 : 200;
  return (
    <section className="pf-profile pf-profile--loading" aria-busy="true">
      <Skeleton className="pf-profile__banner-skeleton" width="100%" height={bannerHeight} radius={0} />
      <div className="pf-profile__body">
        <div className="pf-profile__avatar" style={{ marginTop: -avatarSize / 2 }}>
          <Skeleton width={avatarSize} height={avatarSize} radius={avatarSize / 2} />
        </div>
        <div className="pf-profile__row">
          <div className="pf-profile__info">
            <Skeleton width={200} height={28} />
            <Skeleton width={120} height={16} />
            <Skeleton width="80%" height={16} />
          </div>
        </div>
      </div>
    </section>
  );
}
