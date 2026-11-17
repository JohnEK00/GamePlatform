-- F015: screenshots in the feed and on profiles (docs/ARCHITECTURE.md § F015 additions).
-- The profile list (an author's screenshots, newest first) without a temp B-tree sort.
-- The feed uses the existing idx_screenshots_author_game (0009).
CREATE INDEX idx_screenshots_author_created ON screenshots(author_id, created_at DESC, id);
