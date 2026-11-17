-- F021: collection activity (docs/ARCHITECTURE.md § F021 additions).

-- 1. Rebuild activity_events: no kind CHECK (validated in Rust: activity::KINDS), nullable game_id,
--    and the collection columns. No table references activity_events and it has no triggers
--    (checked against 0001–0017), so dropping the old table cascades nothing with foreign_keys ON.
--    Columns keep their 0005/0007 order; the new ones are appended.
CREATE TABLE activity_events_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,      -- feed cursor
    actor_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                          -- activity::KINDS (validated in Rust; no CHECK)
    game_id       TEXT REFERENCES games(id) ON DELETE CASCADE,          -- NULL only for collectionUpdated
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
    CHECK (game_id IS NOT NULL OR collection_id IS NOT NULL)
);
INSERT INTO activity_events_new (id, actor_id, kind, game_id, version, score, first_score, ach_id,
                                 ach_count, day, created_at, from_version)
SELECT id, actor_id, kind, game_id, version, score, first_score, ach_id,
       ach_count, day, created_at, from_version
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
-- collectionUpdated coalescing + the collection delete cascade.
CREATE INDEX idx_activity_collection ON activity_events(collection_id, kind, day) WHERE collection_id IS NOT NULL;

-- 2. Notifications: the collection of an addedToCollection notification (NULL for every other kind).
--    ADD COLUMN with REFERENCES is allowed because the default is NULL.
ALTER TABLE notifications ADD COLUMN collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE;
CREATE INDEX idx_notifications_collection ON notifications(collection_id) WHERE collection_id IS NOT NULL;

-- 3. The addedToCollection kind's setting.
ALTER TABLE notification_settings ADD COLUMN collections INTEGER NOT NULL DEFAULT 1 CHECK (collections IN (0, 1));
