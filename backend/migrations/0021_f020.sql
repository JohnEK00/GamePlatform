-- F020: game comment settings (docs/ARCHITECTURE.md § F020 additions).
ALTER TABLE games ADD COLUMN comment_mode TEXT NOT NULL DEFAULT 'on';            -- 'on' | 'repliesOnly' | 'off' (validated in Rust)
ALTER TABLE games ADD COLUMN comment_slow_mode_secs INTEGER NOT NULL DEFAULT 0;  -- 0 | 30 | 60 | 300 | 900 | 3600 (validated in Rust)

CREATE TABLE comment_post_times (
    game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_posted_at TEXT NOT NULL,   -- RFC3339 millis Z (same format as comments.created_at)
    PRIMARY KEY (game_id, user_id)
);
CREATE INDEX idx_comment_post_times_user ON comment_post_times(user_id);   -- user delete cascade

INSERT INTO comment_post_times (game_id, user_id, last_posted_at)
SELECT game_id, user_id, MAX(created_at) FROM comments GROUP BY game_id, user_id;
