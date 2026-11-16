import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Notification } from "../api/types";
import { useAuth } from "../context/auth";
import { useApi } from "../context/config";
import { useNotifications } from "../context/notifications";
import { bellLabel, mergeNotifications, unreadBadgeText } from "../notifications";
import { errorMessage } from "../util";
import { Alert, Spinner } from "./common";
import { NotificationItem } from "./NotificationItem";

/** Items shown in the bell's panel. */
export const NOTIFICATION_PANEL_LIMIT = 10;

export const NOTIFICATION_PANEL_ID = "pf-notif-panel";

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

type PanelState = { items: Notification[]; loading: boolean; error: unknown };

function NotificationPanel({ onClose }: { onClose: (focusBell: boolean) => void }) {
  const api = useApi();
  const { lastChange, markRead, markAllRead, syncUnread, announce } = useNotifications();
  const [state, setState] = useState<PanelState>({ items: [], loading: true, error: null });
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reqRef = useRef(0);

  const load = useCallback(
    (quiet: boolean) => {
      const id = ++reqRef.current;
      if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
      api.listNotifications({ limit: NOTIFICATION_PANEL_LIMIT }).then(
        (p) => {
          if (id !== reqRef.current) return;
          setState({ items: mergeNotifications([], p?.items ?? []), loading: false, error: null });
          if (typeof p?.unread === "number") syncUnread(p.unread);
        },
        (e) => {
          if (id !== reqRef.current) return;
          // A failed background refresh keeps what is shown.
          setState((s) => (quiet && !s.error && s.items.length > 0 ? s : { items: [], loading: false, error: e }));
        },
      );
    },
    [api, syncUnread],
  );

  useEffect(() => {
    headingRef.current?.focus();
    load(false);
    return () => {
      reqRef.current++;
    };
  }, [load]);

  // A poll saw newer notifications while open: refetch without moving focus.
  const firstChange = useRef(lastChange);
  useEffect(() => {
    if (lastChange !== firstChange.current) load(true);
  }, [lastChange, load]);

  const anyUnread = state.items.some((n) => !n.read);

  const onMarkAll = async () => {
    const newest = state.items[0]?.updatedAt;
    if (!newest || marking) return;
    setMarking(true);
    setMarkError(null);
    try {
      await markAllRead(newest);
      setState((s) => ({ ...s, items: s.items.map((n) => (Date.parse(n.updatedAt) <= Date.parse(newest) ? { ...n, read: true } : n)) }));
      headingRef.current?.focus();
      announce("All notifications marked as read");
    } catch (e) {
      setMarkError(errorMessage(e));
    } finally {
      setMarking(false);
    }
  };

  const onActivate = (item: Notification) => {
    void markRead(item);
    setState((s) => ({ ...s, items: s.items.map((n) => (n.id === item.id ? { ...n, read: true } : n)) }));
    onClose(false);
  };

  return (
    <section id={NOTIFICATION_PANEL_ID} className="pf-notif-panel" aria-labelledby="pf-notif-title">
      <div className="pf-notif-panel__head">
        <h2 id="pf-notif-title" className="pf-notif-panel__title" tabIndex={-1} ref={headingRef}>
          Notifications
        </h2>
        {anyUnread && (
          <button type="button" className="pf-linkbtn pf-notif-panel__markall" onClick={onMarkAll} disabled={marking}>
            Mark all as read
          </button>
        )}
      </div>
      {markError && (
        <div className="pf-notif-panel__alert">
          <Alert>{markError}</Alert>
        </div>
      )}
      <div className="pf-notif-panel__body">
        {state.loading ? (
          <div className="pf-notif-panel__status">
            <Spinner size={22} label="Loading notifications" />
          </div>
        ) : state.error ? (
          <div className="pf-notif-panel__alert">
            <Alert>
              <span>Couldn't load notifications. {errorMessage(state.error)}</span>{" "}
              <button type="button" className="pf-btn pf-btn--sm" onClick={() => load(false)}>
                Retry
              </button>
            </Alert>
          </div>
        ) : state.items.length === 0 ? (
          <div className="pf-notif-empty">
            <p className="pf-notif-empty__title">You're all caught up.</p>
            <p className="pf-muted pf-small">Comments on your games, replies, hearts and new followers show up here.</p>
          </div>
        ) : (
          <ul className="pf-notif-list">
            {state.items.map((n) => (
              <NotificationItem key={n.id} item={n} onActivate={onActivate} />
            ))}
          </ul>
        )}
      </div>
      <div className="pf-notif-panel__foot">
        <Link to="/notifications" onClick={() => onClose(false)}>
          See all
        </Link>
        <Link to="/settings#notifications" onClick={() => onClose(false)}>
          Settings
        </Link>
      </div>
    </section>
  );
}

/** The header bell (signed in, server with F007): unread badge plus a non-modal disclosure panel (spec § 2.1–2.2). */
export function NotificationBell() {
  const { user } = useAuth();
  const { supported, ready, unread, arrivals } = useNotifications();
  const [open, setOpen] = useState(false);
  const [pop, setPop] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  // Close on route change.
  const routeKey = location.pathname + location.search;
  const lastRoute = useRef(routeKey);
  useEffect(() => {
    if (lastRoute.current === routeKey) return;
    lastRoute.current = routeKey;
    setOpen(false);
  }, [routeKey]);

  // Brief pop when genuinely new notifications arrive (CSS skips it under prefers-reduced-motion).
  const prevArrivals = useRef(arrivals);
  useEffect(() => {
    const up = arrivals > 0 && arrivals !== prevArrivals.current; // resets to 0 on a user change
    prevArrivals.current = arrivals;
    if (!up) return;
    setPop(true);
    const t = setTimeout(() => setPop(false), 500);
    return () => clearTimeout(t);
  }, [arrivals]);

  // Outside click closes without moving focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = useCallback((focusBell: boolean) => {
    setOpen(false);
    if (focusBell) bellRef.current?.focus();
  }, []);

  if (!user || !supported || !ready) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close(true);
    }
  };

  // Focus moving to something outside both the bell and the panel (Tab past the end) closes it.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (open && next && !wrapRef.current?.contains(next)) setOpen(false);
  };

  const badge = unreadBadgeText(unread);
  return (
    <div className="pf-bell-wrap" ref={wrapRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={bellRef}
        type="button"
        className={`pf-iconbtn pf-bell${pop ? " pf-bell--pop" : ""}`}
        aria-label={bellLabel(unread)}
        aria-expanded={open}
        aria-controls={NOTIFICATION_PANEL_ID}
        onClick={() => setOpen((o) => !o)}
      >
        <BellIcon />
        {badge && (
          <span className="pf-bell__badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      {open && <NotificationPanel onClose={close} />}
    </div>
  );
}
