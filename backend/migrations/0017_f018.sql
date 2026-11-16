-- F018: notification controls (docs/ARCHITECTURE.md § F018 additions).

-- 1. Mutes.
CREATE TABLE notification_mutes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,                    -- list tie-break only; not exposed
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, -- the muted game, or the muted thread's game
    thread_id  TEXT REFERENCES comments(id) ON DELETE CASCADE,       -- NULL = game mute; else a top-level comment of game_id
    created_at TEXT NOT NULL                                         -- RFC3339 millis Z
);
-- One row per target; its (user_id, game_id) prefix serves the write-path mute check.
CREATE UNIQUE INDEX idx_notification_mutes_target ON notification_mutes(user_id, game_id, IFNULL(thread_id, ''));
CREATE INDEX idx_notification_mutes_user_created  ON notification_mutes(user_id, created_at DESC, id DESC);     -- the list
CREATE INDEX idx_notification_mutes_game          ON notification_mutes(game_id);                               -- game delete cascade
CREATE INDEX idx_notification_mutes_thread        ON notification_mutes(thread_id) WHERE thread_id IS NOT NULL; -- comment delete cascade, thread unmute

-- 2. The "pinned" kind's setting.
ALTER TABLE notification_settings ADD COLUMN pins INTEGER NOT NULL DEFAULT 1 CHECK (pins IN (0, 1));

-- 3. Rebuild notifications without the kind CHECK (kinds are validated in Rust: notifications::Kind).
--    This runs inside sqlx's migration transaction with foreign_keys = ON, which can't be switched off
--    inside a transaction. With FKs on, DROP TABLE runs an implicit DELETE that fires ON DELETE CASCADE
--    actions, so the old parent must never be dropped while a child table references it:
--      a. drop the 0014 trigger first (no step below may fire it; it is recreated in step 4);
--      b. copy the parent, then copy the child into a new child that references the NEW parent;
--      c. drop the old child, then the old parent (nothing references it any more, so nothing cascades);
--      d. rename. SQLite >= 3.26 (legacy_alter_table OFF; sqlx 0.8 bundles a newer SQLite) rewrites
--         notification_events_new's REFERENCES notifications_new(id) to notifications(id) and renames
--         the sqlite_sequence rows.
DROP TRIGGER notification_events_last_gone;

CREATE TABLE notifications_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,      -- Notification.id; stable
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,                          -- notifications::Kind::as_str (validated in Rust; no CHECK)
    group_key    TEXT NOT NULL,
    game_id      TEXT REFERENCES games(id) ON DELETE CASCADE,      -- NULL only for 'follow'
    comment_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,   -- 'heart': hearted comment; 'reply': thread root; 'pinned': pinned comment; else NULL
    read_at      TEXT,                                   -- NULL = unread; RFC3339 millis Z
    created_at   TEXT NOT NULL,                          -- first event
    updated_at   TEXT NOT NULL                           -- latest event (ordering key)
);
INSERT INTO notifications_new (id, recipient_id, kind, group_key, game_id, comment_id, read_at, created_at, updated_at)
SELECT id, recipient_id, kind, group_key, game_id, comment_id, read_at, created_at, updated_at
FROM notifications ORDER BY id;

CREATE TABLE notification_events_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications_new(id) ON DELETE CASCADE,
    actor_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment_id      TEXT REFERENCES comments(id) ON DELETE CASCADE,   -- 'comment'/'reply': the new comment; else NULL
    created_at      TEXT NOT NULL,
    retracted_at    TEXT                                              -- NULL = live; RFC3339 millis Z (0014 L1)
);
INSERT INTO notification_events_new (id, notification_id, actor_id, comment_id, created_at, retracted_at)
SELECT id, notification_id, actor_id, comment_id, created_at, retracted_at
FROM notification_events ORDER BY id;

-- Carry the AUTOINCREMENT high-water marks over, so ids of deleted rows are never reused
-- (clients dedupe notifications by id). The copies above only set the new sequences to MAX(id).
DELETE FROM sqlite_sequence WHERE name IN ('notifications_new', 'notification_events_new');
INSERT INTO sqlite_sequence (name, seq)
SELECT name || '_new', seq FROM sqlite_sequence WHERE name IN ('notifications', 'notification_events');

DROP TABLE notification_events;   -- the old child: nothing references it and its trigger is gone
DROP TABLE notifications;         -- the old parent: no table references it any more, so no cascade runs
ALTER TABLE notifications_new RENAME TO notifications;
ALTER TABLE notification_events_new RENAME TO notification_events;

-- 4. Indexes (identical to 0013) and the 0014 trigger.
CREATE UNIQUE INDEX idx_notifications_open_group ON notifications(recipient_id, kind, group_key) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_group             ON notifications(recipient_id, kind, group_key);
CREATE INDEX idx_notifications_recipient_updated ON notifications(recipient_id, updated_at DESC, id DESC);
CREATE INDEX idx_notifications_game     ON notifications(game_id)    WHERE game_id IS NOT NULL;
CREATE INDEX idx_notifications_comment  ON notifications(comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX idx_notifications_read_at  ON notifications(read_at)    WHERE read_at IS NOT NULL;
CREATE INDEX idx_notifications_updated  ON notifications(updated_at);

CREATE UNIQUE INDEX idx_notification_events_dedupe  ON notification_events(notification_id, actor_id, IFNULL(comment_id, ''));
CREATE INDEX idx_notification_events_actor          ON notification_events(actor_id);
CREATE INDEX idx_notification_events_comment        ON notification_events(comment_id) WHERE comment_id IS NOT NULL;

CREATE TRIGGER notification_events_last_gone AFTER DELETE ON notification_events
WHEN NOT EXISTS (SELECT 1 FROM notification_events WHERE notification_id = OLD.notification_id)
BEGIN
    DELETE FROM notifications WHERE id = OLD.notification_id;
END;
