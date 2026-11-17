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

/** The label of a mute whose game the caller can no longer see (review 6, L3). */
export const UNAVAILABLE_GAME_LABEL = "Unavailable game";

/**
 * A listed mute, normalised. Servers may list mutes of hidden / unpublished games (review 6, L3) with `game: null`,
 * a game without a title, or `available: false`: those rows say "Unavailable game", link nowhere, and keep Unmute.
 */
type MuteRow = { m: NotificationMute; key: string; id: string; gameId: string; unavailable: boolean };

function toRow(raw: unknown): MuteRow | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as NotificationMute & { unavailable?: unknown };
  if (m.target !== "game" && m.target !== "thread") return null;
  const g = m.game && typeof m.game === "object" ? (m.game as NotificationMute["game"] & { available?: unknown }) : null;
  const fromPath = typeof m.path === "string" ? /^\/games\/([^/?#]+)/.exec(m.path)?.[1] : undefined;
  let gameId = g && typeof g.id === "string" && g.id ? g.id : "";
  if (!gameId && fromPath) {
    try {
      gameId = decodeURIComponent(fromPath);
    } catch {
      gameId = "";
    }
  }
  const unavailable = !g || m.unavailable === true || g.available === false || typeof g.title !== "string" || !g.title;
  const id = m.target === "thread" ? (typeof m.threadId === "string" ? m.threadId : "") : gameId;
  if (!id) return null;
  return { m, key: `${m.target}:${id}`, id, gameId, unavailable };
}

/**
 * F018 § 2.4: Settings → Notifications → "Muted", with an Unmute button per row. Renders nothing against a server
 * without the mutes API (404).
 */
export function MutedList() {
  const api = useApi();
  const setMute = useSetMute();
  const toast = useToast();
  const resolve = useResolveUrl();
  const [items, setItems] = useState<MuteRow[] | null>(null);
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
      (l) => alive && setItems(Array.isArray(l?.items) ? l.items.map(toRow).filter((r): r is MuteRow => r !== null) : []),
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

  const unmute = async (row: MuteRow) => {
    const { m, key, id, unavailable } = row;
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    try {
      await setMute(m.target, id, false);
      setItems((xs) => {
        if (!xs) return xs;
        const i = xs.findIndex((x) => x.key === key);
        if (i < 0) return xs;
        const el = document.activeElement;
        if (el && listRef.current?.contains(el)) focusAt.current = i;
        return xs.filter((_, j) => j !== i);
      });
      toast.success(
        m.target === "thread" ? muteToastText.threadUnmuted : unavailable ? "Unmuted the unavailable game." : muteToastText.gameUnmuted(m.game.title),
      );
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
            {items.map((row) => {
              const { m, key, unavailable } = row;
              const thumb = unavailable ? null : resolve(m.game.thumbnailUrl);
              const isThread = m.target === "thread";
              const gameLabel = unavailable ? UNAVAILABLE_GAME_LABEL : m.game.title;
              return (
                <li key={key} className={`pf-muted-list__row${unavailable ? " pf-muted-list__row--gone" : ""}`}>
                  <span className="pf-muted-list__thumb" aria-hidden="true">
                    {thumb ? (
                      <img src={thumb} alt="" width={24} height={24} loading="lazy" />
                    ) : (
                      <span className="pf-muted-list__thumb-ph">{unavailable ? "?" : "🎮"}</span>
                    )}
                  </span>
                  <span className="pf-muted-list__text">
                    {unavailable ? (
                      <span className="pf-muted-list__game pf-muted-list__game--gone">{UNAVAILABLE_GAME_LABEL}</span>
                    ) : (
                      <Link to={`/games/${encodeURIComponent(row.gameId)}`} className="pf-muted-list__game">
                        {m.game.title}
                      </Link>
                    )}
                    {isThread &&
                      (unavailable ? (
                        <span className="pf-muted-list__thread pf-muted pf-small">Thread</span>
                      ) : (
                        <Link to={safeNotificationPath(m.path)} className="pf-muted-list__thread">
                          Thread: “{m.excerpt ?? ""}”
                        </Link>
                      ))}
                    <span className="pf-muted pf-small">
                      Muted <time dateTime={m.createdAt}>{formatDate(m.createdAt)}</time>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="pf-btn pf-btn--ghost pf-btn--sm pf-muted-list__unmute"
                    aria-label={isThread ? `Unmute thread on ${gameLabel}` : `Unmute ${gameLabel}`}
                    aria-busy={busy.has(key) || undefined}
                    onClick={() => void unmute(row)}
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
