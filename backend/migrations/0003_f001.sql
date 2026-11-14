-- F001 Leaderboards 2.0: per-game score semantics (from game.json) and period windows.

ALTER TABLE games ADD COLUMN score_order  TEXT NOT NULL DEFAULT 'desc';   -- 'desc' | 'asc'
ALTER TABLE games ADD COLUMN score_format TEXT NOT NULL DEFAULT 'number'; -- 'number' | 'time'
ALTER TABLE games ADD COLUMN score_label  TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_scores_game_created ON scores(game_id, created_at);
