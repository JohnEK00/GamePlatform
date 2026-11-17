import { useId, useMemo, useRef, useState } from "react";
import type { ControlAction, ControlBindings, GamepadButtonName } from "../api/types";
import {
  effectiveActions,
  emptyBindings,
  findConflicts,
  gamepadLabel,
  hasCtrlShortcutRisk,
  isActionChanged,
  keyLabel,
  MAX_ACTION_GAMEPAD,
  MAX_ACTION_KEYS,
  useKeyboardLayout,
} from "../controls";
import { GamepadCaptureButton } from "./GamepadCaptureButton";
import { KeyCaptureButton } from "./KeyCaptureButton";
import { useModal } from "./useModal";

/**
 * Where a player's bindings are kept, for the footer (F016 § 2.1): `"device"` (anonymous), `"account"` (signed in, last
 * sync OK or pending) or `"failed"` (signed in, the last upload failed).
 */
export type ControlsSyncState = "device" | "account" | "failed";

export type ControlsPanelProps = {
  /** "player": changes are saved on this device (and the account when signed in). "studio": kept in memory. */
  mode: "player" | "studio";
  /** Game title (subtitle). */
  title: string;
  /** Normalised `controlsHint` (plain text). */
  hint?: string;
  /** The game's declared actions (defaults), in manifest order. */
  actions: readonly ControlAction[];
  /** Current bindings (key and gamepad overrides). */
  bindings: ControlBindings;
  /** Every change is applied at once: the parent stores it and posts `webgame:controls`. */
  onChange: (bindings: ControlBindings) => void;
  /** Player mode footer. Default "device". Ignored in Studio mode. */
  syncState?: ControlsSyncState;
  onClose: () => void;
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function withEntry<T extends string>(map: Record<string, T[]>, id: string, value: T[], defaults: readonly T[]): Record<string, T[]> {
  const rest = Object.fromEntries(Object.entries(map).filter(([k]) => k !== id));
  return sameList(value, defaults) ? rest : { ...rest, [id]: value };
}

/** Puts `value` into `slot` (compacting to the filled slots); the same value in another slot moves here. */
function placeInSlot<T extends string>(current: readonly T[], slot: number, value: T, slots: number): T[] {
  const list: (T | null)[] = Array.from({ length: slots }, (_, i) => current[i] ?? null);
  for (let i = 0; i < list.length; i++) if (i !== slot && list[i] === value) list[i] = null;
  list[Math.min(slot, current.length)] = value;
  return list.filter((k): k is T => k !== null);
}

/**
 * The ⌨ controls dialog (F009 § 2.2, F016 § 2.1): the hint text, then one row per action with three key slots and two
 * gamepad slots. Changed / Reset / Unbound and conflicts cover keys and gamepad buttons. Conflicts are warnings, never
 * blocking. Key labels follow the parent's keyboard layout when the browser exposes it; controller names are never
 * shown.
 */
export function ControlsPanel({ mode, title, hint, actions, bindings, onChange, syncState = "device", onClose }: ControlsPanelProps) {
  const uid = useId();
  const ref = useModal<HTMLDivElement>(true, onClose, { initialFocus: "[data-autofocus]" });
  const layout = useKeyboardLayout();
  const effective = useMemo(() => effectiveActions(actions, bindings.keys, bindings.gamepad), [actions, bindings]);
  const conflicts = useMemo(() => findConflicts(effective), [effective]);
  const ctrlRisk = hasCtrlShortcutRisk(effective);
  const nameOf = (id: string) => actions.find((a) => a.id === id)?.name ?? id;
  const changedAt = (i: number) => isActionChanged(actions[i], bindings.keys, bindings.gamepad);
  const anyChanged = actions.some((_, i) => changedAt(i));
  const hintText = (hint ?? "").trim();
  const tableRef = useRef<HTMLTableElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  // Polite announcement of a conflict created by an assignment (review 4, L6b).
  const [live, setLive] = useState<{ text: string; n: number }>({ text: "", n: 0 });

  const withKeys = (index: number, keys: string[]): ControlBindings => ({
    ...bindings,
    keys: withEntry(bindings.keys, actions[index].id, keys, actions[index].keys),
  });
  const withPad = (index: number, pad: GamepadButtonName[]): ControlBindings => ({
    ...bindings,
    gamepad: withEntry(bindings.gamepad, actions[index].id, pad, actions[index].gamepad),
  });

  const commit = (index: number, next: ControlBindings, what: string) => {
    const id = actions[index].id;
    const before = new Set(conflicts[id] ?? []);
    const fresh = (findConflicts(effectiveActions(actions, next.keys, next.gamepad))[id] ?? []).filter((o) => !before.has(o));
    onChange(next);
    if (fresh.length) {
      const text = `${what} is also used by ${fresh.map(nameOf).join(", ")}`;
      setLive((l) => ({ text, n: l.n + 1 }));
    }
  };

  const assignKey = (index: number, slot: number, code: string) =>
    commit(index, withKeys(index, placeInSlot(effective[index].keys, slot, code, MAX_ACTION_KEYS)), keyLabel(code, layout));
  const clearKey = (index: number, slot: number) => onChange(withKeys(index, effective[index].keys.filter((_, i) => i !== slot)));
  const assignPad = (index: number, slot: number, name: GamepadButtonName) =>
    commit(index, withPad(index, placeInSlot(effective[index].gamepad, slot, name, MAX_ACTION_GAMEPAD)), gamepadLabel(name));
  const clearPad = (index: number, slot: number) => onChange(withPad(index, effective[index].gamepad.filter((_, i) => i !== slot)));

  // "Reset" unmounts once the row is back to defaults: focus moves to the row's first key button first (L6a).
  const resetRow = (index: number) => {
    tableRef.current?.querySelector<HTMLElement>(`tr[data-action-row="${index}"] .pf-keycap__btn`)?.focus();
    const id = actions[index].id;
    const drop = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id));
    onChange({ keys: drop(bindings.keys), gamepad: drop(bindings.gamepad) });
  };
  // "Reset all" unmounts after a click: focus moves to Done.
  const resetAll = () => {
    doneRef.current?.focus();
    onChange(emptyBindings());
  };

  const footer =
    mode === "studio" ? (
      <span className="pf-muted pf-small pf-controls__saved">Kept for this Studio session</span>
    ) : syncState === "failed" ? (
      <span className="pf-small pf-controls__saved pf-controls__saved--failed" role="status">
        Saved on this device. Couldn't save to your account; it will be retried.
      </span>
    ) : (
      <span className="pf-muted pf-small pf-controls__saved">{syncState === "account" ? "Saved to your account" : "Saved on this device"}</span>
    );

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
            <table className="pf-controls__table" ref={tableRef}>
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
                  const changed = changedAt(i);
                  const unbound = a.keys.length === 0 && a.gamepad.length === 0;
                  const warnId = `${uid}-warn-${i}`;
                  const warn = others?.length || unbound;
                  return (
                    <tr key={a.id} data-action-row={i} className={changed ? "is-changed" : undefined} aria-describedby={warn ? warnId : undefined}>
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
                              describedBy={warn ? warnId : undefined}
                              onAssign={(code) => assignKey(i, s, code)}
                              onClear={() => clearKey(i, s)}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="pf-controls__pad">
                        <div className="pf-controls__keys">
                          {Array.from({ length: MAX_ACTION_GAMEPAD }, (_, s) => (
                            <GamepadCaptureButton
                              key={s}
                              button={a.gamepad[s] ?? null}
                              actionName={a.name}
                              slot={s}
                              describedBy={warn ? warnId : undefined}
                              onAssign={(name) => assignPad(i, s, name)}
                              onClear={() => clearPad(i, s)}
                            />
                          ))}
                          {changed && (
                            <button type="button" className="pf-linkbtn pf-controls__reset" onClick={() => resetRow(i)} aria-label={`Reset ${a.name}`}>
                              Reset
                            </button>
                          )}
                        </div>
                      </td>
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
            <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm" onClick={resetAll}>
              Reset all
            </button>
          )}
          {effective.length > 0 && footer}
          <button type="button" className="pf-btn pf-btn--primary pf-btn--sm" onClick={onClose} data-autofocus ref={doneRef}>
            Done
          </button>
        </div>
        <div className="pf-sr-only" aria-live="polite" aria-atomic="true">
          {live.text && <span key={live.n}>{live.text}</span>}
        </div>
      </div>
    </div>
  );
}
