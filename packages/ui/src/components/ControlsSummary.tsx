import { useId, useMemo } from "react";
import type { ControlAction } from "../api/types";
import {
  effectiveActions,
  gamepadLabel,
  hasControls,
  keyLabel,
  normalizeActions,
  PLAYER_CONTROLS_EVENT,
  useKeyboardLayout,
  useStoredBindings,
} from "../controls";

export type ControlsSummaryProps = {
  game: { id: string; actions?: ControlAction[]; controlsHint?: string };
  className?: string;
};

/**
 * Game page "Controls" section (F009 § 2.3): the hint and a compact read-only list of the bindings in effect on this
 * device, updated live. "Customize" opens the mounted player's controls panel. Renders nothing when the game has
 * neither actions nor a hint.
 */
export function ControlsSummary({ game, className = "" }: ControlsSummaryProps) {
  const headingId = useId();
  const defaults = useMemo(() => normalizeActions(game.actions), [game.actions]);
  const hint = (game.controlsHint ?? "").trim();
  const bindings = useStoredBindings(game.id);
  const layout = useKeyboardLayout();
  const effective = useMemo(() => effectiveActions(defaults, bindings.keys, bindings.gamepad), [defaults, bindings]);
  if (!hasControls(defaults, hint)) return null;

  return (
    <section className={`pf-panel pf-controls-summary ${className}`} aria-labelledby={headingId}>
      <div className="pf-controls-summary__head">
        <h2 className="pf-panel__title" id={headingId}>
          Controls
        </h2>
        {defaults.length > 0 && (
          <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm" onClick={() => window.dispatchEvent(new CustomEvent(PLAYER_CONTROLS_EVENT))}>
            ⌨ Customize
          </button>
        )}
      </div>
      {hint && <p className="pf-controls-summary__hint">{hint}</p>}
      {effective.length > 0 && (
        <ul className="pf-controls-summary__list">
          {effective.map((a) => {
            const keys = a.keys.map((k) => keyLabel(k, layout)).join(", ");
            const pad = a.gamepad.map(gamepadLabel).join(", ");
            const text = [keys, pad].filter(Boolean).join(" · ") || "Unbound";
            return (
              <li key={a.id}>
                <span className="pf-controls-summary__name">{a.name}</span>
                {" — "}
                <span className={`pf-controls-summary__keys${text === "Unbound" ? " is-unbound" : ""}`}>{text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
