-- R7 (review 2026-11-14 #1): indices matching the game listing queries, plus stored sort keys
-- for sort=top and sort=favorites so they no longer compute per row and sort in a temp B-tree.
-- Every listing index ends with `id` because the list queries break ties with `g.id`.

-- sort=favorites: denormalised count, maintained by triggers (cascade deletes fire them too).
ALTER TABLE games ADD COLUMN favorites_count INTEGER NOT NULL DEFAULT 0;
UPDATE games SET favorites_count = (SELECT COUNT(*) FROM favorites f WHERE f.game_id = games.id);

CREATE TRIGGER trg_favorites_insert AFTER INSERT ON favorites BEGIN
    UPDATE games SET favorites_count = favorites_count + 1 WHERE id = NEW.game_id;
END;
CREATE TRIGGER trg_favorites_delete AFTER DELETE ON favorites BEGIN
    UPDATE games SET favorites_count = favorites_count - 1 WHERE id = OLD.game_id;
END;

-- sort=top: the Bayesian-style average (prior 3.0, weight 2) as an indexable generated column.
ALTER TABLE games ADD COLUMN rating_score REAL
    GENERATED ALWAYS AS ((rating_sum + 6.0) / (rating_count + 2.0)) VIRTUAL;

-- Replace the published listing indices with ones that also cover the tie-breakers.
DROP INDEX idx_games_published_created;
DROP INDEX idx_games_published_plays;
CREATE INDEX idx_games_pub_new   ON games(published, created_at DESC, id);
CREATE INDEX idx_games_pub_plays ON games(published, plays DESC, created_at DESC, id);
CREATE INDEX idx_games_pub_favs  ON games(published, favorites_count DESC, created_at DESC, id);
CREATE INDEX idx_games_pub_top
    ON games(published, rating_score DESC, rating_count DESC, created_at DESC, id);

-- owner=<username> (resolved to an id first) and the public profile games list.
CREATE INDEX idx_games_owner_pub_new ON games(owner_id, published, created_at DESC, id);
-- owner=me and the owner's own profile list (published and unpublished).
DROP INDEX idx_games_owner_created;
CREATE INDEX idx_games_owner_new ON games(owner_id, created_at DESC, id);

-- tag= : drive the lookup from the tag (covering: no table access for game_id).
DROP INDEX idx_game_tags_tag;
CREATE INDEX idx_game_tags_tag_game ON game_tags(tag, game_id);
-- Per-game ordered tag list (GAME_SELECT's group_concat) without a per-row sort.
CREATE INDEX idx_game_tags_game_pos ON game_tags(game_id, position, tag);
