import { afterEach, describe, expect, it, vi } from 'vitest';
import { Assets } from '../src/assets';
import type { AudioManager } from '../src/audio';
import { BundleFiles, deriveStorageKey, mimeType, normalizePath } from '../src/files';
import type { Renderer } from '../src/renderer';

const BASE = 'https://example.test/games/1/files/';
const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

function makeAssets(files: ConstructorParameters<typeof BundleFiles>[0], base = BASE) {
  const decoded: ArrayBuffer[] = [];
  const audio = { decode: async (buf: ArrayBuffer) => (decoded.push(buf), { duration: 1 }) } as unknown as AudioManager;
  const assets = new Assets(base, {} as Renderer, audio, new BundleFiles(files, base));
  return { assets, decoded };
}

afterEach(() => vi.unstubAllGlobals());

describe('path helpers', () => {
  it('normalizes bundle paths', () => {
    expect(normalizePath('./assets/a.png')).toBe('assets/a.png');
    expect(normalizePath('/assets//b/../a.png?v=3#x')).toBe('assets/a.png');
    expect(normalizePath('assets\\a.png')).toBe('assets/a.png');
    expect(normalizePath('assets/my%20file.txt')).toBe('assets/my file.txt');
    expect(normalizePath('../secret')).toBeNull();
  });
  it('maps extensions to MIME types', () => {
    expect(mimeType('a/b.PNG')).toBe('image/png');
    expect(mimeType('x.json?v=1')).toBe('application/json');
    expect(mimeType('s.mp3')).toBe('audio/mpeg');
    expect(mimeType('f.woff2')).toBe('font/woff2');
    expect(mimeType('noext')).toBe('application/octet-stream');
  });
});

describe('in-memory files', () => {
  it('resolves strings, ArrayBuffers, typed arrays and Blobs', async () => {
    const { assets, decoded } = makeAssets({
      'assets/level.json': '{"n":3}',
      './assets/readme.txt': 'hello',
      'assets/data.bin': new Uint8Array([1, 2, 3]).buffer,
      'assets/view.bin': new Uint8Array([9, 8, 7, 6]).subarray(1, 3),
      'assets/blob.txt': new Blob(['from blob']),
      'assets/sfx.wav': enc('RIFF'),
    });
    await expect(assets.loadJSON('assets/level.json')).resolves.toEqual({ n: 3 });
    await expect(assets.loadText('assets/readme.txt')).resolves.toBe('hello');
    await expect(assets.loadText('/assets/./readme.txt')).resolves.toBe('hello');
    await expect(assets.loadText(BASE + 'assets/blob.txt')).resolves.toBe('from blob');
    expect([...new Uint8Array(await assets.loadBinary('assets/data.bin'))]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(await assets.loadBinary('assets/view.bin'))]).toEqual([8, 7]);
    await assets.loadSound('assets/sfx.wav');
    expect(new TextDecoder().decode(decoded[0])).toBe('RIFF');
  });

  it('gives blobs the MIME type of their extension and decodes data: URLs', async () => {
    const f = new BundleFiles({ 'a.png': new Uint8Array([137, 80]).buffer, 'b.svg': '<svg/>', 'c.png': 'data:image/png;base64,AQID', 'd.json': new Blob(['{}'], { type: '' }) });
    expect(f.blob('a.png')!.type).toBe('image/png');
    expect(f.blob('b.svg')!.type).toBe('image/svg+xml');
    const c = f.blob('c.png')!;
    expect(c.type).toBe('image/png');
    expect([...new Uint8Array(await c.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(f.blob('d.json')!.type).toBe('application/json');
    expect(f.blob('missing.png')).toBeNull();
  });

  it('falls back to fetch(baseUrl + path) for files not in the map', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(`remote:${url}`, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { assets } = makeAssets({ 'local.txt': 'local' });
    await expect(assets.loadText('local.txt')).resolves.toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(assets.loadText('assets/remote.txt')).resolves.toBe(`remote:${BASE}assets/remote.txt`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports HTTP errors from the fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const { assets } = makeAssets({});
    await expect(assets.loadText('x.txt')).rejects.toThrow(/HTTP 404/);
  });

  it('works without a usable baseUrl (studio uses about:blank)', async () => {
    const { assets } = makeAssets({ 'main.js': 'export default {}', 'assets/a.txt': 'A' }, 'about:blank');
    await expect(assets.loadText('assets/a.txt')).resolves.toBe('A');
  });

  it('creates object URLs once and revokes them on dispose', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fake/${create.mock.calls.length}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      const files = new BundleFiles({ 'assets/a.png': new ArrayBuffer(4) }, BASE);
      const assets = new Assets(BASE, {} as Renderer, {} as AudioManager, files);
      const u1 = assets.url('assets/a.png');
      const u2 = assets.url('./assets/a.png');
      expect(u1).toMatch(/^blob:/);
      expect(u2).toBe(u1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(assets.url('assets/other.png')).toBe(BASE + 'assets/other.png');
      files.dispose();
      expect(revoke).toHaveBeenCalledWith(u1);
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });
});

describe('deriveStorageKey', () => {
  it('keeps explicit key and baseUrl default', () => {
    expect(deriveStorageKey('https://x/g/', undefined, 'k')).toBe('k');
    expect(deriveStorageKey('about:blank', { 'game.json': '{"id":"a"}' }, 'k')).toBe('k');
    expect(deriveStorageKey('https://x/g/')).toBe('https://x/g/');
    expect(deriveStorageKey('https://x/g/', {})).toBe('https://x/g/');
  });
  it('separates studio projects by manifest id/title', () => {
    const a = deriveStorageKey('about:blank', { 'game.json': '{"id":"alpha"}', 'main.js': 'x' });
    const a2 = deriveStorageKey('about:blank', { './game.json': new TextEncoder().encode('{"id":"alpha"}'), 'main.js': 'changed' });
    const b = deriveStorageKey('about:blank', { 'game.json': '{"id":"beta"}', 'main.js': 'x' });
    const t = deriveStorageKey('about:blank', { 'game.json': '{"title":"Beta"}' });
    expect(a).toMatch(/^studio:id:[0-9a-f]{8}$/);
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(t).not.toBe(b);
  });
  it('falls back to a hash of sorted paths', () => {
    const p1 = deriveStorageKey('about:blank', { 'main.js': 'a', 'assets/x.png': 'b' });
    const p2 = deriveStorageKey('about:blank', { 'assets/x.png': 'z', 'main.js': 'y' });
    const p3 = deriveStorageKey('about:blank', { 'main.js': 'a', 'assets/y.png': 'b' });
    expect(p1).toMatch(/^studio:paths:[0-9a-f]{8}$/);
    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(deriveStorageKey('https://x/', { 'main.js': 'a', 'game.json': 'not json' })).toMatch(/^studio:paths:/);
  });
});
