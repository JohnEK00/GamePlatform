import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { RatingResponse } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";

export type StarRatingProps = {
  gameId: string;
  ratingAvg: number;
  ratingCount: number;
  myRating: number | null;
  onChange?: (r: RatingResponse) => void;
};

/** Interactive 1–5 star rating widget (rates via PUT /rating, clears via DELETE /rating). */
export function StarRating({ gameId, ratingAvg, ratingCount, myRating, onChange }: StarRatingProps) {
  const api = useApi();
  const { user } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const [hover, setHover] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const rate = async (score: number | null) => {
    setBusy(true);
    try {
      const r = score === null ? await api.clearRating(gameId) : await api.rateGame(gameId, score);
      onChange?.(r);
      if (score !== null) toast.success(`Rated ${score} star${score === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error("Rating failed", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = hover ?? myRating ?? 0;
  return (
    <div className="pf-rating">
      <div className="pf-rating__summary">
        <span className="pf-rating__avg">{ratingCount ? ratingAvg.toFixed(1) : "–"}</span>
        <span className="pf-muted">
          {ratingCount} rating{ratingCount === 1 ? "" : "s"}
        </span>
      </div>
      {user ? (
        <div className="pf-rating__input">
          <div className="pf-rating__stars" role="radiogroup" aria-label="Your rating" onMouseLeave={() => setHover(null)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={myRating === n}
                aria-label={`${n} star${n === 1 ? "" : "s"}`}
                className={`pf-star${n <= shown ? " is-on" : ""}`}
                disabled={busy}
                onMouseEnter={() => setHover(n)}
                onFocus={() => setHover(n)}
                onBlur={() => setHover(null)}
                onClick={() => rate(n)}
              >
                ★
              </button>
            ))}
          </div>
          {myRating !== null && (
            <button type="button" className="pf-linkbtn" onClick={() => rate(null)} disabled={busy}>
              Clear my rating
            </button>
          )}
        </div>
      ) : (
        <p className="pf-muted pf-small">
          <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>Log in</Link> to rate this game.
        </p>
      )}
    </div>
  );
}
