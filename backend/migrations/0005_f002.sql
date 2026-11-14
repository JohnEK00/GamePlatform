-- F002 Follow creators and an activity feed (docs/features/F002-follow-and-feed.md,
-- ARCHITECTURE.md § F002). Fan-out on read: one append-only events table, no inboxes.

CREATE TABLE follows (
    follower_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee_created ON follows(followee_id, created_at DESC);
CREATE INDEX idx_follows_follower_created ON follows(follower_id, created_at DESC);

ALTER TABLE games ADD COLUMN first_published_at TEXT;   -- NULL until first published; gamePublished fires once
UPDATE games SET first_published_at = created_at WHERE published = 1;

CREATE TABLE activity_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,      -- feed cursor
    actor_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('gamePublished','gameUpdated','personalBest','achievementUnlocked')),
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    version     INTEGER,                                -- gamePublished / gameUpdated
    score       INTEGER,                                -- personalBest
    first_score INTEGER NOT NULL DEFAULT 0,             -- personalBest: 1 = actor's first score on the game
    ach_id      TEXT,                                   -- achievementUnlocked (latest); no FK, filtered by join at read time
    ach_count   INTEGER NOT NULL DEFAULT 0,             -- achievementUnlocked: unlocks that day
    day         TEXT NOT NULL,                          -- YYYY-MM-DD UTC of created_at (coalescing key)
    created_at  TEXT NOT NULL                           -- RFC3339 millis Z
);
CREATE INDEX idx_activity_actor_id  ON activity_events(actor_id, id DESC);
CREATE INDEX idx_activity_game_kind ON activity_events(game_id, kind, id DESC);
CREATE INDEX idx_activity_coalesce  ON activity_events(actor_id, game_id, kind, day);

-- Backfill: one gamePublished per currently published game, oldest first (ids follow created_at).
INSERT INTO activity_events (actor_id, kind, game_id, version, day, created_at)
SELECT owner_id, 'gamePublished', id, version, substr(created_at, 1, 10), created_at
FROM games WHERE published = 1 ORDER BY created_at;
