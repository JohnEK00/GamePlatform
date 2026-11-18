import { useCallback, useEffect, useRef } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import type { Post } from "../api/types";
import { useApi } from "../context/config";
import { RecentAchievements } from "../components/Achievements";
import { EmptyState, ErrorState, Pagination } from "../components/common";
import { GameGrid } from "../components/GameCard";
import { PostComposer } from "../components/PostComposer";
import { ProfileCollections } from "../components/ProfileCollections";
import { ProfilePosts, type ProfilePostsHandle } from "../components/ProfilePosts";
import { ProfileScreenshots } from "../components/ProfileScreenshots";
import { parseAttachParam, PROFILE_POSTS_PREVIEW } from "../posts";
import { PROFILE_GAMES_PER_PAGE, PROFILE_OVERVIEW_GAMES, PROFILE_SCREENSHOTS_PREVIEW, profilePath } from "../profile";
import { useAsync, useDocumentTitle } from "../util";
import { useProfileOutlet } from "./ProfilePage";

function OwnNoGames() {
  return (
    <EmptyState
      icon="🎮"
      title="No games yet"
      action={
        <Link to="/upload" className="pf-btn pf-btn--primary">
          Upload a game
        </Link>
      }
    >
      Your uploaded games will appear here.
    </EmptyState>
  );
}

/** `/u/:username` (index): achievements, the latest games, a screenshots shelf and collections. */
export function ProfileOverview() {
  const ctx = useProfileOutlet();
  const user = ctx?.profile.user;
  const name = user ? user.displayName || user.username : "";
  useDocumentTitle(user ? `${name} (@${user.username})` : undefined);
  if (!ctx || !user) return null;

  const { profile, isMe } = ctx;
  const games = Array.isArray(profile.games) ? profile.games : [];
  const gamesTotal = typeof profile.gamesTotal === "number" ? profile.gamesTotal : games.length;
  const stats = profile.stats;
  const username = user.username;

  if (
    !isMe &&
    stats &&
    gamesTotal === 0 &&
    stats.achievements === 0 &&
    stats.screenshots === 0 &&
    stats.collections === 0 &&
    (stats.posts ?? 0) === 0
  ) {
    return (
      <section className="pf-profile-section">
        <EmptyState icon="🕹" title="Nothing here yet">
          {name} hasn't shared anything yet.
        </EmptyState>
      </section>
    );
  }

  return (
    <div className="pf-profile-section">
      <RecentAchievements username={username} />

      {/* F030: hidden on servers without posts (no stats.posts). */}
      {typeof stats?.posts === "number" && (
        <ProfilePosts key={`posts:${username}`} username={username} isMe={isMe} preview={PROFILE_POSTS_PREVIEW} />
      )}

      {games.length > 0 ? (
        <section className="pf-shelf pf-profile-games">
          <div className="pf-shelf__head">
            <h2 className="pf-section-title">Games</h2>
            {gamesTotal > PROFILE_OVERVIEW_GAMES && (
              <Link className="pf-shelf__more" to={profilePath(username, "games")}>
                See all {gamesTotal} games →
              </Link>
            )}
          </div>
          <GameGrid games={games.slice(0, PROFILE_OVERVIEW_GAMES)} showStatus={isMe} />
        </section>
      ) : isMe ? (
        <section className="pf-shelf pf-profile-games">
          <h2 className="pf-section-title">Games</h2>
          <OwnNoGames />
        </section>
      ) : null}

      {/* Keyed per user (fresh state on navigation); prefixed so it can't clash with ProfileCollections' key. */}
      <ProfileScreenshots key={`shots:${username}`} username={username} isMe={isMe} preview={PROFILE_SCREENSHOTS_PREVIEW} />

      <ProfileCollections key={username} username={username} isMe={isMe} />
    </div>
  );
}

