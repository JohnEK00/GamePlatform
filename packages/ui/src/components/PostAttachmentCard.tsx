import { Link } from "react-router-dom";
import type { PostAttachment } from "../api/types";
import { collectionPath, gamesLabel } from "../collections";
import { CollectionCover } from "./CollectionCard";
import { Thumbnail } from "./common";

const ownerName = (o: { username?: string; displayName?: string } | null | undefined) => (o ? o.displayName || o.username || "" : "");

/**
 * F030 § 0.13 item 3: a post's attachment. A visible game or collection is a card link; a target the viewer can't
 * see (deleted, unpublished, made private) is a muted placeholder; an unknown type renders nothing.
 */
export function PostAttachmentCard({ attachment }: { attachment: PostAttachment | null | undefined }) {
  if (!attachment || typeof attachment !== "object") return null;
  if (attachment.type === "game") {
    const g = attachment.game;
    if (!g || typeof g.id !== "string") {
      return <p className="pf-post-attachment pf-post-attachment--gone pf-muted pf-small">This game is no longer available.</p>;
    }
    const owner = ownerName(g.owner);
    return (
      <Link className="pf-post-attachment" to={`/games/${encodeURIComponent(g.id)}`}>
        <span className="pf-post-attachment__media">
          <Thumbnail src={g.thumbnailUrl} seed={g.id} alt="" />
        </span>
        <span className="pf-post-attachment__info">
          <strong>{g.title}</strong>
          {owner && <span className="pf-muted pf-small">by {owner}</span>}
        </span>
      </Link>
    );
  }
  if (attachment.type === "collection") {
    const c = attachment.collection;
    if (!c || typeof c.id !== "string") {
      return <p className="pf-post-attachment pf-post-attachment--gone pf-muted pf-small">This collection is no longer available.</p>;
    }
    const owner = ownerName(c.owner);
    const n = Math.max(0, Math.floor(Number(c.gameCount) || 0));
    return (
      <Link className="pf-post-attachment" to={collectionPath(c)}>
        <span className="pf-post-attachment__media">
          <CollectionCover coverUrls={c.coverUrls} />
        </span>
        <span className="pf-post-attachment__info">
          <strong>{c.title}</strong>
          <span className="pf-muted pf-small">
            {gamesLabel(n)}
            {owner ? ` · by ${owner}` : ""}
          </span>
        </span>
      </Link>
    );
  }
  return null;
}
