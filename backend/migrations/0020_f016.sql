-- F016: synced control bindings (docs/ARCHITECTURE.md § F016 additions).
CREATE TABLE control_bindings (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    bindings    TEXT NOT NULL,   -- normalised ControlBindings as compact JSON, e.g. {"keys":{},"gamepad":{"jump":["B"]}}
    updated_at  TEXT NOT NULL,   -- RFC3339
    PRIMARY KEY (user_id, game_id)
);
CREATE INDEX idx_control_bindings_game ON control_bindings(game_id);   -- cascade deletes per game
