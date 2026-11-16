-- F008: collections, and reports on collections (docs/ARCHITECTURE.md § F008 additions).
CREATE TABLE collections (
    id           TEXT PRIMARY KEY NOT NULL,                          -- UUID v4
    owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,                                      -- 1–60 chars (validated in Rust)
    description  TEXT NOT NULL DEFAULT '',                           -- 0–500 chars, ≤ 8 lines (validated in Rust)
    visibility   TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
    created_at   TEXT NOT NULL,                                      -- RFC3339 millis Z
    updated_at   TEXT NOT NULL                                       -- RFC3339 millis Z; list order key
);
CREATE INDEX idx_collections_owner_updated ON collections(owner_id, updated_at DESC, id DESC);

CREATE TABLE collection_games (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    note          TEXT NOT NULL DEFAULT '',                          -- 0–140 chars, single line (validated in Rust)
    added_at      TEXT NOT NULL,
    PRIMARY KEY (collection_id, game_id)
);
CREATE INDEX idx_collection_games_order ON collection_games(collection_id, position, added_at);
CREATE INDEX idx_collection_games_game  ON collection_games(game_id);   -- game page shelf + game delete cascade

-- Rebuild reports: drop the target_type CHECK (types are validated in Rust from now on, so later
-- target types need no rebuild) and make target_game_id nullable (NULL for 'collection').
-- As in 0009: no table references reports and it has no triggers (checked against 0001–0015;
-- tests/f008.rs asserts both), so this is safe with foreign_keys on: the DROP's implicit delete
-- touches no child rows, and every copied reporter_id already satisfies its users FK. All rows
-- are copied as-is in rowid order and the three indices are recreated with the same definitions.
CREATE TABLE reports_new (
    id              TEXT PRIMARY KEY NOT NULL,
    target_type     TEXT NOT NULL,                                   -- 'game' | 'comment' | 'screenshot' | 'collection' (Rust TARGET_TYPES)
    target_id       TEXT NOT NULL,
    target_game_id  TEXT,                                            -- NULL for 'collection'
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
FROM reports ORDER BY rowid;   -- keeps rowid order (the admin list's tie-break)
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX idx_reports_status_created ON reports(status, created_at DESC);
CREATE INDEX idx_reports_target         ON reports(target_type, target_id, status);
CREATE INDEX idx_reports_reporter       ON reports(reporter_id, target_type, target_id, status);
