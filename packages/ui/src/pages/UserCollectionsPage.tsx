import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { CollectionGrid } from "../components/CollectionCard";
import { isCollectionsUnsupportedError } from "../components/collectionsSupport";
import { EmptyState, ErrorState, Pagination } from "../components/common";
import { NewCollectionButton } from "../components/ProfileCollections";
import { useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";
import { useProfileOutlet } from "./ProfilePage";

export const USER_COLLECTIONS_PER_PAGE = 24;

/**
 * `/u/:username/collections`: all of a user's collections visible to the viewer, paged by `?page=`. Since F028 it
 * renders inside the profile shell (which shows whose collections these are).
 */
export function UserCollectionsPage() {
  const { username = "" } = useParams();
  const api = useApi();
  const { user: me } = useAuth();
  const shell = useProfileOutlet();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const isMe = shell ? shell.isMe : !!me && me.username.toLowerCase() === username.toLowerCase();
  const { data, loading, error, reload } = useAsync(
    () => api.listUserCollections(username, { page, perPage: USER_COLLECTIONS_PER_PAGE }),
    [api, username.toLowerCase(), page, me?.id],
  );
  const shellUser = shell?.profile.user;
  const ownerName = shellUser
    ? shellUser.displayName || shellUser.username
    : data?.items?.[0]?.owner
      ? data.items[0].owner.displayName || data.items[0].owner.username
      : isMe && me
        ? me.displayName || me.username
        : username;
  useDocumentTitle(`Collections · ${ownerName}`);

  if (error && isCollectionsUnsupportedError(error))
    return (
      <section className="pf-profile-section">
        <EmptyState icon="📚" title="Collections aren't available here yet">
          This server doesn't support collections.
        </EmptyState>
      </section>
    );
  if (error && isApiError(error) && error.status === 404) return <NotFoundPage what="player" />;

  return (
    <section className="pf-profile-section">
      <header className="pf-pagehead pf-pagehead--row">
        <div>
          <h2 className="pf-section-title">Collections</h2>
          {isMe && <p className="pf-muted">Public collections appear on your profile and on game pages; private ones only here.</p>}
        </div>
        {isMe && data && data.items.length > 0 && <NewCollectionButton className="pf-btn pf-btn--primary" />}
      </header>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data && !loading && data.items.length === 0 ? (
        isMe ? (
          <EmptyState icon="📚" title="No collections yet" action={<NewCollectionButton className="pf-btn pf-btn--primary" />}>
            Group games into lists to share or to play later.
          </EmptyState>
        ) : (
          <EmptyState icon="📚" title="No public collections yet" />
        )
      ) : (
        <CollectionGrid collections={data?.items} loading={loading || !data} skeletons={6} showOwner={false} />
      )}
      {data && !error && (
        <Pagination
          page={page}
          total={data.total}
          perPage={data.perPage || USER_COLLECTIONS_PER_PAGE}
          onPage={(p) => {
            const next = new URLSearchParams(params);
            if (p === 1) next.delete("page");
            else next.set("page", String(p));
            setParams(next);
          }}
        />
      )}
    </section>
  );
}

/** `/collections` (inside RequireAuth): the signed-in user's list. */
export function MyCollectionsRedirect() {
  const { user } = useAuth();
  if (!user) return null;
  return <Navigate to={`/u/${encodeURIComponent(user.username)}/collections`} replace />;
}
