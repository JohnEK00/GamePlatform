-- F017: creator comment tools (docs/ARCHITECTURE.md § F017 additions).
ALTER TABLE comments ADD COLUMN pinned_at TEXT;   -- NULL = not pinned; RFC3339 millis Z; top-level only
ALTER TABLE comments ADD COLUMN locked_at TEXT;   -- NULL = open; RFC3339 millis Z; top-level only
-- At most one pinned comment per game; also the lookup for CommentListPage.pinned.
CREATE UNIQUE INDEX idx_comments_game_pinned ON comments(game_id) WHERE pinned_at IS NOT NULL;
