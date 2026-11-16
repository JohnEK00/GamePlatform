-- F007: in-app notifications (docs/ARCHITECTURE.md § F007 additions).

CREATE TABLE notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,      -- Notification.id; stable
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('comment','reply','heart','follow','gamePublished')),
    group_key    TEXT NOT NULL,
    game_id      TEXT REFERENCES games(id) ON DELETE CASCADE,      -- NULL only for 'follow'
    comment_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,   -- 'heart': the hearted comment; 'reply': the thread root; else NULL
    read_at      TEXT,                                   -- NULL = unread; RFC3339 millis Z
    created_at   TEXT NOT NULL,                          -- first event
    updated_at   TEXT NOT NULL                           -- latest event (ordering key)
);
-- At most one UNREAD group per (recipient, kind, group): the upsert's conflict target, and the unread count's index.
CREATE UNIQUE INDEX idx_notifications_open_group ON notifications(recipient_id, kind, group_key) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_group             ON notifications(recipient_id, kind, group_key);   -- dedupe across read states
CREATE INDEX idx_notifications_recipient_updated ON notifications(recipient_id, updated_at DESC, id DESC);
CREATE INDEX idx_notifications_game     ON notifications(game_id)    WHERE game_id IS NOT NULL;     -- game delete cascade
CREATE INDEX idx_notifications_comment  ON notifications(comment_id) WHERE comment_id IS NOT NULL;  -- comment delete cascade
CREATE INDEX idx_notifications_read_at  ON notifications(read_at)    WHERE read_at IS NOT NULL;     -- pruning
CREATE INDEX idx_notifications_updated  ON notifications(updated_at);                               -- pruning

CREATE TABLE notification_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    actor_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment_id      TEXT REFERENCES comments(id) ON DELETE CASCADE,   -- 'comment'/'reply': the new comment; else NULL
    created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_notification_events_dedupe  ON notification_events(notification_id, actor_id, IFNULL(comment_id, ''));
CREATE INDEX idx_notification_events_actor          ON notification_events(actor_id);                               -- user delete cascade
CREATE INDEX idx_notification_events_comment        ON notification_events(comment_id) WHERE comment_id IS NOT NULL; -- comment delete cascade

CREATE TABLE notification_settings (            -- no row = everything on
    user_id    TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comments   INTEGER NOT NULL DEFAULT 1 CHECK (comments  IN (0, 1)),
    replies    INTEGER NOT NULL DEFAULT 1 CHECK (replies   IN (0, 1)),
    hearts     INTEGER NOT NULL DEFAULT 1 CHECK (hearts    IN (0, 1)),
    follows    INTEGER NOT NULL DEFAULT 1 CHECK (follows   IN (0, 1)),
    new_games  INTEGER NOT NULL DEFAULT 1 CHECK (new_games IN (0, 1)),
    updated_at TEXT NOT NULL
);
