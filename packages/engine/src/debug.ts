/**
 * Debug overlay data (F3 or `engine.debug = true`). Pure bookkeeping, testable without WebGL:
 * - `DrawCounter` counts draw calls / sprites per rendered frame (used by the Renderer).
 * - `activity` collects particle emitters and physics worlds that were updated/drawn since the last
 *   collect, so the overlay can show live particle / body counts without the game registering them.
 * - `FrameMeter` smooths FPS and frame time.
 */

/** Per-frame draw statistics. */
export class DrawCounter {
  drawCalls = 0;
  sprites = 0;
  /** Stats of the last completed frame. */
  readonly last = { drawCalls: 0, sprites: 0 };

  begin(): void {
    this.drawCalls = 0;
    this.sprites = 0;
  }
  drawCall(): void {
    this.drawCalls++;
  }
  sprite(n = 1): void {
    this.sprites += n;
  }
  end(): void {
    this.last.drawCalls = this.drawCalls;
    this.last.sprites = this.sprites;
  }
}

interface Countable {
  readonly count: number;
}
interface BodyWorld {
  readonly bodies: readonly { enabled: boolean }[];
}

const emitters = new Set<Countable>();
const worlds = new Set<BodyWorld>();

export const activity = {
  /** Called by ParticleEmitter.update/draw. */
  emitter(e: Countable): void {
    emitters.add(e);
  },
  /** Called by Physics.step. */
  physics(w: BodyWorld): void {
    worlds.add(w);
  },
  /** Live particles and enabled bodies of everything seen since the last call; then resets. */
  collect(): { particles: number; bodies: number; emitters: number; worlds: number } {
    let particles = 0;
    let bodies = 0;
    for (const e of emitters) particles += e.count;
    for (const w of worlds) for (const b of w.bodies) if (b.enabled) bodies++;
    const r = { particles, bodies, emitters: emitters.size, worlds: worlds.size };
    emitters.clear();
    worlds.clear();
    return r;
  },
};

/** Exponentially smoothed FPS and frame time. */
export class FrameMeter {
  fps = 0;
  frameMs = 0;
  /** Smoothing factor per sample (0..1]. */
  constructor(private readonly k = 0.1) {}

  /** Add one frame of `seconds` duration (ignored if <= 0 or absurdly long). */
  sample(seconds: number): void {
    if (!(seconds > 0) || seconds > 1) return;
    const ms = seconds * 1000;
    if (this.frameMs === 0) {
      this.frameMs = ms;
      this.fps = 1 / seconds;
      return;
    }
    this.frameMs += (ms - this.frameMs) * this.k;
    this.fps += (1 / seconds - this.fps) * this.k;
  }
}

export interface DebugStats {
  fps: number;
  frameMs: number;
  /** CPU time spent in update+render this frame (ms). */
  workMs: number;
  drawCalls: number;
  sprites: number;
  tweens: number;
  particles: number;
  bodies: number;
}

/** The overlay text, one entry per line. */
export function debugLines(s: DebugStats): string[] {
  return [
    `FPS ${s.fps.toFixed(0)}  ${s.frameMs.toFixed(1)} ms (cpu ${s.workMs.toFixed(1)})`,
    `draw calls ${s.drawCalls}  sprites ${s.sprites}`,
    `tweens ${s.tweens}  particles ${s.particles}  bodies ${s.bodies}`,
  ];
}
