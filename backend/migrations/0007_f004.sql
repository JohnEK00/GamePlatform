-- F004: version changelogs and an "Updated" badge (docs/ARCHITECTURE.md § F004 additions).

CREATE TABLE game_versions (
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL CHECK (version >= 1),
    notes       TEXT NOT NULL DEFAULT '',             -- plain text, <= 1000 chars (validated in Rust)
    created_at  TEXT NOT NULL,                        -- RFC3339 millis Z
    PRIMARY KEY (game_id, version)
);

ALTER TABLE games ADD COLUMN last_updated_at TEXT;   -- latest bundle replace while published; NULL if none
ALTER TABLE activity_events ADD COLUMN from_version INTEGER;   -- gameUpdated: lowest covered version; NULL = version

-- Backfill last_updated_at from F002's gameUpdated events (only published replaces produce them).
UPDATE games SET last_updated_at = (
    SELECT MAX(e.created_at) FROM activity_events e
    WHERE e.game_id = games.id AND e.kind = 'gameUpdated'
);

-- Backfill: one row for each game's current version (no notes; date approximate).
INSERT INTO game_versions (game_id, version, notes, created_at)
SELECT id, version, '',
       CASE WHEN version = 1 THEN created_at
            ELSE COALESCE(last_updated_at, updated_at) END
FROM games;
