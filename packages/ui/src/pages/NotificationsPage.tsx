import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Notification } from "../api/types";
import { useApi } from "../context/config";
import { useNotifications } from "../context/notifications";
import { useToast } from "../context/toast";
import { EmptyState, ErrorState, LoadError, Spinner } from "../components/common";
import { NotificationItem } from "../components/NotificationItem";
import { TabPanel, Tabs, type TabItem } from "../components/Tabs";
import { mergeNotifications } from "../notifications";
import { errorMessage, useDocumentTitle } from "../util";

/** Items per page on /notifications. */
export const NOTIFICATIONS_PER_PAGE = 20;

export type NotificationsFilter = "all" | "unread";

const TABS: TabItem<NotificationsFilter>[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
];
const TABS_ID = "pf-notif-tabs";

type ListState = {
  items: Notification[];
  nextCursor: string | null;
  loading: boolean;
  error: unknown;
  loadingMore: boolean;
  moreError: unknown;
};
const INITIAL: ListState = { items: [], nextCursor: null, loading: true, error: null, loadingMore: false, moreError: null };

/** All / Unread notifications with cursor paging (spec § 2.3). The filter lives in `?filter=unread`. */
export function NotificationsPage() {
  const api = useApi();
  const toast = useToast();
  const { markRead, markAllRead, syncUnread, announce } = useNotifications();
  useDocumentTitle("Notifications");
  const [params, setParams] = useSearchParams();
  const filter: NotificationsFilter = params.get("filter") === "unread" ? "unread" : "all";
  const [state, setState] = useState<ListState>(INITIAL);
  const [reloadKey, setReloadKey] = useState(0);
  const [marking, setMarking] = useState(false);
  const reqRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const markRef = useRef<HTMLButtonElement>(null);
  /** Set when "Load more" had focus and its last page arrived: ids shown before that page (review 4, L6a). */
  const focusAfterMore = useRef<Set<string> | null>(null);

  useEffect(() => {
    const id = ++reqRef.current;
    setState(INITIAL);
    api.listNotifications({ limit: NOTIFICATIONS_PER_PAGE, unread: filter === "unread" || undefined }).then(
      (p) => {
        if (id !== reqRef.current) return;
        setState({ ...INITIAL, loading: false, items: mergeNotifications([], p?.items ?? []), nextCursor: p?.nextCursor ?? null });
        if (typeof p?.unread === "number") syncUnread(p.unread);
      },
      (e) => {
        if (id !== reqRef.current) return;
        setState({ ...INITIAL, loading: false, error: e });
      },
    );
    return () => {
      reqRef.current++;
    };
  }, [api, filter, reloadKey, syncUnread]);

  const loadMore = useCallback(() => {
    const cursor = state.nextCursor;
    if (!cursor || state.loadingMore) return;
    const id = reqRef.current;
    const shown = new Set(state.items.map((n) => n.id));
    setState((s) => ({ ...s, loadingMore: true, moreError: null }));
    api.listNotifications({ cursor, limit: NOTIFICATIONS_PER_PAGE, unread: filter === "unread" || undefined }).then(
      (p) => {
        if (id !== reqRef.current) return;
        const nextCursor = p?.nextCursor ?? null;
        // The button unmounts on the last page: if it had focus, move it to the first new item (else the heading).
        if (!nextCursor && moreRef.current && document.activeElement === moreRef.current) focusAfterMore.current = shown;
        setState((s) => ({ ...s, loadingMore: false, items: mergeNotifications(s.items, p?.items ?? []), nextCursor }));
      },
      (e) => {
        if (id !== reqRef.current) return;
        setState((s) => ({ ...s, loadingMore: false, moreError: e }));
      },
    );
  }, [api, filter, state.items, state.nextCursor, state.loadingMore]);

  useEffect(() => {
    const shown = focusAfterMore.current;
    if (!shown || state.loadingMore) return;
    focusAfterMore.current = null;
    const fresh = Array.from(listRef.current?.querySelectorAll<HTMLElement>("li[data-notif-id]") ?? []).find((li) => !shown.has(li.dataset.notifId ?? ""));
    (fresh?.querySelector<HTMLElement>("a") ?? headingRef.current)?.focus();
  }, [state.items, state.loadingMore]);

  const selectFilter = (f: NotificationsFilter) => {
    if (f === filter) return;
    const next = new URLSearchParams(params);
    if (f === "unread") next.set("filter", "unread");
    else next.delete("filter");
    setParams(next);
  };

  const anyUnread = state.items.some((n) => !n.read);

  const onMarkAll = async () => {
    const newest = state.items[0]?.updatedAt;
    if (!newest || marking) return;
    setMarking(true);
    try {
      await markAllRead(newest);
      // The button unmounts once nothing is unread: keep focus on the page (review 4, L6a).
      const a = document.activeElement;
      if (a === markRef.current || !a || a === document.body) headingRef.current?.focus();
      setState((s) => ({ ...s, items: s.items.map((n) => (Date.parse(n.updatedAt) <= Date.parse(newest) ? { ...n, read: true } : n)) }));
      announce("All notifications marked as read");
    } catch (e) {
      toast.error("Couldn't mark notifications as read", errorMessage(e));
    } finally {
      setMarking(false);
    }
  };

  const onActivate = (item: Notification) => {
    void markRead(item);
    setState((s) => ({ ...s, items: s.items.map((n) => (n.id === item.id ? { ...n, read: true } : n)) }));
  };

  const empty = !state.loading && !state.error && state.items.length === 0;

  return (
    <div className="pf-container pf-page pf-narrow pf-notifs">
      <header className="pf-pagehead pf-pagehead--row">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            Notifications
          </h1>
          <p className="pf-muted pf-small">
            <Link to="/settings#notifications">Notification settings</Link>
          </p>
        </div>
        <div className="pf-notifs__actions">
          <Tabs id={TABS_ID} label="Notification filter" items={TABS} value={filter} onChange={selectFilter} />
          {anyUnread && (
            <button type="button" className="pf-btn pf-btn--sm" onClick={onMarkAll} aria-disabled={marking || undefined} ref={markRef}>
              {marking ? <Spinner size={14} /> : null} Mark all as read
            </button>
          )}
        </div>
      </header>

      <TabPanel id={TABS_ID} value={filter} className="pf-notifs__panel">
        {state.loading ? (
          <div className="pf-center pf-pad">
            <Spinner size={28} label="Loading notifications" />
          </div>
        ) : state.error ? (
          <ErrorState error={state.error} onRetry={() => setReloadKey((k) => k + 1)} />
        ) : empty ? (
          filter === "unread" ? (
            <EmptyState icon="✓" title="No unread notifications." action={<Link to="/notifications" className="pf-btn">Show all notifications</Link>} />
          ) : (
            <EmptyState icon="🔔" title="You're all caught up.">
              Comments on your games, replies, hearts and new followers show up here.
            </EmptyState>
          )
        ) : (
          <>
            <ul className="pf-notif-list pf-notif-list--page" ref={listRef}>
              {state.items.map((n) => (
                <NotificationItem key={n.id} item={n} variant="page" onActivate={onActivate} />
              ))}
            </ul>
            {state.moreError != null && <LoadError message={`Couldn't load more: ${errorMessage(state.moreError)}`} onRetry={loadMore} />}
            {state.nextCursor && (
              <div className="pf-feed__more">
                <button type="button" className="pf-btn" onClick={loadMore} aria-disabled={state.loadingMore || undefined} ref={moreRef}>
                  {state.loadingMore ? <Spinner size={14} /> : null} Load more
                </button>
              </div>
            )}
          </>
        )}
      </TabPanel>
    </div>
  );
}
