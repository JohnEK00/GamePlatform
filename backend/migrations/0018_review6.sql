-- Review 6 (REVIEW-2026-11-16-6) L2: a denormalised heart count on comments, so the F017 "Top"
-- sort reads an index instead of sorting every top-level comment with a correlated COUNT.

-- 1. The counter, backfilled from comment_hearts.
ALTER TABLE comments ADD COLUMN hearts INTEGER NOT NULL DEFAULT 0;
UPDATE comments SET hearts = (SELECT COUNT(*) FROM comment_hearts h WHERE h.comment_id = comments.id);

-- 2. Maintained by triggers on every insert/delete of a heart. They also fire for FK cascades
--    (a hearter's account deletion); a cascade from the comment itself updates no row. The app
--    never uses INSERT OR REPLACE on comment_hearts (REPLACE's implicit delete would skip the
--    delete trigger while recursive_triggers is off).
CREATE TRIGGER trg_comment_hearts_insert AFTER INSERT ON comment_hearts
BEGIN
    UPDATE comments SET hearts = hearts + 1 WHERE id = NEW.comment_id;
END;
CREATE TRIGGER trg_comment_hearts_delete AFTER DELETE ON comment_hearts
BEGIN
    UPDATE comments SET hearts = hearts - 1 WHERE id = OLD.comment_id;
END;

-- 3. The Top page: `WHERE game_id = ? AND parent_id IS NULL AND pinned_at IS NULL
--    ORDER BY hearts DESC, created_at DESC, rowid DESC`. Scanned backwards, this ascending index
--    yields exactly that order (rowid is the implicit last column), so there is no temp B-tree.
CREATE INDEX idx_comments_game_hearts ON comments(game_id, hearts, created_at)
    WHERE parent_id IS NULL AND pinned_at IS NULL;
