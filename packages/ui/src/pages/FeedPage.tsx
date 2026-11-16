import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { FeedItem as FeedItemData, FeedItemKind, SuggestedCreator } from "../api/types";
import { useApi } from "../context/config";
import { Avatar, EmptyState, ErrorState, LoadError, Skeleton, Spinner } from "../components/common";
import { FeedItem, FeedItemSkeleton, isKnownFeedItem } from "../components/FeedItem";
import { FollowButton } from "../components/Follow";
import { TabPanel, Tabs, type TabItem } from "../components/Tabs";
import { errorMessage, formatCount, useAsync, useDocumentTitle } from "../util";

/** localStorage key remembering the last selected feed tab. */
export const FEED_TAB_KEY = "webgame.feed.tab";

export type FeedTab = "all" | "games";

const TABS: TabItem<FeedTab>[] = [
  { value: "all", label: "Everything" },
  { value: "games", label: "New games" },
];
const TABS_ID = "pf-feed-tabs";

const TAB_KINDS: Record<FeedTab, FeedItemKind[] | undefined> = {
  all: undefined,
  games: ["gamePublished", "gameUpdated"],
};

function readTab(): FeedTab {
  try {
    const v = localStorage.getItem(FEED_TAB_KEY);
    if (v === "all" || v === "games") return v;
  } catch {
    /* storage unavailable */
  }
  return "all";
}

function writeTab(t: FeedTab) {
  try {
    localStorage.setItem(FEED_TAB_KEY, t);
  } catch {
    /* storage unavailable */
  }
}

type FeedState = {
  items: FeedItemData[];
  nextCursor: string | null;
  loading: boolean;
  error: unknown;
  loadingMore: boolean;
  moreError: unknown;
};

const INITIAL: FeedState = { items: [], nextCursor: null, loading: true, error: null, loadingMore: false, moreError: null };

function appendUnique(prev: FeedItemData[], next: FeedItemData[]): FeedItemData[] {
  const seen = new Set(prev.map((i) => i.id));
  return [...prev, ...next.filter((i) => isKnownFeedItem(i) && !seen.has(i.id))];
}

function SuggestedCreators({ onFollowed }: { onFollowed: () => void }) {
  const api = useApi();
  const { data, loading, error, reload } = useAsync(() => api.getFeedSuggestions(), [api]);
  if (error) return <LoadError message="Couldn't load suggestions." onRetry={reload} />;
  if (!loading && (!data || data.length === 0)) return null;
  return (
    <section className="pf-panel pf-suggest" aria-labelledby="pf-suggest-title">
      <h2 id="pf-suggest-title" className="pf-panel__title">
        Suggested creators
      </h2>
      <ul className="pf-suggest__list">
        {loading || !data
          ? Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="pf-suggest__item" aria-hidden="true">
                <Skeleton width={44} height={44} radius={22} />
                <span className="pf-suggest__info">
                  <Skeleton width={120} height={14} />
                  <Skeleton width={160} height={12} />
                </span>
              </li>
            ))
          : data.slice(0, 6).map((s: SuggestedCreator) => (
              <li key={s.user.id} className="pf-suggest__item">
                <Link to={`/u/${encodeURIComponent(s.user.username)}`} className="pf-suggest__user">
                  <Avatar user={s.user} size={44} />
                  <span className="pf-suggest__info">
                    <strong>{s.user.displayName || s.user.username}</strong>
                    <span className="pf-small pf-muted">
                      {formatCount(s.games)} {s.games === 1 ? "game" : "games"} ·{" "}
                      {s.reason === "favorited" ? "You favorited their games" : "Popular creator"}
                    </span>
                  </span>
                </Link>
                <FollowButton
                  username={s.user.username}
                  displayName={s.user.displayName}
                  isFollowing={false}
                  variant="compact"
                  onChange={(r) => r.following && onFollowed()}
                />
              </li>
            ))}
      </ul>
    </section>
  );
}

