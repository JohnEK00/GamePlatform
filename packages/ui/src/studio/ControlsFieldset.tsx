import { useMemo } from "react";
import { KeyCaptureButton } from "../components/KeyCaptureButton";
import {
  CONTROLS_HINT_MAX,
  formatActionsProblem,
  GAMEPAD_BUTTON_NAMES,
  gamepadLabel,
  isBindableKey,
  MAX_ACTION_KEYS,
  MAX_ACTIONS,
  problemsForAction,
  useKeyboardLayout,
  validateActions,
} from "../controls";
import { asManifest, type StudioManifest } from "./project";

/** A game.json `actions` entry as edited in the form (may be invalid while the user types). */
type ActionDraft = { id?: unknown; name?: unknown; keys?: unknown; gamepad?: unknown; [k: string]: unknown };

const MOVEMENT: { id: string; name: string; keys: string[]; gamepad: string[] }[] = [
  { id: "left", name: "Move left", keys: ["ArrowLeft", "KeyA"], gamepad: ["Left"] },
  { id: "right", name: "Move right", keys: ["ArrowRight", "KeyD"], gamepad: ["Right"] },
  { id: "up", name: "Move up", keys: ["ArrowUp", "KeyW"], gamepad: ["Up"] },
  { id: "down", name: "Move down", keys: ["ArrowDown", "KeyS"], gamepad: ["Down"] },
];

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * F009 Studio: the game.json "Controls" fieldset: the free-text hint (`controls`) and the `actions` list, with
 * inline errors from `validateActions` (the backend's strict rules).
 */
export function ControlsFieldset({ manifest, onChange }: { manifest: object; onChange: (m: StudioManifest) => void }) {
  const m = asManifest(manifest);
  const layout = useKeyboardLayout();
  const problems = useMemo(() => validateActions(manifest), [manifest]);
  const rawActions = m.actions;
  const actions: ActionDraft[] = Array.isArray(rawActions) ? (rawActions as ActionDraft[]) : [];
  const hint = typeof m.controls === "string" ? m.controls : "";
  const hintLen = Array.from(hint).length;
  const topProblems = problems.filter((p) => p.path === "actions");

  const setActions = (list: ActionDraft[]) => {
    const next = asManifest(m);
    if (list.length) next.actions = list;
    else delete next.actions;
    onChange(next);
  };
  const setAction = (i: number, patch: ActionDraft) => setActions(actions.map((a, j) => (j === i ? { ...(a && typeof a === "object" ? a : {}), ...patch } : a)));
  const setHint = (v: string) => {
    const next = asManifest(m);
    if (v) next.controls = v;
    else delete next.controls;
    onChange(next);
  };

  const ids = new Set(actions.map((a) => (a && typeof a.id === "string" ? a.id : "")));
  const addAction = () => {
    let n = actions.length + 1;
    while (ids.has(`action${n}`)) n++;
    setActions([...actions, { id: `action${n}`, name: `Action ${n}`, keys: [], gamepad: [] }]);
  };
  const addMovement = () => {
    const add = MOVEMENT.filter((a) => !ids.has(a.id)).map((a) => ({ ...a, keys: [...a.keys], gamepad: [...a.gamepad] }));
    setActions([...actions, ...add].slice(0, Math.max(actions.length, MAX_ACTIONS)));
  };

  const assignKey = (i: number, slot: number, code: string) => {
    const cur = strList(actions[i]?.keys).slice(0, MAX_ACTION_KEYS);
    const slots: (string | null)[] = Array.from({ length: MAX_ACTION_KEYS }, (_, s) => cur[s] ?? null);
    for (let s = 0; s < slots.length; s++) if (s !== slot && slots[s] === code) slots[s] = null;
    slots[slot] = code;
    setAction(i, { keys: slots.filter((k): k is string => k !== null) });
  };
  const clearKey = (i: number, slot: number) => setAction(i, { keys: strList(actions[i]?.keys).filter((_, s) => s !== slot) });
  const setPad = (i: number, slot: number, name: string) => {
    const cur = strList(actions[i]?.gamepad);
    const slots = [cur[0] ?? "", cur[1] ?? ""];
    slots[slot] = name;
    setAction(i, { gamepad: slots.filter(Boolean) });
  };

  return (
    <fieldset className="pf-studio-lb pf-studio-controls">
      <legend>Controls</legend>
      <div className="pf-field">
        <label className="pf-label" htmlFor="pf-st-controls-hint">
          Controls hint <span className="pf-muted pf-small">(optional, shown to players)</span>
        </label>
        <input
          id="pf-st-controls-hint"
          className="pf-input"
          maxLength={CONTROLS_HINT_MAX}
          placeholder="Arrows move, Space shoots"
          value={hint}
          aria-describedby="pf-st-controls-hint-count"
          onChange={(e) => setHint(e.target.value)}
        />
        <span id="pf-st-controls-hint-count" className="pf-muted pf-small pf-studio-controls__count">
          {hintLen}/{CONTROLS_HINT_MAX}
        </span>
      </div>

      <div className="pf-studio-ach__head">
        <h3>Actions</h3>
        <span className="pf-studio-controls__add">
          <button type="button" className="pf-btn pf-btn--sm" onClick={addAction} disabled={actions.length >= MAX_ACTIONS}>
            + Add action
          </button>
          <button
            type="button"
            className="pf-btn pf-btn--sm pf-btn--ghost"
            onClick={addMovement}
            disabled={actions.length >= MAX_ACTIONS || MOVEMENT.every((a) => ids.has(a.id))}
          >
            + Add movement
          </button>
        </span>
      </div>
      {topProblems.map((p) => (
        <span key={p.path + p.message} className="pf-field__error" role="alert">
          {formatActionsProblem(p)}
          {rawActions !== undefined && rawActions !== null && !Array.isArray(rawActions) ? " (adding an action replaces it)" : ""}
        </span>
      ))}
      {actions.length === 0 ? (
        <p className="pf-muted pf-small">
          None yet. Declare the keys your game uses so players can see and remap them, then read them with{" "}
          <code>engine.input.actionPressed("id")</code>.
        </p>
      ) : (
        <ol className="pf-studio-ach__list pf-studio-controls__list">
          {actions.map((a, i) => {
            const obj = a && typeof a === "object" ? a : {};
            const id = typeof obj.id === "string" ? obj.id : "";
            const name = typeof obj.name === "string" ? obj.name : "";
            const keys = Array.isArray(obj.keys) ? (obj.keys as unknown[]) : [];
            const pads = strList(obj.gamepad);
            const label = name.trim() || id || `action ${i + 1}`;
            const errs = problemsForAction(problems, i);
            const errId = `pf-st-act-err-${i}`;
            const field = (f: string) => errs.some((p) => p.path === `actions[${i}].${f}` || p.path.startsWith(`actions[${i}].${f}[`));
            return (
              <li key={i} className="pf-studio-ach__item pf-studio-controls__item" aria-describedby={errs.length ? errId : undefined}>
                <div className="pf-form__row2">
                  <div className="pf-field">
                    <label className="pf-label" htmlFor={`pf-act-id-${i}`}>
                      ID
                    </label>
                    <input
                      id={`pf-act-id-${i}`}
                      className="pf-input pf-mono"
                      value={id}
                      maxLength={32}
                      aria-invalid={field("id") || undefined}
                      onChange={(e) => setAction(i, { id: e.target.value })}
                    />
                  </div>
                  <div className="pf-field">
                    <label className="pf-label" htmlFor={`pf-act-name-${i}`}>
                      Name
                    </label>
                    <input
                      id={`pf-act-name-${i}`}
                      className="pf-input"
                      value={name}
                      maxLength={60}
                      aria-invalid={field("name") || undefined}
                      onChange={(e) => setAction(i, { name: e.target.value })}
                    />
                  </div>
                </div>
                <div className="pf-studio-controls__bindings">
                  <div className="pf-studio-controls__keys" role="group" aria-label={`Keys for ${label}`}>
                    <span className="pf-label">Keys</span>
                    {Array.from({ length: MAX_ACTION_KEYS }, (_, s) => {
                      const k = keys[s];
                      const code = typeof k === "string" ? k : k === undefined ? null : String(k);
                      return (
                        <KeyCaptureButton
                          key={s}
                          code={code}
                          actionName={label}
                          slot={s}
                          layout={layout}
                          invalid={code !== null && !isBindableKey(code)}
                          onAssign={(c) => assignKey(i, s, c)}
                          onClear={() => clearKey(i, s)}
                        />
                      );
                    })}
                  </div>
                  <div className="pf-studio-controls__pads">
                    {[0, 1].map((s) => (
                      <select
                        key={s}
                        className="pf-input"
                        aria-label={`Gamepad button ${s + 1} for ${label}`}
                        aria-invalid={field("gamepad") || undefined}
                        value={pads[s] ?? ""}
                        onChange={(e) => setPad(i, s, e.target.value)}
                      >
                        <option value="">No button</option>
                        {pads[s] && !GAMEPAD_BUTTON_NAMES.includes(pads[s] as never) && <option value={pads[s]}>{pads[s]}</option>}
                        {GAMEPAD_BUTTON_NAMES.map((g) => (
                          <option key={g} value={g}>
                            {gamepadLabel(g)}
                          </option>
                        ))}
                      </select>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="pf-iconbtn pf-iconbtn--sm pf-studio-controls__remove"
                    title="Remove"
                    aria-label={`Remove action ${label}`}
                    onClick={() => setActions(actions.filter((_, j) => j !== i))}
                  >
                    🗑
                  </button>
                </div>
                {errs.length > 0 && (
                  <ul id={errId} className="pf-studio-controls__errors">
                    {errs.map((p) => (
                      <li key={p.path + p.message} className="pf-field__error">
                        {p.path.slice(`actions[${i}]`.length).replace(/^\./, "") || "action"} {p.message}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </fieldset>
  );
}
