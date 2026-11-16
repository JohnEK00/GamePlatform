-- Review round 4 (docs/reviews/REVIEW-2026-11-15-4.md): F007 write-path fixes.

-- L1: un-heart / unfollow tombstones the actor's event in the unread group instead of deleting
-- it. Reads ignore retracted events; a re-heart / re-follow clears the tombstone without
-- bumping the notification's updated_at, so toggling never re-notifies.
ALTER TABLE notification_events ADD COLUMN retracted_at TEXT;   -- NULL = live; RFC3339 millis Z

-- L3: a notification goes away with its last event (comment / actor deletes cascade events),
-- so pruning never has to scan for event-less rows. FK cascades fire this trigger too.
CREATE TRIGGER notification_events_last_gone AFTER DELETE ON notification_events
WHEN NOT EXISTS (SELECT 1 FROM notification_events WHERE notification_id = OLD.notification_id)
BEGIN
    DELETE FROM notifications WHERE id = OLD.notification_id;
END;

-- One-time cleanup of event-less rows left by the 0013 write path.
DELETE FROM notifications
WHERE NOT EXISTS (SELECT 1 FROM notification_events e WHERE e.notification_id = notifications.id);

-- L2: pending gamePublished fan-outs, written in the first-publish transaction and processed
-- in the background in follower_id order. Each chunk commits with its cursor, so a restart
-- resumes exactly where it stopped (no duplicates, no gaps).
CREATE TABLE notification_fanouts (
    game_id        TEXT PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    after_follower TEXT NOT NULL DEFAULT '',   -- last follower_id processed
    attempts       INTEGER NOT NULL DEFAULT 0, -- consecutive failed chunks (reset at startup)
    created_at     TEXT NOT NULL               -- the publish time; later follows are excluded
);
CREATE INDEX idx_follows_followee_follower ON follows(followee_id, follower_id);