/** The signed-in user's activity feed (F002): people they follow, plus updates to games they favorited. */
export function FeedPage() {
  const api = useApi();
  useDocumentTitle("Feed");
  const [tab, setTab] = useState<FeedTab>(readTab);
  const [state, setState] = useState<FeedState>(INITIAL);
  const [reloadKey, setReloadKey] = useState(0);
  const [followedSome, setFollowedSome] = useState(false);
  const moreAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    moreAbort.current?.abort();
    setState(INITIAL);
    api.getFeed({ kinds: TAB_KINDS[tab] }, ctrl.signal).then(
      (p) => {
        if (ctrl.signal.aborted) return;
        setState({ ...INITIAL, loading: false, items: appendUnique([], p?.items ?? []), nextCursor: p?.nextCursor ?? null });
      },
      (e) => {
        if (ctrl.signal.aborted) return;
        setState({ ...INITIAL, loading: false, error: e });
      },
    );
    return () => ctrl.abort();
  }, [api, tab, reloadKey]);

  useEffect(() => () => moreAbort.current?.abort(), []);

  const loadMore = useCallback(() => {
    const cursor = state.nextCursor;
    if (!cursor || state.loadingMore) return;
    const ctrl = new AbortController();
    moreAbort.current = ctrl;
    setState((s) => ({ ...s, loadingMore: true, moreError: null }));
    api.getFeed({ cursor, kinds: TAB_KINDS[tab] }, ctrl.signal).then(
      (p) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, loadingMore: false, items: appendUnique(s.items, p?.items ?? []), nextCursor: p?.nextCursor ?? null }));
      },
      (e) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, loadingMore: false, moreError: e }));
      },
    );
  }, [api, tab, state.nextCursor, state.loadingMore]);

  const selectTab = (t: FeedTab) => {
    if (t === tab) return;
    setTab(t);
    writeTab(t);
  };

  const refresh = () => {
    setFollowedSome(false);
    setReloadKey((k) => k + 1);
  };

  const empty = !state.loading && !state.error && state.items.length === 0;

  return (
    <div className="pf-container pf-page pf-feed">
      <header className="pf-pagehead pf-pagehead--row">
        <div>
          <h1>Feed</h1>
          <p className="pf-muted">New games, updates and high scores from people you follow.</p>
        </div>
        <Tabs id={TABS_ID} label="Feed filter" items={TABS} value={tab} onChange={selectTab} />
      </header>

      <TabPanel id={TABS_ID} value={tab}>
      {state.loading ? (
        <div className="pf-feed__list" aria-busy="true">
          <span className="pf-sr-only" role="status">
            Loading feed
          </span>
          {Array.from({ length: 5 }, (_, i) => (
            <FeedItemSkeleton key={i} />
          ))}
        </div>
      ) : state.error ? (
        <ErrorState error={state.error} onRetry={refresh} />
      ) : empty ? (
        tab === "games" ? (
          <EmptyState icon="🎮" title="No new games from people you follow yet." />
        ) : (
          <>
            <EmptyState
              icon="📰"
              title="Your feed is empty"
              action={
                followedSome && (
                  <button type="button" className="pf-btn pf-btn--primary" onClick={refresh}>
                    Refresh feed
                  </button>
                )
              }
            >
              Follow creators to see their new games and high scores here.
            </EmptyState>
            <SuggestedCreators onFollowed={() => setFollowedSome(true)} />
          </>
        )
      ) : (
        <>
          <div className="pf-feed__list">
            {state.items.map((item) => (
              <FeedItem key={item.id} item={item} />
            ))}
          </div>
          {state.moreError != null && <LoadError message={`Couldn't load more: ${errorMessage(state.moreError)}`} onRetry={loadMore} />}
          {state.nextCursor && (
            <div className="pf-feed__more">
              <button type="button" className="pf-btn" onClick={loadMore} disabled={state.loadingMore}>
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
