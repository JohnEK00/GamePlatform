import { Link } from "react-router-dom";
import type { CollectionSummary } from "../api/types";
import { collectionPath, gamesLabel } from "../collections";
import { useResolveUrl } from "../context/config";
import { Skeleton } from "./common";

/** "🔒 Private" badge (the emoji is decorative; "Private" is visible text). */
export function PrivateBadge() {
  return (
    <span className="pf-badge pf-badge--private">
      <span aria-hidden="true">🔒</span> Private
    </span>
  );
}

function CoverTile({ src }: { src: string | undefined }) {
  const resolve = useResolveUrl();
  const url = resolve(src);
  return (
    <span className="pf-collection-cover__tile">
      {url && (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
}

/** Decorative 2×2 cover of the first thumbnails; a single 📚 placeholder when there are none. */
export function CollectionCover({ coverUrls }: { coverUrls: string[] }) {
  const urls = Array.isArray(coverUrls) ? coverUrls.slice(0, 4) : [];
  if (urls.length === 0)
    return (
      <div className="pf-collection-cover pf-collection-cover--empty" aria-hidden="true">
        <span className="pf-collection-cover__glyph">📚</span>
      </div>
    );
  return (
    <div className="pf-collection-cover" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <CoverTile key={i} src={urls[i]} />
      ))}
    </div>
  );
}

export type CollectionCardProps = {
  collection: CollectionSummary;
  /** Show "by {displayName}" (omit on a profile's own list). Default true. */
  showOwner?: boolean;
};

/** One link per card (the title, stretched over the card); the cover is decorative. */
export function CollectionCard({ collection: c, showOwner = true }: CollectionCardProps) {
  return (
    <article className="pf-card pf-collection-card">
      <CollectionCover coverUrls={c.coverUrls} />
      <div className="pf-card__body">
        <h3 className="pf-card__title pf-collection-card__title">
          <Link to={collectionPath(c)} className="pf-collection-card__link">
            {c.title}
          </Link>
        </h3>
        {showOwner && <p className="pf-collection-card__owner">by {c.owner.displayName || c.owner.username}</p>}
        <p className="pf-collection-card__meta">
          <span>{gamesLabel(c.gameCount)}</span>
          {c.visibility === "private" && <PrivateBadge />}
        </p>
      </div>
    </article>
  );
}

export function CollectionCardSkeleton() {
  return (
    <div className="pf-card pf-card--skeleton pf-collection-card" aria-hidden="true">
      <Skeleton className="pf-collection-cover" height="auto" radius={0} />
      <div className="pf-card__body">
        <Skeleton width="70%" height={18} />
        <Skeleton width="40%" height={14} />
      </div>
    </div>
  );
}

export type CollectionGridProps = {
  collections?: CollectionSummary[];
  loading?: boolean;
  skeletons?: number;
  showOwner?: boolean;
};

export function CollectionGrid({ collections, loading, skeletons = 3, showOwner = true }: CollectionGridProps) {
  return (
    <div className="pf-grid pf-collection-grid" aria-busy={loading || undefined}>
      {loading
        ? Array.from({ length: skeletons }, (_, i) => <CollectionCardSkeleton key={i} />)
        : collections?.map((c) => <CollectionCard key={c.id} collection={c} showOwner={showOwner} />)}
    </div>
  );
}
