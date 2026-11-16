import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { collectionPath } from "../collections";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { useAsync } from "../util";
import { CollectionGrid } from "./CollectionCard";
import { CollectionFormDialog } from "./CollectionFormDialog";
import { isCollectionsUnsupportedError, noteCollectionsError, useCollectionsSupported } from "./collectionsSupport";
import { EmptyState, LoadError } from "./common";

export const PROFILE_COLLECTIONS_LIMIT = 6;

/** "New collection" button + create dialog; navigates to the new `/c/{id}`. */
export function NewCollectionButton({ className = "pf-btn pf-btn--ghost pf-btn--sm" }: { className?: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span aria-hidden="true">+</span> New collection
      </button>
      <CollectionFormDialog
        open={open}
        onClose={() => setOpen(false)}
        onSaved={(c) => {
          setOpen(false);
          toast.success("Collection created", c.title);
          navigate(collectionPath(c));
        }}
      />
    </>
  );
}

export type ProfileCollectionsProps = { username: string; isMe: boolean };

/**
 * F008 Collections section of a profile: up to 6 cards and "See all". Your own profile always shows it (with an
 * empty state); other profiles hide it when there is nothing to show, and on servers without collections.
 */
export function ProfileCollections({ username, isMe }: ProfileCollectionsProps) {
  const api = useApi();
  const supported = useCollectionsSupported();
  const titleId = useId();
  const { data, loading, error, reload } = useAsync(
    () => api.listUserCollections(username, { perPage: PROFILE_COLLECTIONS_LIMIT }).then((page) => ({ username, page })),
    [api, username, isMe],
  );
  useEffect(() => {
    if (error) noteCollectionsError(api, error);
  }, [api, error]);

  if (!supported || (error && isCollectionsUnsupportedError(error))) return null;
  const page = data && data.username === username && !loading ? data.page : undefined;
  const items = Array.isArray(page?.items) ? page.items.slice(0, PROFILE_COLLECTIONS_LIMIT) : [];
  const total = typeof page?.total === "number" ? page.total : items.length;
  // Other people's profiles: nothing at all until there is something to show.
  if (!isMe && (error || !page || items.length === 0)) return null;
  const allPath = `/u/${encodeURIComponent(username)}/collections`;

  return (
    <section className="pf-shelf pf-profile-collections" aria-labelledby={titleId}>
      <div className="pf-shelf__head">
        <h2 id={titleId} className="pf-section-title">
          Collections
        </h2>
        <div className="pf-row">
          {total > PROFILE_COLLECTIONS_LIMIT && (
            <Link to={allPath} className="pf-shelf__more">
              See all {total} collections →
            </Link>
          )}
          {isMe && items.length > 0 && <NewCollectionButton />}
        </div>
      </div>
      {error ? (
        <LoadError message="Couldn't load your collections." onRetry={reload} />
      ) : !page ? (
        <CollectionGrid loading skeletons={3} />
      ) : items.length === 0 ? (
        <EmptyState icon="📚" title="No collections yet" action={<NewCollectionButton className="pf-btn pf-btn--primary" />}>
          Group games into lists to share or to play later.
        </EmptyState>
      ) : (
        <CollectionGrid collections={items} showOwner={false} />
      )}
    </section>
  );
}
