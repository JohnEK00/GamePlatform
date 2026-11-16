import { useEffect } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { Avatar, EmptyState, ErrorState, Pagination, Skeleton } from "../components/common";
import { FollowButton, useFollows } from "../components/Follow";
import { GameGrid } from "../components/GameCard";
import { RecentAchievements } from "../components/Achievements";
import { formatCount, formatDate, useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";

const GAMES_PER_PAGE = 24;

export function ProfilePage() {
  const { username = "" } = useParams();
  const api = useApi();
  const { user: me } = useAuth();
  const follows = useFollows();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const { data, loading, error, reload } = useAsync(
    () => api.getUser(username, page > 1 ? { page, perPage: GAMES_PER_PAGE } : {}),
    [api, username, page, me?.id],
  );
  useDocumentTitle(data ? data.user.displayName || data.user.username : undefined);

  // Fresh profile data is the server truth for the follow cache (keeps other buttons for this user in sync).
  const seed = follows?.seed;
  useEffect(() => {
    if (data && seed && typeof data.isFollowing === "boolean") {
      seed(data.user.username, { following: data.isFollowing, followers: data.followers });
    }
  }, [data, seed]);

  if (error && isApiError(error) && error.status === 404) return <NotFoundPage what="player" />;
  if (error)
    return (
      <div className="pf-container pf-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );

  const isMe = !!data && !!me && me.id === data.user.id;
  const gamesTotal = data ? (typeof data.gamesTotal === "number" ? data.gamesTotal : data.games.length) : 0;
  // The plays sum is only meaningful when every game is on this page.
  const allGamesShown = !!data && page === 1 && gamesTotal <= data.games.length;
  const plays = data?.games.reduce((s, g) => s + g.plays, 0) ?? 0;
  const followState = data
    ? (follows?.get(data.user.username, { following: !!data.isFollowing, followers: data.followers }) ?? { following: !!data.isFollowing, followers: data.followers })
    : null;
  const followers = followState?.followers ?? data?.followers ?? 0;
  const profilePath = data ? `/u/${encodeURIComponent(data.user.username)}` : "";

  return (
    <div className="pf-container pf-page">
      <section className="pf-profile">
        {loading || !data ? (
          <>
            <Skeleton width={96} height={96} radius={48} />
            <div className="pf-profile__info">
              <Skeleton width={200} height={28} />
              <Skeleton width={120} height={16} />
              <Skeleton width="80%" height={16} />
            </div>
          </>
        ) : (
          <>
            <Avatar user={data.user} size={96} />
            <div className="pf-profile__info">
              <h1>{data.user.displayName || data.user.username}</h1>
              <p className="pf-muted">
                @{data.user.username} · joined {formatDate(data.user.createdAt)}
              </p>
              {data.user.bio ? <p className="pf-profile__bio">{data.user.bio}</p> : isMe ? <p className="pf-muted">You haven't written a bio yet.</p> : null}
              <div className="pf-profile__stats">
                <span>
                  <strong>{formatCount(gamesTotal)}</strong> {gamesTotal === 1 ? "game" : "games"}
                </span>
                {allGamesShown && (
                  <span>
                    <strong>{formatCount(plays)}</strong> plays
                  </span>
                )}
                {typeof data.followers === "number" && (
                  <Link to={`${profilePath}/followers`} className="pf-profile__stat-link">
                    <strong>{formatCount(followers)}</strong> {followers === 1 ? "follower" : "followers"}
                  </Link>
                )}
                {typeof data.following === "number" && (
                  <Link to={`${profilePath}/following`} className="pf-profile__stat-link">
                    <strong>{formatCount(data.following)}</strong> following
                  </Link>
                )}
              </div>
            </div>
            {isMe ? (
              <Link to="/settings" className="pf-btn pf-btn--ghost pf-profile__edit">
                Edit profile
              </Link>
            ) : (
              <div className="pf-profile__edit">
                <FollowButton
                  username={data.user.username}
                  displayName={data.user.displayName}
                  isFollowing={!!data.isFollowing}
                  followers={data.followers}
                />
              </div>
            )}
          </>
        )}
      </section>

      {data && <RecentAchievements username={data.user.username} />}

      <h2 className="pf-section-title">Games</h2>
      {data && data.games.length === 0 ? (
        <EmptyState
          icon="🎮"
          title={isMe ? "No games yet" : "Nothing here yet"}
          action={
            isMe && (
              <Link to="/upload" className="pf-btn pf-btn--primary">
                Upload a game
              </Link>
            )
          }
        >
          {isMe ? "Your uploaded games will appear here." : "This player hasn't published any games."}
        </EmptyState>
      ) : (
        <GameGrid games={data?.games} loading={loading || !data} skeletons={4} showStatus={isMe} />
      )}
      {data && gamesTotal > data.games.length && (
        <Pagination
          page={page}
          total={gamesTotal}
          perPage={GAMES_PER_PAGE}
          onPage={(p) => {
            const next = new URLSearchParams(params);
            if (p === 1) next.delete("page");
            else next.set("page", String(p));
            setParams(next);
          }}
        />
      )}
    </div>
  );
}
