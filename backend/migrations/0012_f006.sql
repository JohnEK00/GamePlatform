-- F006: comment replies and reactions (docs/ARCHITECTURE.md § F006 additions).

-- One level of replies. NULL = top-level. Always a top-level comment's id (enforced in Rust).
-- SQLite allows ADD COLUMN with REFERENCES because the default is NULL; the cascade is honoured.
ALTER TABLE comments ADD COLUMN parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE;
-- Replies only: the author of the reply that was answered ("Replying to @x").
ALTER TABLE comments ADD COLUMN reply_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_comments_game_top      ON comments(game_id, created_at DESC) WHERE parent_id IS NULL;
CREATE INDEX idx_comments_parent_created ON comments(parent_id, created_at) WHERE parent_id IS NOT NULL;

CREATE TABLE comment_hearts (
    comment_id  TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,                       -- RFC3339 millis Z
    PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX idx_comment_hearts_user ON comment_hearts(user_id);   -- user-delete cascade; F007 lookups
