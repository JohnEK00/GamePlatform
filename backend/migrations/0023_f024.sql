-- F024: "screenshot of your game" notifications (docs/ARCHITECTURE.md § F024 additions).

-- 1. The screenshot of a screenshotPosted event (NULL for every other kind). Deleting the screenshot
--    deletes the event; the 0014 trigger then deletes a notification left without events.
--    ADD COLUMN with REFERENCES is allowed because the default is NULL.
ALTER TABLE notification_events ADD COLUMN screenshot_id TEXT REFERENCES screenshots(id) ON DELETE CASCADE;
CREATE INDEX idx_notification_events_screenshot ON notification_events(screenshot_id) WHERE screenshot_id IS NOT NULL;

-- 2. One event per screenshot: append screenshot_id to the dedupe key, so two screenshots by one author in one
--    unread group are two events (with the 0013 key the second INSERT OR IGNORE would be dropped). The new key is
--    strictly finer than the old one, so existing rows can't violate it.
DROP INDEX idx_notification_events_dedupe;
CREATE UNIQUE INDEX idx_notification_events_dedupe ON notification_events(notification_id, actor_id, IFNULL(comment_id, ''), IFNULL(screenshot_id, ''));

-- 3. The screenshotPosted kind's setting.
ALTER TABLE notification_settings ADD COLUMN screenshots INTEGER NOT NULL DEFAULT 1 CHECK (screenshots IN (0, 1));
