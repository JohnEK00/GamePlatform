-- v2: roles, favorites, achievements, cloud saves, play events, reports.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

CREATE TABLE favorites (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, game_id)
);
CREATE INDEX idx_favorites_game         ON favorites(game_id);
CREATE INDEX idx_favorites_user_created ON favorites(user_id, created_at DESC);

-- Achievement definitions of the CURRENT bundle version (synced on upload/replace).
CREATE TABLE achievements (
    game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ach_id       TEXT NOT NULL,
    position     INTEGER NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    icon         TEXT,
    PRIMARY KEY (game_id, ach_id)
);

-- Unlocks disappear when their definition is removed by a bundle replace.
CREATE TABLE user_achievements (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id      TEXT NOT NULL,
    ach_id       TEXT NOT NULL,
    unlocked_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, game_id, ach_id),
    FOREIGN KEY (game_id, ach_id) REFERENCES achievements(game_id, ach_id) ON DELETE CASCADE
);
CREATE INDEX idx_user_achievements_user ON user_achievements(user_id, unlocked_at DESC);
CREATE INDEX idx_user_achievements_game ON user_achievements(game_id, ach_id);

CREATE TABLE saves (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    data        TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, game_id)
);
CREATE INDEX idx_saves_game ON saves(game_id);

CREATE TABLE play_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    day         TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_play_events_game_day ON play_events(game_id, day);

-- Reports outlive their targets (a resolved "delete" removes the target), so no FK on target.
CREATE TABLE reports (
    id              TEXT PRIMARY KEY NOT NULL,
    target_type     TEXT NOT NULL CHECK (target_type IN ('game', 'comment')),
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
CREATE INDEX idx_reports_status_created ON reports(status, created_at DESC);
CREATE INDEX idx_reports_target         ON reports(target_type, target_id, status);
CREATE INDEX idx_reports_reporter       ON reports(reporter_id, target_type, target_id, status);
