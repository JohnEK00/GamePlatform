-- REVIEW-2026-11-14-2 fixes: N1 (feed indices), N2 (score_bests), N3 (play_events purge index).

-- N1: the feed's "favorited games" branch is driven from favorites(user_id, game_id); the
-- "followed creators" branch from follows' primary key + idx_activity_actor_id. This covering
-- index lets the favorites side be read without touching the table.
CREATE INDEX idx_favorites_user_game ON favorites(user_id, game_id);

-- N3: the trending purge (`viewer_key = NULL` for days before the window) only visits rows
-- that still hold a key.
CREATE INDEX idx_play_events_viewer_key_day ON play_events(day) WHERE viewer_key IS NOT NULL;

-- N2: one row per (game, period, period start, user) holding that user's best retained score
-- in the period, so boards are LIMIT-n index walks and ranks are indexed counts.
--   period       'all' | 'day' | 'week'
--   period_start ''  for 'all'; else the RFC3339 millis Z start of the UTC day / ISO week
--   rank_score   score for asc games, -score for desc games: smaller is better
-- Best = smallest (rank_score, created_at, score_rowid), the same order `window_board` used.
-- Maintained by triggers on `scores` (insert, delete) and `games.score_order` (rebuild), so
-- every write path (submit, retention pruning, cascades, direct inserts) keeps it in sync
-- inside the writing transaction. No foreign keys: rows are removed by the scores triggers.
CREATE TABLE score_bests (
    game_id      TEXT NOT NULL,
    period       TEXT NOT NULL CHECK (period IN ('all','day','week')),
    period_start TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    score_id     TEXT NOT NULL,
    score        INTEGER NOT NULL,
    rank_score   INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    score_rowid  INTEGER NOT NULL,
    PRIMARY KEY (game_id, period, period_start, user_id)
);
CREATE INDEX idx_score_bests_rank
    ON score_bests(game_id, period, period_start, rank_score, created_at, score_rowid, user_id);
CREATE INDEX idx_score_bests_score_id ON score_bests(score_id);

-- Backfill from the retained scores.
INSERT INTO score_bests (game_id, period, period_start, user_id, score_id, score, rank_score,
                         created_at, score_rowid)
SELECT game_id, period, period_start, user_id, id, score, rank_score, created_at, rid
FROM (
    SELECT x.*, ROW_NUMBER() OVER (
             PARTITION BY x.game_id, x.period, x.period_start, x.user_id
             ORDER BY x.rank_score, x.created_at, x.rid) AS rn
    FROM (
        SELECT s.game_id, s.user_id, s.id, s.score, s.created_at, s.rowid AS rid,
               CASE WHEN g.score_order = 'asc' THEN s.score ELSE -s.score END AS rank_score,
               p.period,
               CASE p.period
                 WHEN 'all' THEN ''
                 WHEN 'day' THEN substr(s.created_at, 1, 10) || 'T00:00:00.000Z'
                 ELSE date(s.created_at, 'weekday 0', '-6 days') || 'T00:00:00.000Z'
               END AS period_start
        FROM scores s
        JOIN games g ON g.id = s.game_id
        CROSS JOIN (SELECT 'all' AS period UNION ALL SELECT 'day' UNION ALL SELECT 'week') p
    ) x
) WHERE rn = 1;

-- A new score becomes the best of its three periods when it beats the stored best
-- (ties keep the earlier row).
CREATE TRIGGER trg_scores_bests_ins AFTER INSERT ON scores
BEGIN
    INSERT INTO score_bests (game_id, period, period_start, user_id, score_id, score,
                             rank_score, created_at, score_rowid)
    SELECT NEW.game_id, p.period,
           CASE p.period
             WHEN 'all' THEN ''
             WHEN 'day' THEN substr(NEW.created_at, 1, 10) || 'T00:00:00.000Z'
             ELSE date(NEW.created_at, 'weekday 0', '-6 days') || 'T00:00:00.000Z'
           END,
           NEW.user_id, NEW.id, NEW.score,
           CASE WHEN g.score_order = 'asc' THEN NEW.score ELSE -NEW.score END,
           NEW.created_at, NEW.rowid
    FROM games g
    CROSS JOIN (SELECT 'all' AS period UNION ALL SELECT 'day' UNION ALL SELECT 'week') p
    WHERE g.id = NEW.game_id
    ON CONFLICT (game_id, period, period_start, user_id) DO UPDATE SET
        score_id = excluded.score_id,
        score = excluded.score,
        rank_score = excluded.rank_score,
        created_at = excluded.created_at,
        score_rowid = excluded.score_rowid
    WHERE (excluded.rank_score, excluded.created_at, excluded.score_rowid)
        < (score_bests.rank_score, score_bests.created_at, score_bests.score_rowid);
