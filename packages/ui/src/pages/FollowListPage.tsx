import { Link, useParams, useSearchParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { useApi } from "../context/config";
import { EmptyState, ErrorState, Pagination, Skeleton, UserLink } from "../components/common";
import { useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";

const PER_PAGE = 24;

export type FollowListMode = "followers" | "following";

/** `/u/:username/followers` and `/u/:username/following`: a paged list of users, newest follow first. */
export function FollowListPage({ mode }: { mode: FollowListMode }) {
  const { username = "" } = useParams();
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const list = useAsync(
    () => (mode === "followers" ? api.listFollowers(username, { page, perPage: PER_PAGE }) : api.listFollowing(username, { page, perPage: PER_PAGE })),
    [api, username, mode, page],
  );
  // Only for the display name in the title; the list works without it.
  const profile = useAsync(() => api.getUser(username, { perPage: 1 }), [api, username]);
  const name = profile.data ? profile.data.user.displayName || profile.data.user.username : username;
  const title = mode === "followers" ? `People following ${name}` : `${name} follows`;
  useDocumentTitle(title);

  if (list.error && isApiError(list.error) && list.error.status === 404) return <NotFoundPage what="player" />;

  const profilePath = `/u/${encodeURIComponent(profile.data?.user.username ?? username)}`;

  return (
    <div className="pf-container pf-page">
      <header className="pf-pagehead">
        <p className="pf-small">
          <Link to={profilePath}>‹ Back to profile</Link>
        </p>
        <h1>{title}</h1>
        <nav className="pf-tabs" aria-label="Follow lists">
          <Link to={`${profilePath}/followers`} className={`pf-tab${mode === "followers" ? " is-active" : ""}`} aria-current={mode === "followers" ? "page" : undefined}>
            Followers
          </Link>
          <Link to={`${profilePath}/following`} className={`pf-tab${mode === "following" ? " is-active" : ""}`} aria-current={mode === "following" ? "page" : undefined}>
            Following
          </Link>
        </nav>
      </header>
      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading || !list.data ? (
        <ul className="pf-userlist" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="pf-userlist__row" aria-hidden="true">
              <Skeleton width={36} height={36} radius={18} />
              <Skeleton width={160} height={16} />
            </li>
          ))}
        </ul>
      ) : list.data.items.length === 0 ? (
        <EmptyState icon="👥" title={mode === "followers" ? "No followers yet." : "Not following anyone yet."} />
      ) : (
        <ul className="pf-userlist">
          {list.data.items.map((u) => (
            <li key={u.id} className="pf-userlist__row">
              <UserLink user={u} size={36} />
              <span className="pf-muted pf-small">@{u.username}</span>
            </li>
          ))}
        </ul>
      )}
      {list.data && !list.error && (
        <Pagination
          page={page}
          total={list.data.total}
          perPage={list.data.perPage || PER_PAGE}
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
