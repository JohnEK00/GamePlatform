-- F032 (+ F029): featured games on profiles, and indexes for the home page reads (docs/ARCHITECTURE.md § F032 additions).

-- 1. F029: up to 4 featured games per user (the limit is enforced in Rust), in display order.
CREATE TABLE profile_featured (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,                                      -- 0..3, display order
    created_at TEXT NOT NULL,                                         -- RFC3339 millis Z
    PRIMARY KEY (user_id, game_id)
);
CREATE INDEX idx_profile_featured_game ON profile_featured(game_id);   -- game-delete cascade

-- 2. GET /api/games?sort=updated (filter last_updated_at IS NOT NULL, order last_updated_at DESC, id).
CREATE INDEX idx_games_pub_updated ON games(published, last_updated_at DESC, id) WHERE last_updated_at IS NOT NULL;

-- 3. GET /api/collections (public, updated_at DESC, id DESC).
CREATE INDEX idx_collections_public_updated ON collections(updated_at DESC, id DESC) WHERE visibility = 'public';
