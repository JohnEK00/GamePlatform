import { Link } from "react-router-dom";
import type { GameSummary } from "../api/types";
import { formatCount, isRecentlyUpdated, timeAgo } from "../util";
import { FavoriteButton } from "./Favorite";
import { Avatar, Skeleton, StarsDisplay, Thumbnail } from "./common";

/** F003: optional emphasis for discovery shelves. */
export type GameCardHighlight = "trending" | "related";

export type GameCardProps = {
  game: GameSummary;
  showStatus?: boolean;
  /** "trending": weekly plays replace the all-time count; "related": shows shared tags. */
  highlight?: GameCardHighlight;
  /** With highlight="related": the tags shared with the source game (up to 2 are shown). */
  sharedTags?: string[];
};

export function GameCard({ game, showStatus, highlight, sharedTags }: GameCardProps) {
  // Older servers don't send playsWeek: treat it as 0.
  const playsWeek = typeof game.playsWeek === "number" && game.playsWeek > 0 ? game.playsWeek : 0;
  const showTrending = highlight === "trending" && playsWeek > 0;
  const shown = highlight === "related" && sharedTags ? sharedTags.slice(0, 2) : [];
  // F004: "Draft" wins over "Updated"; older servers omit lastUpdatedAt (no badge).
  const showDraft = !!showStatus && !game.published;
  const showUpdated = !showDraft && isRecentlyUpdated(game);
  return (
    <article className="pf-card">
      <Link to={`/games/${game.id}`} className="pf-card__link" aria-label={`Play ${game.title}`}>
        <Thumbnail src={game.thumbnailUrl} seed={game.id} alt="" />
        <span className="pf-card__play" aria-hidden="true">
          ▶
        </span>
        {showDraft && <span className="pf-badge pf-badge--draft pf-card__badge">Draft</span>}
        {showUpdated && (
          <span className="pf-badge pf-badge--updated pf-card__badge" title={`Updated ${timeAgo(game.lastUpdatedAt as string)}`}>
            Updated
          </span>
        )}
      </Link>
      <div className="pf-card__body">
        <h3 className="pf-card__title">
          <Link to={`/games/${game.id}`}>{game.title}</Link>
        </h3>
        <Link to={`/u/${encodeURIComponent(game.owner.username)}`} className="pf-card__owner">
          <Avatar user={game.owner} size={18} />
          <span>{game.owner.displayName || game.owner.username}</span>
        </Link>
        {shown.length > 0 && (
          <p className="pf-card__shared" title={`Shares ${shown.map((t) => `#${t}`).join(", ")}`}>
            {shown.map((t) => `#${t}`).join(" ")}
          </p>
        )}
        <div className="pf-card__meta">
          {showTrending ? (
            <span className="pf-card__trending" title={`${playsWeek} plays in the last 7 days`}>
              🔥 {formatCount(playsWeek)} this week
            </span>
          ) : (
            <span title={`${game.plays} plays`}>▶ {formatCount(game.plays)}</span>
          )}
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

export function GameGrid({
  games,
  loading,
  skeletons = 8,
  showStatus,
  highlight,
  sharedTagsById,
}: {
  games?: GameSummary[];
  loading?: boolean;
  skeletons?: number;
  showStatus?: boolean;
  highlight?: GameCardHighlight;
  sharedTagsById?: Record<string, string[]>;
}) {
  return (
    <div className="pf-grid" aria-busy={loading || undefined}>
      {loading
        ? Array.from({ length: skeletons }, (_, i) => <GameCardSkeleton key={i} />)
        : games?.map((g) => (
            <GameCard key={g.id} game={g} showStatus={showStatus} highlight={highlight} sharedTags={sharedTagsById?.[g.id]} />
          ))}
    </div>
  );
}
