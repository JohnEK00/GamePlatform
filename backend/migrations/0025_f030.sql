-- F030: user posts (docs/ARCHITECTURE.md § F030 additions).

-- 1. Posts: public, plain text (validated in Rust: routes::posts::validate_post_body).
--    attachment_type is 'game' | 'collection' | NULL (validated in Rust; no CHECK, like the other
--    kind columns). The target column is SET NULL when its target is deleted, so the type survives
--    and clients show "no longer available".
CREATE TABLE posts (
    id              TEXT PRIMARY KEY,                                      -- UUID v4
    author_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    attachment_type TEXT,                                                  -- NULL = no attachment
    game_id         TEXT REFERENCES games(id) ON DELETE SET NULL,          -- attachment_type 'game'
    collection_id   TEXT REFERENCES collections(id) ON DELETE SET NULL,    -- attachment_type 'collection'
    created_at      TEXT NOT NULL,                                         -- RFC3339 millis Z
    CHECK (game_id IS NULL OR collection_id IS NULL)
);
-- The profile list (an author's posts, newest first, no temp B-tree) and the 24-hour cap count.
CREATE INDEX idx_posts_author_created ON posts(author_id, created_at DESC, id);
-- ON DELETE SET NULL lookups when a game or collection is deleted.
CREATE INDEX idx_posts_game       ON posts(game_id)       WHERE game_id IS NOT NULL;
CREATE INDEX idx_posts_collection ON posts(collection_id) WHERE collection_id IS NOT NULL;

-- 2. Rebuild activity_events (the 0019 layout + post_id; the CHECK gains post_id).
--    Columns keep their 0019 order; post_id is appended.
CREATE TABLE activity_events_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,      -- feed cursor
    actor_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                          -- activity::KINDS (validated in Rust; no CHECK)
    game_id       TEXT REFERENCES games(id) ON DELETE CASCADE,          -- NULL for collectionUpdated and postCreated
    version       INTEGER,                                -- gamePublished / gameUpdated
    score         INTEGER,                                -- personalBest
    first_score   INTEGER NOT NULL DEFAULT 0,             -- personalBest: 1 = actor's first score on the game
    ach_id        TEXT,                                   -- achievementUnlocked (latest)
    ach_count     INTEGER NOT NULL DEFAULT 0,             -- achievementUnlocked: unlocks that day
    day           TEXT NOT NULL,                          -- YYYY-MM-DD UTC of created_at (coalescing key)
    created_at    TEXT NOT NULL,                          -- RFC3339 millis Z
    from_version  INTEGER,                                -- gameUpdated (F004)
    collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,    -- collectionUpdated
    game_ids      TEXT,                                   -- collectionUpdated: JSON array of game ids, newest first, <= 100
    post_id       TEXT REFERENCES posts(id) ON DELETE CASCADE,          -- postCreated (F030)
    CHECK (game_id IS NOT NULL OR collection_id IS NOT NULL OR post_id IS NOT NULL)
);
INSERT INTO activity_events_new (id, actor_id, kind, game_id, version, score, first_score, ach_id,
                                 ach_count, day, created_at, from_version, collection_id, game_ids)
SELECT id, actor_id, kind, game_id, version, score, first_score, ach_id,
       ach_count, day, created_at, from_version, collection_id, game_ids
FROM activity_events ORDER BY id;

-- Carry the AUTOINCREMENT high-water mark over (feed cursors are ids; coalescing deletes rows,
-- so MAX(id) can be below the sequence).
DELETE FROM sqlite_sequence WHERE name = 'activity_events_new';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'activity_events_new', seq FROM sqlite_sequence WHERE name = 'activity_events';

DROP TABLE activity_events;       -- also removes its sqlite_sequence row
ALTER TABLE activity_events_new RENAME TO activity_events;   -- renames the sqlite_sequence row too

CREATE INDEX idx_activity_actor_id   ON activity_events(actor_id, id DESC);
CREATE INDEX idx_activity_game_kind  ON activity_events(game_id, kind, id DESC);
CREATE INDEX idx_activity_coalesce   ON activity_events(actor_id, game_id, kind, day);
CREATE INDEX idx_activity_collection ON activity_events(collection_id, kind, day) WHERE collection_id IS NOT NULL;
-- F030: the post delete cascade.
CREATE INDEX idx_activity_post       ON activity_events(post_id) WHERE post_id IS NOT NULL;
