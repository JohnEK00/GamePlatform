import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/auth";
import { usePlatform } from "../context/config";
import { Avatar, Spinner } from "./common";

export function Logo() {
  return (
    <Link to="/" className="pf-logo" aria-label="Pixelforge Arcade home">
      <svg viewBox="0 0 16 16" width="28" height="28" aria-hidden="true" shapeRendering="crispEdges">
        <rect x="2" y="9" width="12" height="3" fill="var(--pf-accent)" />
        <rect x="4" y="12" width="8" height="2" fill="var(--pf-accent-2)" />
        <rect x="6" y="3" width="4" height="6" fill="var(--pf-accent-2)" />
        <rect x="7" y="1" width="2" height="2" fill="var(--pf-accent)" />
        <rect x="3" y="6" width="2" height="2" fill="#ffd166" />
        <rect x="11" y="5" width="2" height="2" fill="#ffd166" />
      </svg>
      <span className="pf-logo__text">
        Pixelforge<span>Arcade</span>
      </span>
    </Link>
  );
}

function SearchBox({ onDone }: { onDone?: () => void }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState(location.pathname === "/" ? params.get("q") ?? "" : "");
  useEffect(() => {
    if (location.pathname === "/") setQ(params.get("q") ?? "");
  }, [location.pathname, params]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (q.trim()) next.set("q", q.trim());
    navigate({ pathname: "/", search: next.toString() ? `?${next}` : "" });
    onDone?.();
  };
  return (
    <form className="pf-search" role="search" onSubmit={submit}>
      <label htmlFor="pf-search-input" className="pf-sr-only">
        Search games
      </label>
      <span className="pf-search__icon" aria-hidden="true">
        ⌕
      </span>
      <input id="pf-search-input" type="search" placeholder="Search games…" value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!user) return null;
  return (
    <div className="pf-usermenu" ref={ref}>
      <button type="button" className="pf-usermenu__btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar user={user} size={30} />
        <span className="pf-usermenu__name">{user.displayName || user.username}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pf-usermenu__menu" role="menu">
          <Link role="menuitem" to={`/u/${encodeURIComponent(user.username)}`}>
            Profile
          </Link>
          <Link role="menuitem" to="/dashboard">
            My games
          </Link>
          <Link role="menuitem" to="/upload">
            Upload a game
          </Link>
          <Link role="menuitem" to="/settings">
            Settings
          </Link>
          <hr />
          <button role="menuitem" type="button" onClick={logout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [location.pathname, location.search]);
  const next = encodeURIComponent(location.pathname + location.search);
  const onAuthPage = location.pathname === "/login" || location.pathname === "/register";

  return (
    <header className="pf-header">
      <div className="pf-header__inner pf-container">
        <Logo />
        <button
          type="button"
          className="pf-iconbtn pf-header__toggle"
          aria-label="Menu"
          aria-expanded={navOpen}
          aria-controls="pf-mainnav"
          onClick={() => setNavOpen((o) => !o)}
        >
          ☰
        </button>
        <div id="pf-mainnav" className={`pf-header__nav${navOpen ? " is-open" : ""}`}>
          <nav aria-label="Main">
            <NavLink to="/" end>
              Browse
            </NavLink>
            <NavLink to="/docs">Make a game</NavLink>
            {user && <NavLink to="/dashboard">My games</NavLink>}
          </nav>
          <SearchBox onDone={() => setNavOpen(false)} />
          <div className="pf-header__actions">
            {loading ? (
              <Spinner size={18} label="Checking session" />
            ) : user ? (
              <>
                <Link to="/upload" className="pf-btn pf-btn--primary pf-btn--sm">
                  + Upload
                </Link>
                <UserMenu />
              </>
            ) : (
              <>
                <Link to={onAuthPage ? "/login" : `/login?next=${next}`} className="pf-btn pf-btn--ghost pf-btn--sm">
                  Log in
                </Link>
                <Link to={onAuthPage ? "/register" : `/register?next=${next}`} className="pf-btn pf-btn--primary pf-btn--sm">
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  const platform = usePlatform();
  return (
    <footer className="pf-footer">
      <div className="pf-container pf-footer__inner">
        <span>
          <strong>Pixelforge Arcade</strong>
          {platform.name ? ` · ${platform.name}` : ""} — forge games, play games.
        </span>
        <nav aria-label="Footer">
          <Link to="/">Browse</Link>
          <Link to="/docs">Make a game</Link>
          <Link to="/upload">Upload</Link>
        </nav>
      </div>
    </footer>
  );
}

export function Layout() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo?.({ top: 0 });
  }, [location.pathname]);
  return (
    <div className="pf-app">
      <a href="#pf-main" className="pf-skiplink" onClick={(e) => {
        e.preventDefault();
        document.getElementById("pf-main")?.focus();
      }}>
        Skip to content
      </a>
      <Header />
      <main id="pf-main" className="pf-main" tabIndex={-1}>
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

/** Redirects to /login?next=… when not signed in. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="pf-center pf-pad">
        <Spinner size={28} />
      </div>
    );
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}
