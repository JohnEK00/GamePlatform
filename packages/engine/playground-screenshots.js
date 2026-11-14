// Dev playground (index.html, studio.html): the parent side of the F005 screenshot messages
// (docs/GAME_FORMAT.md § F005). It mirrors what GamePlayer / StudioPreview do, minus the backend:
//  - a 📷 button posts webgame:screenshot-request (ids "ps-<n>", one in flight, 5 s timeout);
//  - webgame:screenshot replies / game shares are validated, then LAUNDERED (createImageBitmap →
//    canvas → PNG) before any object URL is made. The game's own Blob never gets an object URL;
//  - game shares are rate limited (1 per 3 s, 20 per page) and answered with webgame:screenshot-result;
//  - a small in-memory tray (max 12) shows the images with a download link.

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 4096;
const TRAY_MAX = 12;
const REQUEST_TIMEOUT_MS = 5000;
const SHARE_INTERVAL_MS = 3000;
const SHARE_MAX = 20;
// Control and bidi characters (built with RegExp so this file has no escapes in a regex literal).
const STRIP = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g');

const isId = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 64;
const cleanCaption = (v) => (typeof v === 'string' ? Array.from(v.replace(STRIP, '').trim()).slice(0, 140).join('') : '');

/** Decode the untrusted blob and re-encode it as PNG in this (parent) realm. */
async function launder(blob) {
  if (!(blob instanceof Blob) || blob.size > MAX_BYTES) throw new Error('not a blob or over 8 MiB');
  const bmp = await createImageBitmap(blob); // throws on non-images (HTML, SVG, garbage)
  try {
    const { width, height } = bmp;
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`bad size ${width}x${height}`);
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const png = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
    return { blob: png, width, height };
  } finally {
    bmp.close();
  }
}

/**
 * @param {{ frame: HTMLIFrameElement, toGame: (msg: unknown) => void, bar: HTMLElement, log: HTMLElement,
 *           note: (text: string, err?: boolean) => void, slug: () => string }} opts
 * @returns {(d: any) => boolean} handler: true when `d` was a screenshot message
 */
export function screenshotHost({ toGame, bar, log, note, slug }) {
  let seq = 0;
  let inflight = null;
  let lastShare = -Infinity;
  let shares = 0;
  const items = [];

  const style = document.createElement('style');
  style.textContent = `
    #shots { position: fixed; top: 12px; left: 12px; z-index: 15; display: flex; gap: 6px; flex-wrap: wrap; max-width: calc(100vw - 400px); }
    #shots figure { margin: 0; padding: 4px; background: rgba(15,18,32,.9); border: 1px solid #36406a; border-radius: 6px;
      font: 11px/1.3 system-ui, sans-serif; color: #cfd6ee; max-width: 200px; }
    #shots img { display: block; height: 96px; max-width: 192px; object-fit: contain; background: #000; }
    #shots a { color: #8ea2ff; margin-right: 6px; }
    #shots.flash::after { content: ''; position: fixed; inset: 0; background: #fff; opacity: 0; animation: shotflash 150ms ease-out; pointer-events: none; }
    @keyframes shotflash { from { opacity: .8; } to { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { #shots.flash::after { animation: none; } }`;
  document.head.append(style);
  const tray = document.createElement('div');
  tray.id = 'shots';
  document.body.append(tray);

  const btn = document.createElement('button');
  btn.textContent = '📷';
  btn.title = 'Take screenshot (webgame:screenshot-request)';
  btn.setAttribute('aria-label', 'Take screenshot');
  btn.addEventListener('keydown', (e) => e.preventDefault());
  bar.insertBefore(btn, log);

  btn.onclick = () => {
    if (inflight) return;
    const requestId = `ps-${++seq}`;
    btn.disabled = true;
    inflight = {
      requestId,
      timer: setTimeout(() => {
        inflight = null;
        btn.disabled = false;
        note("Couldn't capture a screenshot: this game can't take screenshots right now", true);
      }, REQUEST_TIMEOUT_MS),
    };
    toGame({ type: 'webgame:screenshot-request', requestId });
  };

  function add(shot, caption, fromGame) {
    const url = URL.createObjectURL(shot.blob); // laundered PNG only
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = url;
    img.alt = caption || 'Screenshot';
    const cap = document.createElement('figcaption');
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const file = `${slug()}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`;
    const dl = document.createElement('a');
    dl.href = url;
    dl.download = file;
    dl.textContent = 'Download';
    const rm = document.createElement('a');
    rm.href = '#';
    rm.textContent = 'Remove';
    rm.onclick = (e) => { e.preventDefault(); drop(item); };
    const meta = document.createElement('div');
    meta.textContent = `${shot.width}×${shot.height}${fromGame ? ' · from game' : ''}${caption ? ` · ${caption}` : ''}`; // plain text
    cap.append(meta, dl, rm);
    fig.append(img, cap);
    tray.prepend(fig);
    const item = { url, fig };
    items.unshift(item);
    while (items.length > TRAY_MAX) drop(items[items.length - 1]);
    if (!fromGame) {
      tray.classList.remove('flash');
      void tray.offsetWidth;
      tray.classList.add('flash');
    }
  }
  function drop(item) {
    const i = items.indexOf(item);
    if (i >= 0) items.splice(i, 1);
    URL.revokeObjectURL(item.url);
    item.fig.remove();
  }

  async function onPlayer(d) {
    if (!inflight || d.requestId !== inflight.requestId) return; // unsolicited or stale: ignore
    clearTimeout(inflight.timer);
    inflight = null;
    btn.disabled = false;
    if (typeof d.error === 'string') {
      const why = { unavailable: 'the game is still loading', busy: 'try again in a moment', failed: "this game can't take screenshots right now" };
      note(`Couldn't capture a screenshot: ${why[d.error] || d.error}`, true);
      return;
    }
    try {
      const shot = await launder(d.image);
      add(shot, '', false);
      log.textContent = `screenshot ${shot.width}×${shot.height} (game said ${d.width}×${d.height})`;
    } catch (e) {
      note(`Couldn't capture a screenshot: ${e.message}`, true);
    }
  }

  async function onGame(d) {
    const reply = (accepted, error) => toGame({ type: 'webgame:screenshot-result', requestId: d.requestId, accepted, ...(error ? { error } : {}) });
    const now = Date.now();
    if (now - lastShare < SHARE_INTERVAL_MS || shares >= SHARE_MAX) return reply(false, 'rate_limited');
    lastShare = now;
    shares++;
    let shot;
    try {
      shot = await launder(d.image);
    } catch {
      return reply(false, 'invalid');
    }
    const caption = cleanCaption(d.caption);
    add(shot, caption, true);
    note(`The game captured a screenshot${caption ? `: ${caption}` : ''}`);
    reply(true);
  }

  return (d) => {
    if (d.type !== 'webgame:screenshot') return false;
    if (!isId(d.requestId)) return true;
    if (d.source === 'player') void onPlayer(d);
    else if (d.source === 'game') void onGame(d);
    return true;
  };
}
