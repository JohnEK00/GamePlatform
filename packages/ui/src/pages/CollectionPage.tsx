import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Collection, CollectionItem } from "../api/types";
import { collectionShareUrl, gamesLabel, moveItem } from "../collections";
import { useApi, useConfig } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { CollectionCover, PrivateBadge } from "../components/CollectionCard";
import { CollectionFormDialog } from "../components/CollectionFormDialog";
import { CollectionItemRow, collectionItemTitle, type MoveDirection } from "../components/CollectionItemRow";
import { ConfirmDialog, EmptyState, ErrorState, Skeleton, UserLink } from "../components/common";
import { ReportButton } from "../components/Report";
import { errorMessage, formatDate, useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";

/** How long "Link copied" stays on the Copy link button. */
export const LINK_COPIED_MS = 2000;
/** How long the Undo action of a removal stays available. */
export const COLLECTION_UNDO_MS = 5000;
export const COLLECTION_CONFLICT_MESSAGE = "This collection changed in another tab. Reloaded.";

type FocusRequest = { get: () => HTMLElement | null | undefined; select?: boolean };

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** `/c/:id`: a collection with its ordered games, notes and (for the owner) reorder / note / remove controls. */
export function CollectionPage() {
  const { id = "" } = useParams();
  const api = useApi();
  const config = useConfig();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const uid = useId();
  const { data, loading, error, reload, setData } = useAsync(() => api.getCollection(id), [api, id, user?.id]);
  const coll = data && !loading ? data : undefined;
  // Async handlers read the latest collection through this ref, never a stale render's closure.
  const collRef = useRef<Collection | undefined>(coll);
  collRef.current = coll;
  useDocumentTitle(coll?.title);

  const [live, setLive] = useState({ n: 0, text: "" });
  const announce = useCallback((text: string) => setLive((l) => ({ n: l.n + 1, text })), []);

  const listRef = useRef<HTMLOListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fallbackRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<FocusRequest | null>(null);
  const [, setFocusTick] = useState(0);
  const requestFocus = useCallback((req: FocusRequest) => {
    pendingFocus.current = req;
    setFocusTick((t) => t + 1);
  }, []);
  // After every commit: move focus once the target exists.
  useEffect(() => {
    const req = pendingFocus.current;
    if (!req) return;
    const el = req.get();
    if (el && el.isConnected) {
      pendingFocus.current = null;
      el.focus();
      if (req.select && el instanceof HTMLInputElement) el.select();
    }
  });

  const rowButton = useCallback((gameId: string, actions: string[]): HTMLElement | null => {
    const list = listRef.current;
    if (!list) return null;
    const row = Array.from(list.children).find((li) => (li as HTMLElement).dataset.gameId === gameId) as HTMLElement | undefined;
    if (!row) return null;
    for (const a of actions) {
      const b = row.querySelector<HTMLElement>(`[data-action="${a}"]`);
      if (b) return b;
    }
    return null;
  }, []);

  const moving = useRef(false);
  const removing = useRef(new Set<string>());
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => {
    setFallbackUrl(null);
    setCopied(false);
  }, [id]);

  const reloadAfterConflict = useCallback(async () => {
    const cid = collRef.current?.id ?? id;
    try {
      const fresh = await api.getCollection(cid);
      setData(fresh);
      toast.info(COLLECTION_CONFLICT_MESSAGE);
    } catch (e) {
      toast.error("Couldn't reload the collection", errorMessage(e));
    }
    requestFocus({ get: () => headingRef.current });
  }, [api, id, setData, toast, requestFocus]);

  const move = async (index: number, dir: MoveDirection) => {
    const c = collRef.current;
    if (!c || moving.current) return;
    const ids = c.items.map((i) => i.gameId);
    const to = dir === "up" ? index - 1 : index + 1;
    if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return;
    const item = c.items[index];
    const title = collectionItemTitle(item);
    moving.current = true;
    try {
      const updated = await api.reorderCollection(c.id, moveItem(ids, index, to));
      setData(updated);
      const items = Array.isArray(updated?.items) ? updated.items : [];
      const pos = items.findIndex((i) => i.gameId === item.gameId);
      announce(`Moved ${title} to position ${(pos >= 0 ? pos : to) + 1} of ${items.length || ids.length}`);
      requestFocus({ get: () => rowButton(item.gameId, [dir, dir === "up" ? "down" : "up", "remove"]) });
    } catch (e) {
      if (isApiError(e) && e.status === 409) await reloadAfterConflict();
      else toast.error("Couldn't move the game", errorMessage(e));
    } finally {
      moving.current = false;
    }
  };

  const saveNote = async (gameId: string, note: string) => {
    const c = collRef.current;
    if (!c) return;
    const r = await api.putCollectionGame(c.id, gameId, { note });
    setData((prev) =>
      prev
        ? {
            ...prev,
            updatedAt: r?.updatedAt ?? prev.updatedAt,
            items: prev.items.map((i) => (i.gameId === gameId ? { ...i, note: typeof r?.item?.note === "string" ? r.item.note : note } : i)),
          }
        : (prev as never),
    );
    announce(note ? "Note saved" : "Note removed");
  };

  const undo = async (item: CollectionItem, before: string[]) => {
    const title = collectionItemTitle(item);
    // The toast (and its Undo button) goes away: keep focus in the list meanwhile.
    requestFocus({ get: () => headingRef.current });
    const c = collRef.current;
    if (!c) return;
    try {
      const r = await api.putCollectionGame(c.id, item.gameId, { note: item.note });
      const latest = collRef.current ?? c;
      const restored: CollectionItem = r?.item ? { ...item, ...r.item } : item;
      const afterAdd = [...latest.items.filter((i) => i.gameId !== item.gameId), restored];
      setData((prev) => (prev ? { ...prev, items: afterAdd, gameCount: r?.gameCount ?? prev.gameCount, updatedAt: r?.updatedAt ?? prev.updatedAt } : (prev as never)));
      const current = afterAdd.map((i) => i.gameId);
      const desired = [...before.filter((x) => current.includes(x)), ...current.filter((x) => !before.includes(x))];
      if (!sameOrder(desired, current)) setData(await api.reorderCollection(c.id, desired));
      announce(`Restored ${title}`);
      requestFocus({ get: () => rowButton(item.gameId, ["remove"]) ?? headingRef.current });
    } catch (e) {
      if (isApiError(e) && e.status === 409) await reloadAfterConflict();
      else toast.error(`Couldn't restore ${title}`, errorMessage(e));
    }
  };

  const remove = async (index: number) => {
    const c = collRef.current;
    const item = c?.items[index];
    if (!c || !item || removing.current.has(item.gameId)) return;
    const before = c.items.map((i) => i.gameId);
    const title = collectionItemTitle(item);
    removing.current.add(item.gameId);
    try {
      const r = await api.deleteCollectionGame(c.id, item.gameId);
      const latest = collRef.current ?? c;
      const at = latest.items.findIndex((i) => i.gameId === item.gameId);
      const neighbor = at >= 0 ? (latest.items[at + 1] ?? latest.items[at - 1]) : undefined;
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.filter((i) => i.gameId !== item.gameId),
              gameCount: typeof r?.gameCount === "number" ? r.gameCount : prev.gameCount,
              updatedAt: r?.updatedAt ?? prev.updatedAt,
            }
          : (prev as never),
      );
      requestFocus({ get: () => (neighbor ? rowButton(neighbor.gameId, ["remove"]) : null) ?? headingRef.current });
      announce(`Removed ${title}`);
      toast.show({
        kind: "success",
        title: "Removed from the collection",
        message: title,
        duration: COLLECTION_UNDO_MS,
        action: { label: "Undo", onClick: () => void undo(item, before) },
      });
    } catch (e) {
      toast.error(`Couldn't remove ${title}`, errorMessage(e));
    } finally {
      removing.current.delete(item.gameId);
    }
  };

  const copyLink = async () => {
    const c = collRef.current;
    if (!c) return;
    const url = collectionShareUrl(config, c.id);
    try {
      const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      if (!clip || typeof clip.writeText !== "function") throw new Error("Clipboard unavailable");
      await clip.writeText(url);
      setFallbackUrl(null);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), LINK_COPIED_MS);
      announce("Link copied");
    } catch {
      setFallbackUrl(url);
      requestFocus({ get: () => fallbackRef.current, select: true });
    }
  };

  const doDelete = async () => {
    const c = collRef.current;
    if (!c) return;
    setDeleting(true);
    try {
      await api.deleteCollection(c.id);
      toast.success("Collection deleted");
      navigate(user ? `/u/${encodeURIComponent(user.username)}/collections` : "/");
    } catch (e) {
      toast.error("Couldn't delete the collection", errorMessage(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (error && isApiError(error) && error.status === 404) return <NotFoundPage what="collection" />;
  if (error)
    return (
      <div className="pf-container pf-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  if (!coll)
    return (
      <div className="pf-container pf-page pf-collection-page" aria-busy="true">
        <div className="pf-collection-head">
          <Skeleton className="pf-collection-cover" height="auto" />
          <div className="pf-collection-head__info">
            <Skeleton width="60%" height={32} />
            <Skeleton width="35%" height={18} />
            <Skeleton width="80%" height={16} />
          </div>
        </div>
        <Skeleton height={88} />
        <Skeleton height={88} />
      </div>
    );

  const c = coll;
  const items = Array.isArray(c.items) ? c.items : [];
  const isPublic = c.visibility === "public";
  const canReport = !!user && !c.isOwner && !c.canDelete;
  const titleId = `${uid}-games`;

  return (
    <div className="pf-container pf-page pf-collection-page">
      <header className="pf-collection-head">
        <CollectionCover coverUrls={c.coverUrls} />
        <div className="pf-collection-head__info">
          <p className="pf-eyebrow">Collection</p>
          <h1 className="pf-collection-head__title">{c.title}</h1>
          <p className="pf-collection-head__by">
            A collection by <UserLink user={c.owner} size={22} />
          </p>
          <p className="pf-collection-head__meta pf-muted pf-small">
            <span>
              {gamesLabel(c.gameCount)} · Updated {formatDate(c.updatedAt)}
            </span>
            {!isPublic && <PrivateBadge />}
          </p>
          {c.description && <p className="pf-collection-head__desc">{c.description}</p>}
          <div className="pf-collection-head__actions">
            {isPublic ? (
              <button type="button" className="pf-btn pf-btn--primary pf-btn--sm" onClick={() => void copyLink()}>
                <span aria-hidden="true">🔗</span> {copied ? "Link copied" : "Copy link"}
              </button>
            ) : (
              c.isOwner && <p className="pf-muted pf-small pf-collection-head__private">Private: only you can see this collection.</p>
            )}
            {c.isOwner && (
              <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm" aria-haspopup="dialog" onClick={() => setEditOpen(true)}>
                ✎ Edit
              </button>
            )}
            {c.canDelete && (
              <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm pf-btn--danger-text" aria-haspopup="dialog" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
            {canReport && (
              <ReportButton targetType="collection" targetId={c.id} targetLabel={c.title} className="pf-btn pf-btn--ghost pf-btn--sm">
                ⚑ Report
              </ReportButton>
            )}
          </div>
          {fallbackUrl && (
            <div className="pf-field pf-collection-head__share">
              <label className="pf-label pf-small" htmlFor={`${uid}-share`}>
                Copy this link
              </label>
              <input
                ref={fallbackRef}
                id={`${uid}-share`}
                className="pf-input pf-input--sm"
                readOnly
                value={fallbackUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          )}
        </div>
      </header>

      <p className="pf-sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={live.n}>{live.text}</span>
      </p>

      <section className="pf-collection-games" aria-labelledby={titleId}>
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="pf-section-title">
          Games
        </h2>
        {items.length === 0 ? (
          c.isOwner ? (
            <EmptyState
              icon="📚"
              title="No games yet"
              action={
                <Link to="/" className="pf-btn pf-btn--primary">
                  Browse games
                </Link>
              }
            >
              Use <strong>+ Collection</strong> on any game page to add one.
            </EmptyState>
          ) : (
            <EmptyState icon="📚" title="This collection is empty." />
          )
        ) : (
          // role="list": WebKit drops list semantics (and the native "n of m") under `list-style: none`.
          // eslint-disable-next-line jsx-a11y/no-redundant-roles
          <ol ref={listRef} className="pf-collection-items" role="list" aria-label="Games in this collection">
            {items.map((item, i) => (
              <CollectionItemRow
                key={item.gameId}
                item={item}
                index={i}
                count={items.length}
                isOwner={c.isOwner}
                onMove={(idx, dir) => void move(idx, dir)}
                onSaveNote={saveNote}
                onRemove={(idx) => void remove(idx)}
              />
            ))}
          </ol>
        )}
      </section>

      <CollectionFormDialog
        open={editOpen}
        collection={c}
        onClose={() => setEditOpen(false)}
        onSaved={(u) => {
          setData((prev) => ({ ...(prev ?? c), ...u, items: Array.isArray(u?.items) ? u.items : (prev ?? c).items }));
          setEditOpen(false);
          announce("Collection saved");
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this collection?"
        confirmLabel="Delete collection"
        danger
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      >
        The games stay on the site; only this list is removed.
      </ConfirmDialog>
    </div>
  );
}
