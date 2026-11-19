-- F031: post replies and hearts (docs/ARCHITECTURE.md § F031 additions).

-- 1. Post counters and the reply lock. Counters are maintained by the triggers below; never write them directly.
ALTER TABLE posts ADD COLUMN hearts      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN locked_at   TEXT;                         -- NULL = replies on; RFC3339 millis Z

-- 2. Hearts (one per user and post). Never use INSERT OR REPLACE here: its implicit delete skips the trigger.
CREATE TABLE post_hearts (
    post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,                                         -- RFC3339 millis Z
    PRIMARY KEY (post_id, user_id)
);
CREATE INDEX idx_post_hearts_user ON post_hearts(user_id);           -- user-delete cascade
CREATE TRIGGER trg_post_hearts_insert AFTER INSERT ON post_hearts
BEGIN
    UPDATE posts SET hearts = hearts + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER trg_post_hearts_delete AFTER DELETE ON post_hearts
BEGIN
    UPDATE posts SET hearts = hearts - 1 WHERE id = OLD.post_id;
END;

-- 3. Replies: one flat thread per post, oldest first (created_at, then rowid).
CREATE TABLE post_replies (
    id               TEXT PRIMARY KEY,                                         -- UUID v4
    post_id          TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reply_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,             -- "Replying to @x"; NULL = answering the post
    body             TEXT NOT NULL,                                            -- routes::posts::validate_post_body
    created_at       TEXT NOT NULL                                             -- RFC3339 millis Z
);
CREATE INDEX idx_post_replies_post_created ON post_replies(post_id, created_at);   -- the thread (rowid tie-break), cap count
CREATE INDEX idx_post_replies_author       ON post_replies(author_id);              -- user-delete cascade
CREATE INDEX idx_post_replies_reply_to     ON post_replies(reply_to_user_id) WHERE reply_to_user_id IS NOT NULL;   -- SET NULL
CREATE TRIGGER trg_post_replies_insert AFTER INSERT ON post_replies
BEGIN
    UPDATE posts SET reply_count = reply_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER trg_post_replies_delete AFTER DELETE ON post_replies
BEGIN
    UPDATE posts SET reply_count = reply_count - 1 WHERE id = OLD.post_id;
END;

-- 4. Notifications. ADD COLUMN with REFERENCES is allowed because the default is NULL.
ALTER TABLE notifications ADD COLUMN post_id TEXT REFERENCES posts(id) ON DELETE CASCADE;          -- postReply / postHeart
CREATE INDEX idx_notifications_post ON notifications(post_id) WHERE post_id IS NOT NULL;
ALTER TABLE notification_events ADD COLUMN post_reply_id TEXT REFERENCES post_replies(id) ON DELETE CASCADE;   -- postReply
CREATE INDEX idx_notification_events_post_reply ON notification_events(post_reply_id) WHERE post_reply_id IS NOT NULL;
--    One event per reply: append post_reply_id to the dedupe key (strictly finer than the 0023 key, so existing rows fit).
DROP INDEX idx_notification_events_dedupe;
CREATE UNIQUE INDEX idx_notification_events_dedupe ON notification_events(notification_id, actor_id, IFNULL(comment_id, ''), IFNULL(screenshot_id, ''), IFNULL(post_reply_id, ''));
ALTER TABLE notification_settings ADD COLUMN post_replies INTEGER NOT NULL DEFAULT 1 CHECK (post_replies IN (0, 1));
ALTER TABLE notification_settings ADD COLUMN post_hearts  INTEGER NOT NULL DEFAULT 1 CHECK (post_hearts IN (0, 1));

-- 5. Reports: the post of a post / postReply report (no FK, like target_game_id).
ALTER TABLE reports ADD COLUMN target_post_id TEXT;
UPDATE reports SET target_post_id = target_id WHERE target_type = 'post';