/** `/u/:username/games?page=n`: every game of the user, newest first, 24 per page. */
export function ProfileGamesTab() {
  const ctx = useProfileOutlet();
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const user = ctx?.profile.user;
  const isMe = !!ctx?.isMe;
  const username = user?.username ?? "";
  const name = user ? user.displayName || user.username : "";
  useDocumentTitle(user ? `Games · ${name}` : undefined);
  const { data, loading, error, reload } = useAsync(
    () =>
      username
        ? api.listGames({ owner: isMe ? "me" : username, sort: "new", page, perPage: PROFILE_GAMES_PER_PAGE })
        : Promise.resolve(null),
    [api, username, isMe, page],
  );
  if (!ctx) return null;

  return (
    <section className="pf-profile-section">
      <h2 className="pf-section-title">Games</h2>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data && !loading && data.items.length === 0 ? (
        isMe ? (
          <OwnNoGames />
        ) : (
          <EmptyState icon="🎮" title="Nothing here yet">
            This player hasn't published any games.
          </EmptyState>
        )
      ) : (
        <GameGrid games={data?.items} loading={loading || !data} skeletons={PROFILE_GAMES_PER_PAGE} showStatus={isMe} />
      )}
      {data && !error && (
        <Pagination
          page={page}
          total={data.total}
          perPage={data.perPage || PROFILE_GAMES_PER_PAGE}
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

/** Router state that asks the Posts section to focus its heading on mount (after a delete on the permalink page). */
export type PostsLocationState = { focusPostsHeading?: boolean };

/**
 * F030 `/u/:username/posts`: the heading, the composer (own profile; `?attach=` prefills its attachment) and the
 * user's posts, 20 per page with "Load more".
 */
export function ProfilePostsTab() {
  const ctx = useProfileOutlet();
  const location = useLocation();
  const [params] = useSearchParams();
  const user = ctx?.profile.user;
  const name = user ? user.displayName || user.username : "";
  useDocumentTitle(user ? `Posts · ${name}` : undefined);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<ProfilePostsHandle>(null);
  const focusHeading = !!(location.state as PostsLocationState | null)?.focusPostsHeading;
  const reload = ctx?.reload;

  useEffect(() => {
    if (focusHeading) headingRef.current?.focus();
    // Mount only (the state stays on the history entry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusFallback = useCallback(() => textareaRef.current ?? headingRef.current, []);
  const onPosted = useCallback(
    (post: Post) => {
      listRef.current?.prepend(post);
      reload?.();
    },
    [reload],
  );

  if (!ctx || !user) return null;
  const { profile, isMe } = ctx;
  const attach = isMe ? parseAttachParam(params.get("attach")) : null;

  return (
    <section className="pf-profile-section pf-profile-posts-section">
      <h2 className="pf-section-title" tabIndex={-1} ref={headingRef}>
        Posts
      </h2>
      {isMe && <PostComposer onPosted={onPosted} initialAttach={attach} textareaRef={textareaRef} />}
      {!isMe && profile.stats?.posts === 0 ? (
        <EmptyState icon="✎" title="No posts yet">
          {name} hasn't posted anything yet.
        </EmptyState>
      ) : (
        <ProfilePosts
          key={`posts:${user.username}`}
          ref={listRef}
          username={user.username}
          isMe={isMe}
          onChanged={reload}
          focusFallback={focusFallback}
        />
      )}
    </section>
  );
}

/** `/u/:username/screenshots`: the full F015 gallery. */
export function ProfileScreenshotsTab() {
  const ctx = useProfileOutlet();
  const user = ctx?.profile.user;
  const name = user ? user.displayName || user.username : "";
  useDocumentTitle(user ? `Screenshots · ${name}` : undefined);
  if (!ctx || !user) return null;
  const { profile, isMe } = ctx;

  return (
    <section className="pf-profile-section">
      {!isMe && profile.stats?.screenshots === 0 ? (
        <EmptyState icon="📷" title="No screenshots yet">
          {name} hasn't posted any screenshots.
        </EmptyState>
      ) : (
        <ProfileScreenshots key={`shots:${user.username}`} username={user.username} isMe={isMe} />
      )}
    </section>
  );
}
