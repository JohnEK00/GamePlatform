-- F005: screenshots, and reports on screenshots.

CREATE TABLE screenshots (
    id            TEXT PRIMARY KEY NOT NULL,
    game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    caption       TEXT NOT NULL DEFAULT '',            -- plain text, <= 140 chars (validated in Rust)
    ext           TEXT NOT NULL CHECK (ext IN ('png', 'jpg')),
    width         INTEGER NOT NULL CHECK (width BETWEEN 64 AND 4096),
    height        INTEGER NOT NULL CHECK (height BETWEEN 64 AND 4096),
    bytes         INTEGER NOT NULL,                    -- stored full-image size
    game_version  INTEGER NOT NULL,
    created_at    TEXT NOT NULL                        -- RFC3339 millis Z
);
CREATE INDEX idx_screenshots_game_created ON screenshots(game_id, created_at DESC, id);
CREATE INDEX idx_screenshots_author_game  ON screenshots(author_id, game_id);

-- Widen reports.target_type to include 'screenshot' (SQLite can't alter a CHECK: rebuild).
-- No table references reports, and reports has no triggers, so the rebuild is safe with
-- foreign_keys on. All rows are copied as-is and the three indices are recreated.
CREATE TABLE reports_new (
    id              TEXT PRIMARY KEY NOT NULL,
    target_type     TEXT NOT NULL CHECK (target_type IN ('game', 'comment', 'screenshot')),
    target_id       TEXT NOT NULL,
    target_game_id  TEXT NOT NULL,
    target_preview  TEXT NOT NULL,
    reason          TEXT NOT NULL,
    details         TEXT NOT NULL DEFAULT '',
    reporter_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolution      TEXT,
    created_at      TEXT NOT NULL,
    resolved_at     TEXT
);
INSERT INTO reports_new SELECT id, target_type, target_id, target_game_id, target_preview, reason,
                               details, reporter_id, status, resolution, created_at, resolved_at
FROM reports ORDER BY rowid; -- keeps rowid order (the admin list's tie-break)
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX idx_reports_status_created ON reports(status, created_at DESC);
CREATE INDEX idx_reports_target         ON reports(target_type, target_id, status);
CREATE INDEX idx_reports_reporter       ON reports(reporter_id, target_type, target_id, status);
