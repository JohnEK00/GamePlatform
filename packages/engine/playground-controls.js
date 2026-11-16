// Dev playground (index.html, studio.html): the parent side of F009 remapping (docs/GAME_FORMAT.md
// § F009). It mirrors what GamePlayer / StudioPreview do, minus the real UI:
//  - a ⌨ button opens a small controls panel (actions in manifest order, 3 key slots, read-only gamepad);
//  - clicking a slot captures the next bindable key (Escape cancels; Tab/F-keys "can't be used");
//  - every change posts a fresh { type: "webgame:controls", overrides } (ids + codes only);
//  - opening the panel posts webgame:pause, closing it webgame:resume, then focuses the iframe;
//  - overrides persist in localStorage webgame.controls.{name} ({ v: 1, overrides }, max 4096 bytes)
//    on index.html, and in memory only on studio.html (Studio rule).
// Key tables and override semantics come straight from the engine source (one copy for the dev host).
import { BINDABLE_KEYS, applyOverrides, gamepadLabel, keyLabel, parseActions } from '/src/actions.ts';

const MAX_STORED = 4096;
const CAPTURE_MS = 10000;

/**
 * @param {{ frame: HTMLIFrameElement, toGame: (msg: unknown) => void, bar: HTMLElement, log: HTMLElement,
 *           storageKey: string | null, actions: () => unknown, hint: () => string }} opts
 *        storageKey null → in-memory overrides (studio).
 * @returns {{ afterLoad(): void, refresh(): void }} afterLoad: call right after each webgame:load reply.
 */
