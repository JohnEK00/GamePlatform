import { Link, useNavigate, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Post } from "../api/types";
import { useApi, useConfig } from "../context/config";
import { ErrorState } from "../components/common";
import { CopyLinkButton } from "../components/CopyLinkButton";
import { PostCard, PostCardSkeleton } from "../components/PostCard";
import { profilePath } from "../profile";
import { postShareUrl } from "../share";
import { useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";
import type { PostsLocationState } from "./ProfileSections";

/** F030 § 0.15: `/p/:id`, the permalink of one post (public). */
export function PostPage() {
  const { id = "" } = useParams();
  const api = useApi();
  const config = useConfig();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync<Post>(() => api.getPost(id), [api, id]);
  const post = data && data.id === id ? data : undefined;
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
      <PostCard post={post} onDeleted={onDeleted} />
      <div className="pf-post-page__actions">
        <CopyLinkButton url={postShareUrl(config, post.id)} />
        <Link to={postsPath} className="pf-small">
          More posts by {name} →
        </Link>
      </div>
    </div>
  );
}
