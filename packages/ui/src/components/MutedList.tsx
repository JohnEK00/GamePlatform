import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../api/client";
import type { NotificationMute } from "../api/types";
import { useApi, useResolveUrl } from "../context/config";
import { useToast } from "../context/toast";
import { safeNotificationPath } from "../notifications";
import { errorMessage, formatDate } from "../util";
import { LoadError, Spinner } from "./common";
import { muteToastText, useSetMute } from "./muteSupport";

/** Server-side cap on mutes per user (API § F018). */
export const MUTES_PER_USER = 500;
/** The "{total} of 500" line is shown from this many mutes on. */
export const MUTES_COUNT_FROM = 400;

const muteKey = (m: NotificationMute) => `${m.target}:${m.target === "thread" ? m.threadId : m.game.id}`;

/**
 * F018 § 2.4: Settings → Notifications → "Muted", with an Unmute button per row. Renders nothing against a server
 * without the mutes API (404).
 */
export function MutedList() {
  const api = useApi();
  const setMute = useSetMute();
  const toast = useToast();
  const resolve = useResolveUrl();
  const [items, setItems] = useState<NotificationMute[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef(new Set<string>());
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Index of the removed row whose neighbour should get focus after the re-render. */
  const focusAt = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.listNotificationMutes().then(
      (l) => alive && setItems(Array.isArray(l?.items) ? l.items.filter((m) => m && m.game && typeof m.game.id === "string") : []),
      (e) => {
        if (!alive) return;
        if (isApiError(e) && e.status === 404) setUnsupported(true);
        else setError(e);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, reloadKey]);

  useEffect(() => {
    const i = focusAt.current;
    if (i === null || !items) return;
    focusAt.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button.pf-muted-list__unmute");
    const next = buttons && buttons.length ? buttons[Math.min(i, buttons.length - 1)] : null;
    (next ?? headingRef.current)?.focus();
  }, [items]);

  if (unsupported) return null;

  const unmute = async (m: NotificationMute) => {
    const key = muteKey(m);
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    const id = m.target === "thread" ? m.threadId ?? "" : m.game.id;
    try {
      await setMute(m.target, id, false);
      setItems((xs) => {
        if (!xs) return xs;
        const i = xs.findIndex((x) => muteKey(x) === key);
        if (i < 0) return xs;
        const el = document.activeElement;
        if (el && listRef.current?.contains(el)) focusAt.current = i;
        return xs.filter((_, j) => j !== i);
      });
      toast.success(m.target === "thread" ? muteToastText.threadUnmuted : muteToastText.gameUnmuted(m.game.title));
    } catch (e) {
      toast.error("Couldn't unmute notifications", errorMessage(e));
    } finally {
      busyRef.current.delete(key);
      setBusy(new Set(busyRef.current));
    }
  };

  const total = items?.length ?? 0;

  return (
    <section className="pf-muted-list" aria-labelledby="pf-muted-list-title">
      <h3 id="pf-muted-list-title" className="pf-muted-list__title" ref={headingRef} tabIndex={-1}>
        Muted
      </h3>
      {error ? (
        <LoadError message="Couldn't load muted games and threads." onRetry={() => setReloadKey((k) => k + 1)} />
      ) : !items ? (
        <Spinner size={18} label="Loading muted games and threads" />
      ) : items.length === 0 ? (
        <p className="pf-muted pf-small pf-muted-list__empty">You haven't muted any games or threads.</p>
      ) : (
        <>
          {total >= MUTES_COUNT_FROM && (
            <p className="pf-muted pf-small pf-muted-list__count">
              {total} of {MUTES_PER_USER}
            </p>
          )}
          <ul className="pf-muted-list__items" ref={listRef}>
            {items.map((m) => {
              const key = muteKey(m);
              const thumb = resolve(m.game.thumbnailUrl);
              const isThread = m.target === "thread";
              return (
                <li key={key} className="pf-muted-list__row">
                  <span className="pf-muted-list__thumb" aria-hidden="true">
                    {thumb ? <img src={thumb} alt="" width={24} height={24} loading="lazy" /> : <span className="pf-muted-list__thumb-ph">🎮</span>}
                  </span>
                  <span className="pf-muted-list__text">
                    <Link to={`/games/${encodeURIComponent(m.game.id)}`} className="pf-muted-list__game">
                      {m.game.title}
                    </Link>
                    {isThread && (
                      <Link to={safeNotificationPath(m.path)} className="pf-muted-list__thread">
                        Thread: “{m.excerpt ?? ""}”
                      </Link>
                    )}
                    <span className="pf-muted pf-small">
                      Muted <time dateTime={m.createdAt}>{formatDate(m.createdAt)}</time>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="pf-btn pf-btn--ghost pf-btn--sm pf-muted-list__unmute"
                    aria-label={isThread ? `Unmute thread on ${m.game.title}` : `Unmute ${m.game.title}`}
                    aria-busy={busy.has(key) || undefined}
                    onClick={() => void unmute(m)}
                  >
                    Unmute
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
