import { useState } from "react";
import { Link } from "react-router-dom";
import type { GameAchievement, UserAchievement } from "../api/types";
import { useApi, useResolveUrl } from "../context/config";
import { useAuth } from "../context/auth";
import { formatCount, formatDate, hashString, timeAgo, useAsync } from "../util";
import { Skeleton } from "./common";

/** Achievement badge: the game's icon, or a generated trophy when there is none / it fails to load. */
export function AchievementIcon({ iconUrl, seed, size = 48, locked }: { iconUrl: string | null; seed: string; size?: number; locked?: boolean }) {
  const resolve = useResolveUrl();
  const url = resolve(iconUrl);
  const [broken, setBroken] = useState(false);
  const hue = hashString(seed) % 360;
  return (
    <span
      className={`pf-ach-icon${locked ? " is-locked" : ""}`}
      style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 50) % 360} 70% 30%))` }}
      aria-hidden="true"
    >
      {url && !broken ? (
        <img src={url} alt="" onError={() => setBroken(true)} />
      ) : (
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55}>
          <path
            fill="currentColor"
            d="M7 3h10v2h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 14.9V17h3v3H8v-3h3v-2.1A5 5 0 0 1 8.3 12H8a4 4 0 0 1-4-4V5h3V3zm0 4H6v1a2 2 0 0 0 1 1.7V7zm10 0v2.7A2 2 0 0 0 18 8V7h-1z"
          />
        </svg>
      )}
      {locked && (
        <span className="pf-ach-icon__lock" aria-hidden="true">
          🔒
        </span>
      )}
    </span>
  );
}

/** Achievements section on the game page: all definitions, unlock counts and your unlock time. */
export function GameAchievements({ gameId, refreshKey = 0 }: { gameId: string; refreshKey?: number }) {
  const api = useApi();
  const { user } = useAuth();
  const { data, loading, error } = useAsync(() => api.listGameAchievements(gameId), [api, gameId, refreshKey, user?.id]);
  if (!loading && (error || !data || data.length === 0)) return null;
  const items: GameAchievement[] = data ?? [];
  const mine = items.filter((a) => a.unlockedAt).length;

  return (
    <section className="pf-panel" aria-labelledby="pf-ach-title">
      <h2 id="pf-ach-title" className="pf-panel__title">
        Achievements{" "}
        {data && (
          <span className="pf-muted pf-small">
            {user ? `${mine} / ${items.length} unlocked` : `${items.length}`}
          </span>
        )}
      </h2>
      {data && user && items.length > 0 && (
        <div className="pf-ach-progress" role="progressbar" aria-label="Achievements unlocked" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={mine}>
          <div style={{ width: `${(mine / items.length) * 100}%` }} />
        </div>
      )}
      {loading && !data ? (
        <div className="pf-ach-grid">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={72} />
          ))}
        </div>
      ) : (
        <ul className="pf-ach-grid">
          {items.map((a) => {
            const locked = !a.unlockedAt;
            return (
              <li key={a.id} className={`pf-ach${locked ? " is-locked" : " is-unlocked"}`}>
                <AchievementIcon iconUrl={a.iconUrl} seed={`${gameId}:${a.id}`} locked={locked} />
                <div className="pf-ach__text">
                  <strong>{a.name}</strong>
                  {a.description && <span className="pf-ach__desc">{a.description}</span>}
                  <span className="pf-ach__meta">
                    {a.unlockedAt ? (
                      <time dateTime={a.unlockedAt} title={formatDate(a.unlockedAt)} className="pf-ach__mine">
                        Unlocked {timeAgo(a.unlockedAt)}
                      </time>
                    ) : (
                      <span>{user ? "Locked" : "Log in to track"}</span>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>
                      {formatCount(a.unlockedBy)} {a.unlockedBy === 1 ? "player" : "players"}
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** "Recent achievements" on a profile page. Renders nothing when there are none. */
export function RecentAchievements({ username, limit = 12 }: { username: string; limit?: number }) {
  const api = useApi();
  const { data, loading, error } = useAsync(() => api.listUserAchievements(username, limit), [api, username, limit]);
  if (error || (!loading && (!data || data.length === 0))) return null;
  const items: UserAchievement[] = data ?? [];
  return (
    <section aria-labelledby="pf-recent-ach-title" className="pf-recent-ach">
      <h2 id="pf-recent-ach-title" className="pf-section-title">
        Recent achievements
      </h2>
      {loading && !data ? (
        <div className="pf-ach-grid">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={72} />
          ))}
        </div>
      ) : (
        <ul className="pf-ach-grid">
          {items.map((a) => (
            <li key={`${a.gameId}:${a.id}`} className="pf-ach is-unlocked">
              <AchievementIcon iconUrl={a.iconUrl} seed={`${a.gameId}:${a.id}`} />
              <div className="pf-ach__text">
                <strong>{a.name}</strong>
                {a.description && <span className="pf-ach__desc">{a.description}</span>}
                <span className="pf-ach__meta">
                  <Link to={`/games/${a.gameId}`}>{a.gameTitle}</Link>
                  <span aria-hidden="true">·</span>
                  <time dateTime={a.unlockedAt} title={formatDate(a.unlockedAt)}>
                    {timeAgo(a.unlockedAt)}
                  </time>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
