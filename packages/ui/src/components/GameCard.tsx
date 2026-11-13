import { Link } from "react-router-dom";
import type { GameSummary } from "../api/types";
import { formatCount } from "../util";
import { FavoriteButton } from "./Favorite";
import { Avatar, Skeleton, StarsDisplay, Thumbnail } from "./common";

export function GameCard({ game, showStatus }: { game: GameSummary; showStatus?: boolean }) {
  return (
    <article className="pf-card">
      <Link to={`/games/${game.id}`} className="pf-card__link" aria-label={`Play ${game.title}`}>
        <Thumbnail src={game.thumbnailUrl} seed={game.id} alt="" />
        <span className="pf-card__play" aria-hidden="true">
          ▶
        </span>
        {showStatus && !game.published && <span className="pf-badge pf-badge--draft pf-card__badge">Draft</span>}
      </Link>
      <div className="pf-card__body">
        <h3 className="pf-card__title">
          <Link to={`/games/${game.id}`}>{game.title}</Link>
        </h3>
        <Link to={`/u/${encodeURIComponent(game.owner.username)}`} className="pf-card__owner">
          <Avatar user={game.owner} size={18} />
          <span>{game.owner.displayName || game.owner.username}</span>
        </Link>
        <div className="pf-card__meta">
          <span title={`${game.plays} plays`}>▶ {formatCount(game.plays)}</span>
          {game.ratingCount > 0 ? <StarsDisplay value={game.ratingAvg} count={game.ratingCount} /> : <span className="pf-muted">Not rated</span>}
          <FavoriteButton gameId={game.id} gameTitle={game.title} favorites={game.favorites ?? 0} />
        </div>
      </div>
    </article>
  );
}

export function GameCardSkeleton() {
  return (
    <div className="pf-card pf-card--skeleton" aria-hidden="true">
      <Skeleton className="pf-thumb" height="auto" />
      <div className="pf-card__body">
        <Skeleton width="70%" height={18} />
        <Skeleton width="40%" height={14} />
        <Skeleton width="55%" height={12} />
      </div>
    </div>
  );
}

export function GameGrid({ games, loading, skeletons = 8, showStatus }: { games?: GameSummary[]; loading?: boolean; skeletons?: number; showStatus?: boolean }) {
  return (
    <div className="pf-grid" aria-busy={loading || undefined}>
      {loading
        ? Array.from({ length: skeletons }, (_, i) => <GameCardSkeleton key={i} />)
        : games?.map((g) => <GameCard key={g.id} game={g} showStatus={showStatus} />)}
    </div>
  );
}
