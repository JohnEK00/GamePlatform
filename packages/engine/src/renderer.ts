/** Batched WebGL2 2D renderer: sprites, shapes and bitmap text in one dynamic vertex buffer. */
import { Camera } from './camera';
import { Color, type ColorLike } from './math';
import { ShelfPacker, SpriteSheet, Texture, type TexturePage } from './texture';

export type BlendMode = 'normal' | 'additive' | 'multiply';
export type TextAlign = 'left' | 'center' | 'right';
export type TextBaseline = 'top' | 'middle' | 'bottom';

export interface SpriteOptions {
  /** Draw size in game units (default: texture/frame size × scale). */
  w?: number;
  h?: number;
  /** Uniform size multiplier when w/h are omitted (default 1). */
  scale?: number;
  /** Rotation in radians around the origin. */
  rotation?: number;
  /** Origin as a fraction of the size (0,0 = top-left, 0.5,0.5 = center). x/y is where the origin lands. */
  originX?: number;
  originY?: number;
  /** Sprite sheet frame index. */
  frame?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Color multiplied with the texture. */
  tint?: ColorLike;
  /** Opacity 0..1. */
  alpha?: number;
}

export interface ShapeOptions {
  /** If set, draw an outline of this thickness instead of a filled shape. */
  outline?: number;
  alpha?: number;
  /** Circle segment count (auto by default). */
  segments?: number;
}

export interface TextOptions {
  /** Font size in game units (default 16). */
  size?: number;
  color?: ColorLike;
  align?: TextAlign;
  baseline?: TextBaseline;
  alpha?: number;
  /** Registered font name (see renderer.setFont); default "default". */
  font?: string;
  /** Extra space between letters, in game units. */
  letterSpacing?: number;
  /** Line height multiplier (default 1.2). */
  lineHeight?: number;
  /** Draw a drop shadow in this color. */
  shadow?: ColorLike;
  shadowOffset?: number;
  /** Word-wrap at this width (game units). */
  maxWidth?: number;
}

export interface TextureOptions {
  /** Linear filtering (default: nearest / pixel-art). */
  smooth?: boolean;
  /** Pack into a shared atlas page when small enough (default true unless smooth). */
  atlas?: boolean;
}

interface Page extends TexturePage {
  prepare?: () => void;
}

const VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aColor;
uniform vec4 uView;
out vec2 vUV;
out vec4 vColor;
void main(){
  vUV = aUV;
  vColor = vec4(aColor.rgb * aColor.a, aColor.a);
  gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTex;
out vec4 outColor;
void main(){ outColor = texture(uTex, vUV) * vColor; }`;

const FLOATS_PER_VERT = 5; // x, y, u, v, rgba(packed)
const MAX_VERTS = 6 * 10000;
const BASE_FONT = 64;
const FONT_PAD = 4;

/** A glyph in a font atlas. */
interface Glyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  w: number;
  h: number;
  adv: number;
}

/** Canvas-rasterized font atlas; glyphs are added lazily, so any Unicode character works. */
class FontAtlas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly glyphs = new Map<string, Glyph>();
  readonly page: Page;
  private cx = 0;
  private cy = 0;
  private rowH = 0;
  private dirty = true;
  readonly ascent: number;
  readonly descent: number;
  readonly cellH: number;
  readonly fontCss: string;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    family: string,
    weight: string,
    readonly size = 1024,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error('2D canvas unavailable for font atlas');
    this.ctx = ctx;
    this.fontCss = `${weight} ${BASE_FONT}px ${family}`;
    ctx.font = this.fontCss;
    const m = ctx.measureText('ÁHgjy|');
    this.ascent = Math.ceil(m.actualBoundingBoxAscent || BASE_FONT * 0.8);
    this.descent = Math.ceil(m.actualBoundingBoxDescent || BASE_FONT * 0.25);
    this.cellH = this.ascent + this.descent + FONT_PAD * 2;
    // White block for shapes (sample its center).
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 8, 8);
    this.cx = 12;
    this.rowH = 8;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create font texture');
    this.page = {
      glTexture: tex,
      width: size,
      height: size,
      white: { u: 4 / size, v: 4 / size },
      prepare: () => this.upload(),
    };
    for (let c = 32; c < 127; c++) this.glyph(String.fromCharCode(c));
  }

  glyph(ch: string): Glyph {
    let g = this.glyphs.get(ch);
    if (g) return g;
    const ctx = this.ctx;
    ctx.font = this.fontCss;
    const adv = ctx.measureText(ch).width;
    const w = Math.ceil(adv) + FONT_PAD * 2;
    const h = this.cellH;
    if (this.cx + w > this.size) {
      this.cx = 0;
      this.cy += this.rowH + 2;
      this.rowH = 0;
    }
    if (this.cy + h > this.size) {
      // Atlas full: fall back to '?'
      return this.glyphs.get('?') ?? { u0: 0, v0: 0, u1: 0, v1: 0, w: 0, h: 0, adv };
    }
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(ch, this.cx + FONT_PAD, this.cy + FONT_PAD + this.ascent);
    const s = this.size;
    g = { u0: this.cx / s, v0: this.cy / s, u1: (this.cx + w) / s, v1: (this.cy + h) / s, w, h, adv };
    this.glyphs.set(ch, g);
    this.cx += w + 2;
    this.rowH = Math.max(this.rowH, h);
    this.dirty = true;
    return g;
  }

  private upload(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.page.glTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
}

interface AtlasPage {
  page: Page;
  packer: ShelfPacker;
}

/**
 * The renderer. All coordinates are in game units (the logical `width × height` resolution);
 * world drawing goes through `camera` unless `setCamera(false)` / `ui()` is used.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly camera: Camera;
  /** Color the frame is cleared with before render() (null = don't auto-clear). */
  background: ColorLike | null = '#000000';
  /** Default filtering for loaded textures. */
  defaultSmooth = false;
  /** Draw stats of the last completed frame. */
  readonly stats = { drawCalls: 0, sprites: 0 };

  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly uView: WebGLUniformLocation | null;
  private readonly f32: Float32Array;
  private readonly u32: Uint32Array;
  private verts = 0;
  private page: Page | null = null;
  private blend: BlendMode = 'normal';
  private cameraOn = true;
  private pixelW = 1;
  private pixelH = 1;
  private readonly fonts = new Map<string, FontAtlas>();
  private readonly atlases: AtlasPage[] = [];
  private readonly maxTex: number;
  private frameStats = { drawCalls: 0, sprites: 0 };

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.camera = new Camera(width, height);
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    this.program = this.createProgram(VS, FS);
    this.uView = gl.getUniformLocation(this.program, 'uView');
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Failed to create GL buffers');
    this.vao = vao;
    this.vbo = vbo;
    const buf = new ArrayBuffer(MAX_VERTS * FLOATS_PER_VERT * 4);
    this.f32 = new Float32Array(buf);
    this.u32 = new Uint32Array(buf);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, stride, 16);
    gl.bindVertexArray(null);

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uTex'), 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.applyBlend();

    this.setFont('default', '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif', 'bold');
    this.setFont('mono', 'ui-monospace, "Cascadia Mono", Consolas, Menlo, "Courier New", monospace', 'bold');
  }

  // -------------------------------------------------------------------------
  // Setup / textures
  // -------------------------------------------------------------------------

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile error: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link error: ' + gl.getProgramInfoLog(p));
    return p;
  }

  /** Register (or replace) a font for drawText. `family` is a CSS font-family list (load webfonts first). */
  setFont(name: string, family: string, weight = 'normal'): void {
    const old = this.fonts.get(name);
    if (old) {
      this.flush();
      this.gl.deleteTexture(old.page.glTexture);
    }
    this.fonts.set(name, new FontAtlas(this.gl, family, weight));
  }

  private setFilter(smooth: boolean): void {
    const gl = this.gl;
    const f = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private newAtlasPage(): AtlasPage {
    const gl = this.gl;
    const size = Math.min(2048, this.maxTex);
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    this.flush();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.setFilter(false);
    const packer = new ShelfPacker(size, size, 2);
    const w = packer.pack(4, 4)!;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, w.x, w.y, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(64).fill(255));
    const ap: AtlasPage = {
      page: { glTexture: tex, width: size, height: size, white: { u: (w.x + 2) / size, v: (w.y + 2) / size } },
      packer,
    };
    this.atlases.push(ap);
    this.page = null;
    return ap;
  }

  /** Upload an image/canvas/bitmap as a Texture (small pixel-art images are packed into shared atlas pages). */
  createTexture(source: TexImageSource, opts: TextureOptions = {}): Texture {
    const gl = this.gl;
    const w = (source as { width: number }).width;
    const h = (source as { height: number }).height;
    if (!(w > 0 && h > 0)) throw new Error('createTexture: source has no size');
    const smooth = opts.smooth ?? this.defaultSmooth;
    const useAtlas = (opts.atlas ?? !smooth) && w <= 1024 && h <= 1024;
    this.flush();
    if (useAtlas) {
      let pos: { x: number; y: number } | null = null;
      let ap: AtlasPage | undefined;
      for (const a of this.atlases) {
        pos = a.packer.pack(w, h);
        if (pos) {
          ap = a;
          break;
        }
      }
      if (!pos || !ap) {
        ap = this.newAtlasPage();
        pos = ap.packer.pack(w, h);
      }
      if (pos) {
        gl.bindTexture(gl.TEXTURE_2D, ap.page.glTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, pos.x, pos.y, gl.RGBA, gl.UNSIGNED_BYTE, source);
        this.page = null;
        const S = ap.page.width;
        return new Texture(ap.page, w, h, pos.x / S, pos.y / S, (pos.x + w) / S, (pos.y + h) / S);
      }
    }
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.setFilter(smooth);
    this.page = null;
    return new Texture({ glTexture: tex, width: w, height: h, white: null }, w, h, 0, 0, 1, 1);
  }

  /** Called by the engine when the canvas backing size changes. */
  resize(pixelW: number, pixelH: number): void {
    this.pixelW = Math.max(1, pixelW);
    this.pixelH = Math.max(1, pixelH);
  }

  // -------------------------------------------------------------------------
  // Frame / state
  // -------------------------------------------------------------------------

  /** Engine-internal: start a frame. */
  beginFrame(): void {
    const gl = this.gl;
    this.frameStats = { drawCalls: 0, sprites: 0 };
    gl.viewport(0, 0, this.pixelW, this.pixelH);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.activeTexture(gl.TEXTURE0);
    this.page = null;
    this.cameraOn = true;
    this.blend = 'normal';
    this.applyBlend();
    this.applyView();
    if (this.background !== null) this.clear(this.background);
  }

  /** Engine-internal: finish a frame. */
  endFrame(): void {
    this.flush();
    this.stats.drawCalls = this.frameStats.drawCalls;
    this.stats.sprites = this.frameStats.sprites;
  }

  /** Clear the whole screen with a color. */
  clear(color: ColorLike = '#000'): void {
    this.flush();
    const c = Color.from(color);
    const gl = this.gl;
    gl.clearColor(c.r * c.a, c.g * c.a, c.b * c.a, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  setBlend(mode: BlendMode): void {
    if (mode === this.blend) return;
    this.flush();
    this.blend = mode;
    this.applyBlend();
  }

  private applyBlend(): void {
    const gl = this.gl;
    if (this.blend === 'additive') gl.blendFunc(gl.ONE, gl.ONE);
    else if (this.blend === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Enable/disable the camera transform (disabled = screen/UI space). */
  setCamera(enabled: boolean): void {
    if (enabled === this.cameraOn) return;
    this.flush();
    this.cameraOn = enabled;
    this.applyView();
  }

  /** Draw in screen space (ignoring the camera) inside `fn`. */
  ui(fn: () => void): void {
    const prev = this.cameraOn;
    this.setCamera(false);
    try {
      fn();
    } finally {
      this.setCamera(prev);
    }
  }

  /** Re-apply the camera transform (call after changing camera mid-frame). */
  applyView(): void {
    let s = 1;
    let ox = 0;
    let oy = 0;
    if (this.cameraOn) [s, ox, oy] = this.camera.transform(this.pixelW / this.width);
    const W = this.width;
    const H = this.height;
    this.gl.uniform4f(this.uView, (2 * s) / W, (-2 * s) / H, (2 * ox) / W - 1, 1 - (2 * oy) / H);
  }

  /** Submit pending geometry. */
  flush(): void {
    if (this.verts === 0 || !this.page) {
      this.verts = 0;
      return;
    }
    const gl = this.gl;
    this.page.prepare?.();
    gl.bindTexture(gl.TEXTURE_2D, this.page.glTexture);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, this.verts * FLOATS_PER_VERT);
    gl.drawArrays(gl.TRIANGLES, 0, this.verts);
    this.frameStats.drawCalls++;
    this.verts = 0;
  }

  private use(page: Page, verts: number): void {
    if (this.page !== page || this.verts + verts > MAX_VERTS) {
      this.flush();
      this.page = page;
    }
  }

  private white(): { u: number; v: number } {
    if (this.page && this.page.white) return this.page.white;
    const f = this.fonts.get('default')!;
    this.use(f.page, 0);
    return f.page.white!;
  }

  private vtx(x: number, y: number, u: number, v: number, c: number): void {
    const i = this.verts * FLOATS_PER_VERT;
    const f = this.f32;
    f[i] = x;
    f[i + 1] = y;
    f[i + 2] = u;
    f[i + 3] = v;
    this.u32[i + 4] = c;
    this.verts++;
  }

  private quad(
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
    u0: number, v0: number, u1: number, v1: number, c: number,
  ): void {
    // corners: 0=TL 1=TR 2=BR 3=BL
    this.vtx(x0, y0, u0, v0, c);
    this.vtx(x1, y1, u1, v0, c);
    this.vtx(x2, y2, u1, v1, c);
    this.vtx(x0, y0, u0, v0, c);
    this.vtx(x2, y2, u1, v1, c);
    this.vtx(x3, y3, u0, v1, c);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** Draw a texture or sprite-sheet frame. (x, y) is where the origin (default top-left) is placed. */
  drawSprite(src: Texture | SpriteSheet, x: number, y: number, o: SpriteOptions = {}): void {
    const tex = src instanceof SpriteSheet ? src.frame(o.frame ?? 0) : src;
    if (!tex) return;
    const sc = o.scale ?? 1;
    const w = o.w ?? tex.width * sc;
    const h = o.h ?? tex.height * sc;
    const ox = (o.originX ?? 0) * w;
    const oy = (o.originY ?? 0) * h;
    let u0 = tex.u0;
    let u1 = tex.u1;
    let v0 = tex.v0;
    let v1 = tex.v1;
    if (o.flipX) [u0, u1] = [u1, u0];
    if (o.flipY) [v0, v1] = [v1, v0];
    const c = (o.tint !== undefined ? Color.from(o.tint) : Color.WHITE).toABGR(o.alpha ?? 1);
    this.use(tex.page, 6);
    this.frameStats.sprites++;
    const lx0 = -ox;
    const ly0 = -oy;
    const lx1 = w - ox;
    const ly1 = h - oy;
    const r = o.rotation ?? 0;
    if (r === 0) {
      this.quad(x + lx0, y + ly0, x + lx1, y + ly0, x + lx1, y + ly1, x + lx0, y + ly1, u0, v0, u1, v1, c);
    } else {
      const cs = Math.cos(r);
      const sn = Math.sin(r);
      this.quad(
        x + lx0 * cs - ly0 * sn, y + lx0 * sn + ly0 * cs,
        x + lx1 * cs - ly0 * sn, y + lx1 * sn + ly0 * cs,
        x + lx1 * cs - ly1 * sn, y + lx1 * sn + ly1 * cs,
        x + lx0 * cs - ly1 * sn, y + lx0 * sn + ly1 * cs,
        u0, v0, u1, v1, c,
      );
    }
  }

  /** Filled rectangle (or outline with `{ outline: thickness }`). */
  drawRect(x: number, y: number, w: number, h: number, color: ColorLike = '#fff', o: ShapeOptions = {}): void {
    if (o.outline) {
      this.strokeRect(x, y, w, h, color, o.outline, o.alpha);
      return;
    }
    const c = Color.from(color).toABGR(o.alpha ?? 1);
    const wt = this.white();
    this.use(this.page!, 6);
    this.quad(x, y, x + w, y, x + w, y + h, x, y + h, wt.u, wt.v, wt.u, wt.v, c);
  }

  /** Rectangle outline (drawn inside the rect bounds). */
  strokeRect(x: number, y: number, w: number, h: number, color: ColorLike = '#fff', thickness = 1, alpha = 1): void {
    const t = Math.min(thickness, w / 2, h / 2);
    this.drawRect(x, y, w, t, color, { alpha });
    this.drawRect(x, y + h - t, w, t, color, { alpha });
    this.drawRect(x, y + t, t, h - 2 * t, color, { alpha });
    this.drawRect(x + w - t, y + t, t, h - 2 * t, color, { alpha });
  }

  /** Line segment of a given thickness. */
  drawLine(x1: number, y1: number, x2: number, y2: number, color: ColorLike = '#fff', thickness = 1, alpha = 1): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const nx = (-dy / len) * thickness * 0.5;
    const ny = (dx / len) * thickness * 0.5;
    const c = Color.from(color).toABGR(alpha);
    const wt = this.white();
    this.use(this.page!, 6);
    this.quad(x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny, wt.u, wt.v, wt.u, wt.v, c);
  }

  /** Filled triangle. */
  drawTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, color: ColorLike = '#fff', alpha = 1): void {
    const c = Color.from(color).toABGR(alpha);
    const wt = this.white();
    this.use(this.page!, 3);
    this.vtx(x1, y1, wt.u, wt.v, c);
    this.vtx(x2, y2, wt.u, wt.v, c);
    this.vtx(x3, y3, wt.u, wt.v, c);
  }

  /** Filled convex polygon from a flat [x0,y0,x1,y1,...] list. */
  drawPolygon(points: readonly number[], color: ColorLike = '#fff', alpha = 1): void {
    const n = points.length >> 1;
    for (let i = 1; i < n - 1; i++)
      this.drawTriangle(points[0]!, points[1]!, points[i * 2]!, points[i * 2 + 1]!, points[i * 2 + 2]!, points[i * 2 + 3]!, color, alpha);
  }

  /** Filled circle (or ring with `{ outline: thickness }`). */
  drawCircle(x: number, y: number, radius: number, color: ColorLike = '#fff', o: ShapeOptions = {}): void {
    if (radius <= 0) return;
    const pr = (radius * this.camera.zoom * this.pixelW) / this.width;
    const seg = o.segments ?? Math.max(12, Math.min(96, Math.ceil(pr * 0.6) + 8));
    const c = Color.from(color).toABGR(o.alpha ?? 1);
    const wt = this.white();
    const step = (Math.PI * 2) / seg;
    if (o.outline) {
      const r0 = Math.max(0, radius - o.outline);
      for (let i = 0; i < seg; i++) {
        const a0 = i * step;
        const a1 = a0 + step;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        this.use(this.page!, 6);
        this.quad(
          x + c0 * radius, y + s0 * radius, x + c1 * radius, y + s1 * radius,
          x + c1 * r0, y + s1 * r0, x + c0 * r0, y + s0 * r0,
          wt.u, wt.v, wt.u, wt.v, c,
        );
      }
      return;
    }
    let px = x + radius;
    let py = y;
    for (let i = 1; i <= seg; i++) {
      const a = i * step;
      const nx = x + Math.cos(a) * radius;
      const ny = y + Math.sin(a) * radius;
      this.use(this.page!, 3);
      this.vtx(x, y, wt.u, wt.v, c);
      this.vtx(px, py, wt.u, wt.v, c);
      this.vtx(nx, ny, wt.u, wt.v, c);
      px = nx;
      py = ny;
    }
  }

  private font(name?: string): FontAtlas {
    return this.fonts.get(name ?? 'default') ?? this.fonts.get('default')!;
  }

  private wrapLines(text: string, f: FontAtlas, scale: number, spacing: number, maxWidth?: number): string[] {
    const raw = text.split('\n');
    if (!maxWidth) return raw;
    const out: string[] = [];
    for (const line of raw) {
      const words = line.split(' ');
      let cur = '';
      for (const w of words) {
        const cand = cur ? cur + ' ' + w : w;
        if (cur && this.lineWidth(cand, f, scale, spacing) > maxWidth) {
          out.push(cur);
          cur = w;
        } else cur = cand;
      }
      out.push(cur);
    }
    return out;
  }

  private lineWidth(line: string, f: FontAtlas, scale: number, spacing: number): number {
    let w = 0;
    let n = 0;
    for (const ch of line) {
      w += f.glyph(ch).adv * scale + spacing;
      n++;
    }
    return n > 0 ? w - spacing : 0;
  }

  /** Size of a text block in game units. */
  measureText(text: string, opts: Pick<TextOptions, 'size' | 'font' | 'letterSpacing' | 'lineHeight' | 'maxWidth'> = {}): { width: number; height: number } {
    const f = this.font(opts.font);
    const size = opts.size ?? 16;
    const scale = size / BASE_FONT;
    const sp = opts.letterSpacing ?? 0;
    const lines = this.wrapLines(String(text), f, scale, sp, opts.maxWidth);
    let width = 0;
    for (const l of lines) width = Math.max(width, this.lineWidth(l, f, scale, sp));
    const lh = size * (opts.lineHeight ?? 1.2);
    return { width, height: lines.length > 0 ? (lines.length - 1) * lh + size * 1.0 : 0 };
  }

  /** Draw text. (x, y) is the anchor given by `align` (left/center/right) and `baseline` (top/middle/bottom). */
  drawText(text: string | number, x: number, y: number, o: TextOptions = {}): void {
    const str = String(text);
    if (o.shadow !== undefined) {
      const off = o.shadowOffset ?? Math.max(1, (o.size ?? 16) / 12);
      this.drawText(str, x + off, y + off, { ...o, color: o.shadow, shadow: undefined });
    }
    const f = this.font(o.font);
    const size = o.size ?? 16;
    const scale = size / BASE_FONT;
    const sp = o.letterSpacing ?? 0;
    const lh = size * (o.lineHeight ?? 1.2);
    const lines = this.wrapLines(str, f, scale, sp, o.maxWidth);
    const c = Color.from(o.color ?? '#fff').toABGR(o.alpha ?? 1);
    const blockH = (lines.length - 1) * lh + size;
    let top = y;
    if (o.baseline === 'middle') top = y - blockH / 2;
    else if (o.baseline === 'bottom') top = y - blockH;
    // Glyph cell top sits a bit above the cap height; center the em box on the line.
    const cellTop = (size - (f.ascent + f.descent) * scale) / 2 - FONT_PAD * scale;
    const align = o.align ?? 'left';
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      let pen = x;
      if (align !== 'left') {
        const w = this.lineWidth(line, f, scale, sp);
        pen = align === 'center' ? x - w / 2 : x - w;
      }
      const gy = top + li * lh + cellTop;
      for (const ch of line) {
        const g = f.glyph(ch);
        if (ch !== ' ') {
          this.use(f.page, 6);
          const gx = pen - FONT_PAD * scale;
          const gw = g.w * scale;
          const gh = g.h * scale;
          this.quad(gx, gy, gx + gw, gy, gx + gw, gy + gh, gx, gy + gh, g.u0, g.v0, g.u1, g.v1, c);
        }
        pen += g.adv * scale + sp;
      }
    }
  }

  /** Free GPU resources. */
  destroy(): void {
    const gl = this.gl;
    for (const a of this.atlases) gl.deleteTexture(a.page.glTexture);
    for (const f of this.fonts.values()) gl.deleteTexture(f.page.glTexture);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
