-- REVIEW-2026-11-15-3 L4: a `leaderboard.order` change no longer rebuilds the game's
-- `score_bests` inside the bundle-replace write transaction. The order-flip trigger only
-- marks the game stale; boards of a stale game are computed from `scores` (src/bests.rs
-- fallback) until the background rebuild (short per-batch transactions) clears the mark.
--   generation  bumped on every flip, so a rebuild that started before a newer flip never
--               clears the newer mark.
CREATE TABLE score_bests_stale (
    game_id    TEXT PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL
);

DROP TRIGGER trg_games_score_order_bests;

CREATE TRIGGER trg_games_score_order_stale AFTER UPDATE OF score_order ON games
WHEN NEW.score_order IS NOT OLD.score_order
BEGIN
    INSERT INTO score_bests_stale (game_id, generation) VALUES (NEW.id, 1)
    ON CONFLICT (game_id) DO UPDATE SET generation = generation + 1;
END;
