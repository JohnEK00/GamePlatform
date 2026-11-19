import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Post } from "../api/types";
import { useApi, useConfig } from "../context/config";
import { ErrorState } from "../components/common";
import { CopyLinkButton } from "../components/CopyLinkButton";
import { PostCard, PostCardSkeleton } from "../components/PostCard";
import { PostThread } from "../components/PostThread";
import { profilePath } from "../profile";
import { postShareUrl } from "../share";
import { useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";
import type { PostsLocationState } from "./ProfileSections";

/**
 * F030 § 0.15: `/p/:id`, the permalink of one post (public). F031 § 0.16: the reply thread below it, with
 * `?reply={replyId}` deep links. The page keeps a local copy of the post that the thread updates (lock, replyCount).
 */
export function PostPage() {
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  const replyId = searchParams.get("reply") || null;
  const api = useApi();
  const config = useConfig();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync<Post>(() => api.getPost(id), [api, id]);
  // Local post state, initialised from (and reset by) each fetch.
  const [local, setLocal] = useState<{ from: Post; post: Post } | null>(null);
  const fetched = data && data.id === id ? data : undefined;
  if (fetched && local?.from !== fetched) setLocal({ from: fetched, post: fetched });
  const post = fetched ? (local?.from === fetched ? local.post : fetched) : undefined;
  const name = post ? post.author.displayName || post.author.username : "";
  useDocumentTitle(post ? `Post by ${name}` : undefined);

  if (error && isApiError(error) && error.status === 404) return <NotFoundPage what="post" />;
  if (error)
    return (
      <div className="pf-container pf-page pf-post-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  if (!post || loading)
    return (
      <div className="pf-container pf-page pf-post-page" aria-busy="true">
        <PostCardSkeleton />
      </div>
    );

  const postsPath = profilePath(post.author.username, "posts");
  const onDeleted = () => {
    const state: PostsLocationState = { focusPostsHeading: true };
    navigate(postsPath, { replace: true, state });
  };

  return (
    <div className="pf-container pf-page pf-post-page">
      <h1 className="pf-sr-only">Post by {name}</h1>
      <PostCard post={post} onDeleted={onDeleted} inThread />
      <div className="pf-post-page__actions">
        <CopyLinkButton url={postShareUrl(config, post.id)} />
        <Link to={postsPath} className="pf-small">
          More posts by {name} →
        </Link>
      </div>
      {typeof post.replyCount === "number" && (
        <PostThread post={post} replyId={replyId} onPostChange={(next) => setLocal((l) => (l && l.post.id === next.id ? { ...l, post: next } : l))} />
      )}
    </div>
  );
}
