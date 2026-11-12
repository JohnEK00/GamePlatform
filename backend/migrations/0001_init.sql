-- Initial schema for WebGameApp.
CREATE TABLE users (
    id              TEXT PRIMARY KEY NOT NULL,
    username        TEXT NOT NULL,
    username_lower  TEXT NOT NULL UNIQUE,
    email           TEXT NOT NULL,
    email_lower     TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    bio             TEXT NOT NULL DEFAULT '',
    avatar_ext      TEXT,
    avatar_version  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE TABLE games (
    id                 TEXT PRIMARY KEY NOT NULL,
    owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    published          INTEGER NOT NULL DEFAULT 1,
    version            INTEGER NOT NULL DEFAULT 1,
    entry              TEXT NOT NULL,
    width              INTEGER NOT NULL,
    height             INTEGER NOT NULL,
    thumbnail_ext      TEXT,
    thumbnail_version  INTEGER NOT NULL DEFAULT 0,
    plays              INTEGER NOT NULL DEFAULT 0,
    rating_sum         INTEGER NOT NULL DEFAULT 0,
    rating_count       INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);
CREATE INDEX idx_games_published_created ON games(published, created_at DESC);
CREATE INDEX idx_games_published_plays   ON games(published, plays DESC);
CREATE INDEX idx_games_owner_created     ON games(owner_id, created_at DESC);

CREATE TABLE game_tags (
    game_id   TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, tag)
);
CREATE INDEX idx_game_tags_tag ON game_tags(tag);

CREATE TABLE ratings (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (user_id, game_id)
);
CREATE INDEX idx_ratings_game ON ratings(game_id);

CREATE TABLE comments (
    id          TEXT PRIMARY KEY NOT NULL,
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_comments_game_created ON comments(game_id, created_at DESC);

CREATE TABLE scores (
    id          TEXT PRIMARY KEY NOT NULL,
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score       INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_scores_game_score      ON scores(game_id, score DESC);
CREATE INDEX idx_scores_game_user_score ON scores(game_id, user_id, score DESC);
