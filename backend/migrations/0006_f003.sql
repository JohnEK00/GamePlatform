-- F003: trending snapshot + per-play viewer identity (docs/ARCHITECTURE.md § F003).

ALTER TABLE play_events ADD COLUMN viewer_key TEXT;    -- NULL for rows before F003 and after the purge
CREATE INDEX idx_play_events_day_game ON play_events(day, game_id);

CREATE TABLE game_trending (
    game_id      TEXT PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    plays_week   INTEGER NOT NULL,                     -- counted non-owner plays in the window
    score        REAL NOT NULL,                        -- trendingScore (API.md § F003)
    computed_at  TEXT NOT NULL                         -- RFC3339 millis Z of the refresh
);
CREATE INDEX idx_game_trending_score ON game_trending(score DESC);
