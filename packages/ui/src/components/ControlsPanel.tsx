import { useId, useMemo } from "react";
import type { ControlAction } from "../api/types";
import {
  effectiveActions,
  findConflicts,
  gamepadLabel,
  hasCtrlShortcutRisk,
  isActionChanged,
  MAX_ACTION_KEYS,
  useKeyboardLayout,
  type ControlOverrides,
} from "../controls";
import { KeyCaptureButton } from "./KeyCaptureButton";
import { useModal } from "./useModal";

export type ControlsPanelProps = {
  /** "player": changes are saved on this device. "studio": kept in memory for the Studio session. */
  mode: "player" | "studio";
  /** Game title (subtitle). */
  title: string;
  /** Normalised `controlsHint` (plain text). */
  hint?: string;
  /** The game's declared actions (defaults), in manifest order. */
  actions: readonly ControlAction[];
  /** Current overrides (action id → keys). */
  overrides: ControlOverrides;
  /** Every change is applied at once: the parent stores it and posts `webgame:controls`. */
  onChange: (overrides: ControlOverrides) => void;
  onClose: () => void;
};

function withKeys(overrides: ControlOverrides, action: ControlAction, keys: string[]): ControlOverrides {
  const rest = Object.fromEntries(Object.entries(overrides).filter(([id]) => id !== action.id));
  const same = keys.length === action.keys.length && keys.every((k, i) => k === action.keys[i]);
  return same ? rest : { ...rest, [action.id]: keys };
}

/**
 * The ⌨ controls dialog (F009 § 2.2): the hint text, then one row per action with three key slots and the read-only
 * gamepad buttons. Conflicts are warnings, never blocking. Labels follow the parent's keyboard layout when the
 * browser exposes it.
 */
export function ControlsPanel({ mode, title, hint, actions, overrides, onChange, onClose }: ControlsPanelProps) {
  const uid = useId();
  const ref = useModal<HTMLDivElement>(true, onClose, { initialFocus: "[data-autofocus]" });
  const layout = useKeyboardLayout();
  const effective = useMemo(() => effectiveActions(actions, overrides), [actions, overrides]);
  const conflicts = useMemo(() => findConflicts(effective), [effective]);
  const ctrlRisk = hasCtrlShortcutRisk(effective);
  const nameOf = (id: string) => actions.find((a) => a.id === id)?.name ?? id;
  const anyChanged = actions.some((a) => isActionChanged(a, overrides));
  const hintText = (hint ?? "").trim();

  const setKeys = (index: number, keys: string[]) => onChange(withKeys(overrides, actions[index], keys));

  const assign = (index: number, slot: number, code: string) => {
    const cur = effective[index].keys;
    const slots: (string | null)[] = Array.from({ length: MAX_ACTION_KEYS }, (_, i) => cur[i] ?? null);
    // A code already in another slot of this action moves here.
    for (let i = 0; i < slots.length; i++) if (i !== slot && slots[i] === code) slots[i] = null;
    slots[Math.min(slot, cur.length)] = code;
    setKeys(index, slots.filter((k): k is string => k !== null));
  };
  const clear = (index: number, slot: number) => setKeys(index, effective[index].keys.filter((_, i) => i !== slot));
  const resetRow = (index: number) => onChange(withKeys(overrides, actions[index], actions[index].keys));

  return (
    <div className="pf-modal-backdrop pf-controls-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pf-modal pf-controls" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-sub`} ref={ref}>
        <div className="pf-controls__head">
          <div>
            <h2 id={`${uid}-title`}>Controls</h2>
            <p id={`${uid}-sub`} className="pf-controls__sub">
              {title}
            </p>
          </div>
          <button type="button" className="pf-iconbtn pf-iconbtn--sm" aria-label="Close" title="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {hintText && <p className="pf-controls__hint">{hintText}</p>}

        {effective.length > 0 && (
          <div className="pf-controls__scroll">
            <table className="pf-controls__table">
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Keys</th>
                  <th scope="col">Gamepad</th>
                </tr>
              </thead>
              <tbody>
                {effective.map((a, i) => {
                  const others = conflicts[a.id];
                  const changed = isActionChanged(actions[i], overrides);
                  const unbound = a.keys.length === 0 && a.gamepad.length === 0;
                  const warnId = `${uid}-warn-${i}`;
                  const warn = others?.length || unbound;
                  return (
                    <tr key={a.id} className={changed ? "is-changed" : undefined} aria-describedby={warn ? warnId : undefined}>
                      <th scope="row" className="pf-controls__name">
                        <span>{a.name}</span>
                        {changed && <span className="pf-controls__tag">Changed</span>}
                        {warn ? (
                          <span id={warnId} className="pf-controls__warn">
                            {unbound ? "Unbound" : `Also used by ${others!.map(nameOf).join(", ")}`}
                          </span>
                        ) : null}
                      </th>
                      <td>
                        <div className="pf-controls__keys">
                          {Array.from({ length: MAX_ACTION_KEYS }, (_, s) => (
                            <KeyCaptureButton
                              key={s}
                              code={a.keys[s] ?? null}
                              actionName={a.name}
                              slot={s}
                              layout={layout}
                              onAssign={(code) => assign(i, s, code)}
                              onClear={() => clear(i, s)}
                            />
                          ))}
                          {changed && (
                            <button type="button" className="pf-linkbtn pf-controls__reset" onClick={() => resetRow(i)} aria-label={`Reset ${a.name}`}>
                              Reset
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="pf-controls__pad">{a.gamepad.length ? a.gamepad.map(gamepadLabel).join(", ") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {ctrlRisk && (
          <p className="pf-controls__note pf-controls__note--warn" role="note">
            Browsers may close or open tabs on Ctrl+W, Ctrl+T or Ctrl+N
          </p>
        )}

        <div className="pf-controls__foot">
          {anyChanged && (
            <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm" onClick={() => onChange({})}>
              Reset all
            </button>
          )}
          {effective.length > 0 && <span className="pf-muted pf-small pf-controls__saved">{mode === "studio" ? "Kept for this Studio session" : "Saved on this device"}</span>}
          <button type="button" className="pf-btn pf-btn--primary pf-btn--sm" onClick={onClose} data-autofocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
