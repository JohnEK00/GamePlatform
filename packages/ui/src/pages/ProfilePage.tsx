import { useEffect, useRef } from "react";
import { Navigate, NavLink, Outlet, useLocation, useMatch, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { UserProfileResponse } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { ErrorState } from "../components/common";
import { useCollectionsSupported } from "../components/collectionsSupport";
import { ProfileHeader, ProfileHeaderSkeleton } from "../components/ProfileHeader";
import { profilePath } from "../profile";
import { formatCount, useAsync } from "../util";
import { NotFoundPage } from "./NotFoundPage";

/** What the profile shell passes to its sections (`useProfileOutlet()`). */
export type ProfileOutletContext = {
  profile: UserProfileResponse;
  /** The viewer is this user. */
  isMe: boolean;
  /** Refetches the profile (header and counts). */
  reload: () => void;
};

/** The profile shell's context, or null when rendered outside the shell (e.g. a standalone test route). */
export function useProfileOutlet(): ProfileOutletContext | null {
  const ctx = useOutletContext<ProfileOutletContext | undefined>();
  return ctx && typeof ctx === "object" && "profile" in ctx ? ctx : null;
}

/** `?page=n` on the bare profile URL (the pre-F028 games pager): n ≥ 2, else null. */
function legacyPage(search: string): number | null {
  const raw = new URLSearchParams(search).get("page");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 2 ? n : null;
}

function Count({ n }: { n: number | undefined }) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return (
    <>
      {" "}
      <span className="pf-profile-tabs__count">{formatCount(n)}</span>
    </>
  );
}

const tabClass = ({ isActive }: { isActive: boolean }) => `pf-tab pf-profile-tabs__link${isActive ? " is-active" : ""}`;

/** F028 section strip: links (not ARIA tabs), one per section URL; React Router marks the current one. */
function ProfileTabs({ profile }: { profile: UserProfileResponse }) {
  const collections = useCollectionsSupported();
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);
  const base = profilePath(profile.user.username);
  const stats = profile.stats;

  // Keep the active link visible when the strip scrolls horizontally (narrow screens).
  useEffect(() => {
    const nav = ref.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [location.pathname]);

  return (
    <nav className="pf-profile-tabs" aria-label="Profile sections" ref={ref}>
      <NavLink to={base} end className={tabClass}>
        Overview
      </NavLink>
      <NavLink to={`${base}/games`} className={tabClass}>
        Games
        <Count n={profile.gamesTotal} />
      </NavLink>
      <NavLink to={`${base}/screenshots`} className={tabClass}>
        Screenshots
        <Count n={stats?.screenshots} />
      </NavLink>
      {collections && (
        <NavLink to={`${base}/collections`} className={tabClass}>
          Collections
          <Count n={stats?.collections} />
        </NavLink>
      )}
    </nav>
  );
}

/**
 * F028 profile shell (`/u/:username` layout route): loads the profile once per (username, viewer), renders the header
 * and the section strip, and the active section through `<Outlet context={{ profile, isMe, reload }} />`. Switching
 * sections never refetches or remounts the header. Also redirects the legacy `?page=n` URL to the Games section
 * and replaces a non-canonical username case in the URL.
 */
export function ProfilePage() {
  const { username = "" } = useParams();
  const api = useApi();
  const { user: me } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const atIndex = useMatch("/u/:username");
  // Lookups are case-insensitive, so the canonical-case redirect doesn't refetch.
  const key = username.toLowerCase();
  const { data, loading, error, reload } = useAsync(() => api.getUser(username), [api, key, me?.id]);
  const current = !!data && data.user.username.toLowerCase() === key;

  // Canonical username: same section and search, exact case from the server.
  useEffect(() => {
    if (!data || !current || username === data.user.username) return;
    const parts = location.pathname.split("/");
    // ["", "u", "{username}", ...section]
    const suffix = parts.length > 3 ? `/${parts.slice(3).join("/")}` : "";
    navigate({ pathname: `${profilePath(data.user.username)}${suffix}`, search: location.search, hash: location.hash }, { replace: true });
  }, [data, current, username, location.pathname, location.search, location.hash, navigate]);

  const legacy = atIndex ? legacyPage(location.search) : null;
  if (legacy !== null) return <Navigate to={`${profilePath(username, "games")}?page=${legacy}`} replace />;

  if (error && isApiError(error) && error.status === 404) return <NotFoundPage what="player" />;
  if (error)
    return (
      <div className="pf-container pf-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );

  // A refetch of the same user (reload, viewer change) keeps the current content; a different user shows the skeleton.
  if (!data || !current || (loading && !current))
    return (
      <div className="pf-container pf-page pf-profile-page" aria-busy="true">
        <ProfileHeaderSkeleton />
      </div>
    );

  const isMe = !!me && me.id === data.user.id;
  const ctx: ProfileOutletContext = { profile: data, isMe, reload };
  return (
    <div className="pf-container pf-page pf-profile-page">
      <ProfileHeader profile={data} isMe={isMe} />
      <ProfileTabs profile={data} />
      <Outlet context={ctx} />
    </div>
  );
}

/** `/me` (inside RequireAuth): the signed-in user's profile. */
export function MyProfileRedirect() {
  const { user } = useAuth();
  if (!user) return null;
  return <Navigate to={profilePath(user.username)} replace />;
}