export function controlsHost({ frame, toGame, bar, log, storageKey, actions: rawActions, hint }) {
  let memory = {};
  const defaults = () => parseActions(rawActions()).actions;

  function read() {
    if (!storageKey) return memory;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return {};
      const v = raw.length <= MAX_STORED ? JSON.parse(raw) : null;
      if (v && v.v === 1 && v.overrides && typeof v.overrides === 'object' && !Array.isArray(v.overrides)) return v.overrides;
      localStorage.removeItem(storageKey);
    } catch {
      /* malformed → {} */
    }
    return {};
  }
  function write(overrides) {
    // Keep only declared ids whose keys differ from the defaults.
    const out = {};
    for (const a of defaults()) {
      const v = overrides[a.id];
      if (Array.isArray(v) && v.join() !== a.keys.join()) out[a.id] = v;
    }
    if (!storageKey) memory = out;
    else if (!Object.keys(out).length) localStorage.removeItem(storageKey);
    else {
      const json = JSON.stringify({ v: 1, overrides: out });
      if (json.length <= MAX_STORED) localStorage.setItem(storageKey, json);
    }
    send();
  }
  function send() {
    if (!defaults().length) return;
    const overrides = read();
    toGame({ type: 'webgame:controls', overrides });
    log.textContent = `controls → ${Object.keys(overrides).length ? JSON.stringify(overrides) : 'defaults'}`;
  }

  const style = document.createElement('style');
  style.textContent = `
    #controls { position: fixed; inset: 0; z-index: 30; display: none; place-items: center; background: rgba(0,0,0,.55);
      font: 13px/1.35 system-ui, sans-serif; color: #e8ecf4; }
    #controls.open { display: grid; }
    #controls .box { background: #141a2e; border: 1px solid #36406a; border-radius: 10px; padding: 14px 16px; max-width: min(640px, 94vw);
      max-height: 90vh; overflow: auto; }
    #controls h2 { margin: 0 0 8px; font-size: 16px; }
    #controls table { border-collapse: collapse; margin: 8px 0; }
    #controls td, #controls th { padding: 3px 6px; text-align: left; vertical-align: middle; }
    #controls button { font: inherit; color: #e8ecf4; background: #1e2540; border: 1px solid #36406a; border-radius: 5px; padding: 2px 8px; cursor: pointer; }
    #controls button.slot { min-width: 78px; }
    #controls button.capturing { border-color: #ffd93d; color: #ffd93d; }
    #controls .x { padding: 0 4px; margin-left: 2px; }
    #controls .tag { color: #ffd93d; font-size: 11px; margin-left: 4px; }
    #controls .warn { color: #ffb86b; font-size: 12px; }
    #controls footer { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 8px; }`;
  document.head.append(style);
  const root = document.createElement('div');
  root.id = 'controls';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Controls');
  document.body.append(root);

  const btn = document.createElement('button');
  btn.textContent = '⌨';
  btn.title = 'Controls (webgame:controls)';
  btn.setAttribute('aria-label', 'Controls');
  btn.addEventListener('keydown', (e) => e.preventDefault());
  bar.insertBefore(btn, log);

  let capture = null; // { id, slot, timer }
  let status = '';

  function stopCapture() {
    if (capture) clearTimeout(capture.timer);
    capture = null;
  }
  function onKey(e) {
    if (!root.classList.contains('open')) return;
    if (!capture) {
      if (e.code === 'Escape') { e.preventDefault(); close(); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { stopCapture(); status = ''; render(); return; }
    if (!BINDABLE_KEYS.includes(e.code) || e.code.startsWith('Mouse')) {
      status = `${e.code || e.key} can't be used`;
      render();
      return;
    }
    const eff = applyOverrides(defaults(), read()).find((a) => a.id === capture.id);
    const keys = [...(eff?.keys ?? [])].filter((k) => k !== e.code);
    keys.splice(Math.min(capture.slot, keys.length), 0, e.code);
    const o = { ...read(), [capture.id]: keys.slice(0, 3) };
    stopCapture();
    status = '';
    write(o);
    render();
  }
  window.addEventListener('keydown', onKey, true);

  function render() {
    const defs = defaults();
    const overrides = read();
    const eff = applyOverrides(defs, overrides);
    root.textContent = '';
    const box = document.createElement('div');
    box.className = 'box';
    const h = document.createElement('h2');
    h.textContent = 'Controls';
    box.append(h);
    const text = hint();
    if (text) {
      const p = document.createElement('p');
      p.textContent = text; // plain text
      box.append(p);
    }
    if (eff.length) {
      const table = document.createElement('table');
      const head = table.insertRow();
      for (const t of ['Action', 'Keys', 'Gamepad', '']) head.append(Object.assign(document.createElement('th'), { textContent: t }));
      const owners = new Map();
      for (const a of eff) for (const k of a.keys) owners.set(k, [...(owners.get(k) ?? []), a.name]);
      eff.forEach((a, i) => {
        const def = defs[i];
        const row = table.insertRow();
        row.insertCell().textContent = a.name;
        const keysCell = row.insertCell();
        for (let slot = 0; slot < 3; slot++) {
          const code = a.keys[slot];
          const b = document.createElement('button');
          b.className = 'slot';
          const active = capture && capture.id === a.id && capture.slot === slot;
          if (active) b.classList.add('capturing');
          b.textContent = active ? 'Press a key…' : code ? keyLabel(code) : '—';
          b.onclick = () => {
            stopCapture();
            capture = { id: a.id, slot, timer: setTimeout(() => { stopCapture(); render(); }, CAPTURE_MS) };
            status = `Press a key for ${a.name}, or Escape to cancel`;
            render();
          };
          keysCell.append(b);
          if (code) {
            const x = document.createElement('button');
            x.className = 'x';
            x.textContent = '×';
            x.setAttribute('aria-label', `Clear ${keyLabel(code)} from ${a.name}`);
            x.onclick = () => { write({ ...read(), [a.id]: a.keys.filter((k) => k !== code) }); render(); };
            keysCell.append(x);
          }
        }
        row.insertCell().textContent = a.gamepad.length ? a.gamepad.map(gamepadLabel).join(', ') : '—';
        const extra = row.insertCell();
        if (a.keys.join() !== def.keys.join()) {
          extra.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'Changed' }));
          const r = document.createElement('button');
          r.textContent = 'Reset';
          r.onclick = () => {
            const o = { ...read() };
            delete o[a.id];
            write(o);
            render();
          };
          extra.append(' ', r);
        }
        const others = new Set(a.keys.flatMap((k) => (owners.get(k) ?? []).filter((n) => n !== a.name)));
        if (others.size) extra.append(Object.assign(document.createElement('div'), { className: 'warn', textContent: `Also used by ${[...others].join(', ')}` }));
        if (!a.keys.length && !a.gamepad.length) extra.append(Object.assign(document.createElement('div'), { className: 'warn', textContent: 'Unbound' }));
      });
      box.append(table);
      const allKeys = eff.flatMap((a) => a.keys);
      if (allKeys.some((k) => k === 'ControlLeft' || k === 'ControlRight') && allKeys.some((k) => k === 'KeyW' || k === 'KeyT' || k === 'KeyN'))
        box.append(Object.assign(document.createElement('p'), { className: 'warn', textContent: 'Browsers may close or open tabs on Ctrl+W, Ctrl+T or Ctrl+N' }));
    }
    const live = document.createElement('div');
    live.setAttribute('aria-live', 'polite');
    live.className = 'warn';
    live.textContent = status;
    box.append(live);
    const foot = document.createElement('footer');
    if (Object.keys(overrides).length) {
      const all = document.createElement('button');
      all.textContent = 'Reset all';
      all.onclick = () => { write({}); render(); };
      foot.append(all);
    }
    foot.append(document.createTextNode(storageKey ? 'Saved on this device' : 'Kept for this session'));
    const done = document.createElement('button');
    done.textContent = 'Done';
    done.onclick = close;
    foot.append(done);
    box.append(foot);
    root.append(box);
  }

  function open() {
    if (!defaults().length && !hint()) {
      log.textContent = 'this game declares no actions and no controls hint';
      return;
    }
    root.classList.add('open');
    toGame({ type: 'webgame:pause' }); // parent pause reason "controls"
    render();
  }
  function close() {
    stopCapture();
    status = '';
    root.classList.remove('open');
    toGame({ type: 'webgame:resume' });
    frame.focus();
  }
  btn.onclick = () => (root.classList.contains('open') ? close() : open());
  root.addEventListener('click', (e) => { if (e.target === root) close(); });

  return { afterLoad: send, refresh: () => root.classList.contains('open') && render() };
}
