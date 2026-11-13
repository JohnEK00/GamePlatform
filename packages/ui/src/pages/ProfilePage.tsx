import { Link, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { Avatar, EmptyState, ErrorState, Skeleton } from "../components/common";
import { GameGrid } from "../components/GameCard";
import { RecentAchievements } from "../components/Achievements";
import { formatCount, formatDate, useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";

export function ProfilePage() {
  const { username = "" } = useParams();
  const api = useApi();
  const { user: me } = useAuth();
  const { data, loading, error, reload } = useAsync(() => api.getUser(username), [api, username, me?.id]);
  useDocumentTitle(data ? data.user.displayName || data.user.username : undefined);

  if (error && isApiError(error) && error.status === 404) return <NotFoundPage what="player" />;
  if (error)
    return (
      <div className="pf-container pf-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );

  const isMe = !!data && !!me && me.id === data.user.id;
  const plays = data?.games.reduce((s, g) => s + g.plays, 0) ?? 0;

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
                  <strong>{data.games.length}</strong> games
                </span>
                <span>
                  <strong>{formatCount(plays)}</strong> plays
                </span>
              </div>
            </div>
            {isMe && (
              <Link to="/settings" className="pf-btn pf-btn--ghost pf-profile__edit">
                Edit profile
              </Link>
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
    </div>
  );
}
