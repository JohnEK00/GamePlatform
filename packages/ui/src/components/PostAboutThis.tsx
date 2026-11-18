import { Link } from "react-router-dom";
import { useAuth } from "../context/auth";
import { postComposePath, type PostAttachRef } from "../posts";

/**
 * F030 § 0.12: "✎ Post about this" (signed in only): opens your own Posts section with the composer's attachment
 * prefilled through `?attach=`.
 */
export function PostAboutThisLink({ attach }: { attach: PostAttachRef }) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <Link className="pf-btn pf-btn--ghost pf-btn--sm" to={postComposePath(user.username, attach)}>
      ✎ Post about this
    </Link>
  );
}
