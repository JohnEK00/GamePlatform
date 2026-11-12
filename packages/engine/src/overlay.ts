/** DOM error overlay shown when WebGL2 is missing or the game crashes. */

let current: HTMLDivElement | null = null;

export function showErrorOverlay(title: string, message: string, details?: string): void {
  if (typeof document === 'undefined') return;
  current?.remove();
  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(8,10,18,0.92)', 'color:#e8ecf4', 'font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
    'padding:24px', 'box-sizing:border-box',
  ].join(';');
  const box = document.createElement('div');
  box.style.cssText = 'max-width:560px;width:100%;background:#151a2b;border:1px solid #2c3554;border-radius:12px;padding:20px 22px;box-shadow:0 12px 40px rgba(0,0,0,.5)';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:8px;color:#ff7a7a';
  const p = document.createElement('div');
  p.textContent = message;
  p.style.cssText = 'white-space:pre-wrap;word-break:break-word';
  box.append(h, p);
  if (details) {
    const d = document.createElement('pre');
    d.textContent = details;
    d.style.cssText = 'margin:12px 0 0;max-height:200px;overflow:auto;font:12px/1.4 ui-monospace,Consolas,monospace;background:#0b0e18;padding:10px;border-radius:8px;color:#9aa6c4;white-space:pre-wrap';
    box.append(d);
  }
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.style.cssText = 'margin-top:14px;background:#4c6fff;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer';
  btn.onclick = () => location.reload();
  box.append(btn);
  el.append(box);
  (document.body ?? document.documentElement).append(el);
  current = el;
}

export function hideErrorOverlay(): void {
  current?.remove();
  current = null;
}