END;

-- Deleting a stored best (retention pruning of an old period's best, cascades) promotes the
-- next best remaining score of that user in that period, if any.
CREATE TRIGGER trg_scores_bests_del AFTER DELETE ON scores
WHEN EXISTS (SELECT 1 FROM score_bests WHERE score_id = OLD.id)
BEGIN
    DELETE FROM score_bests WHERE score_id = OLD.id;
    INSERT INTO score_bests (game_id, period, period_start, user_id, score_id, score,
                             rank_score, created_at, score_rowid)
    SELECT game_id, period, period_start, user_id, id, score, rank_score, created_at, rid
    FROM (
        SELECT x.*, ROW_NUMBER() OVER (
                 PARTITION BY x.period ORDER BY x.rank_score, x.created_at, x.rid) AS rn
        FROM (
            SELECT s.game_id, s.user_id, s.id, s.score, s.created_at, s.rowid AS rid,
                   CASE WHEN g.score_order = 'asc' THEN s.score ELSE -s.score END AS rank_score,
                   p.period,
                   CASE p.period
                     WHEN 'all' THEN ''
                     WHEN 'day' THEN substr(s.created_at, 1, 10) || 'T00:00:00.000Z'
                     ELSE date(s.created_at, 'weekday 0', '-6 days') || 'T00:00:00.000Z'
                   END AS period_start,
                   CASE p.period
                     WHEN 'all' THEN ''
                     WHEN 'day' THEN substr(OLD.created_at, 1, 10) || 'T00:00:00.000Z'
                     ELSE date(OLD.created_at, 'weekday 0', '-6 days') || 'T00:00:00.000Z'
                   END AS old_start
            FROM scores s
            JOIN games g ON g.id = s.game_id
            CROSS JOIN (SELECT 'all' AS period UNION ALL SELECT 'day' UNION ALL SELECT 'week') p
            WHERE s.game_id = OLD.game_id AND s.user_id = OLD.user_id
        ) x
        WHERE x.period_start = x.old_start
          AND NOT EXISTS (
              SELECT 1 FROM score_bests b
              WHERE b.game_id = x.game_id AND b.period = x.period
                AND b.period_start = x.period_start AND b.user_id = x.user_id)
    ) WHERE rn = 1;
END;

-- The ranking direction changed (bundle replace with a new `leaderboard.order`): rebuild.
CREATE TRIGGER trg_games_score_order_bests AFTER UPDATE OF score_order ON games
WHEN NEW.score_order IS NOT OLD.score_order
BEGIN
    DELETE FROM score_bests WHERE game_id = NEW.id;
    INSERT INTO score_bests (game_id, period, period_start, user_id, score_id, score,
                             rank_score, created_at, score_rowid)
    SELECT game_id, period, period_start, user_id, id, score, rank_score, created_at, rid
    FROM (
        SELECT x.*, ROW_NUMBER() OVER (
                 PARTITION BY x.period, x.period_start, x.user_id
                 ORDER BY x.rank_score, x.created_at, x.rid) AS rn
        FROM (
            SELECT s.game_id, s.user_id, s.id, s.score, s.created_at, s.rowid AS rid,
                   CASE WHEN NEW.score_order = 'asc' THEN s.score ELSE -s.score END
                     AS rank_score,
                   p.period,
                   CASE p.period
                     WHEN 'all' THEN ''
                     WHEN 'day' THEN substr(s.created_at, 1, 10) || 'T00:00:00.000Z'
                     ELSE date(s.created_at, 'weekday 0', '-6 days') || 'T00:00:00.000Z'
                   END AS period_start
            FROM scores s
            CROSS JOIN (SELECT 'all' AS period UNION ALL SELECT 'day' UNION ALL SELECT 'week') p
            WHERE s.game_id = NEW.id
        ) x
    ) WHERE rn = 1;
END;
