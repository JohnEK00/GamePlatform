-- F009: controls overlay and key remapping (docs/ARCHITECTURE.md § F009 additions).
-- Both columns are per current version, like score_order/score_format/score_label (F001).
-- NULL = not yet backfilled (src/controls_backfill.rs fills them at startup).
ALTER TABLE games ADD COLUMN actions_json  TEXT;   -- normalised ControlAction[] as compact JSON; '[]' when none; NULL = not yet backfilled
ALTER TABLE games ADD COLUMN controls_hint TEXT;   -- normalised game.json `controls`, <= 300 chars; '' when none; NULL = not yet backfilled
