/** Easing functions + tweens. Pure, DOM-free. */

export type EaseFn = (t: number) => number;

const PI = Math.PI;
const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * PI) / 3;
const c5 = (2 * PI) / 4.5;

const bounceOut: EaseFn = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

/** Standard easing curves (t in 0..1 → progress). */
export const Easing = {
  linear: (t: number) => t,
  quadIn: (t: number) => t * t,
  quadOut: (t: number) => 1 - (1 - t) * (1 - t),
  quadInOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  cubicIn: (t: number) => t * t * t,
  cubicOut: (t: number) => 1 - Math.pow(1 - t, 3),
  cubicInOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  quartIn: (t: number) => t * t * t * t,
  quartOut: (t: number) => 1 - Math.pow(1 - t, 4),
  quartInOut: (t: number) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  sineIn: (t: number) => 1 - Math.cos((t * PI) / 2),
  sineOut: (t: number) => Math.sin((t * PI) / 2),
  sineInOut: (t: number) => -(Math.cos(PI * t) - 1) / 2,
  expoIn: (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  expoOut: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoInOut: (t: number) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  backIn: (t: number) => c3 * t * t * t - c1 * t * t,
  backOut: (t: number) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  backInOut: (t: number) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,
  elasticIn: (t: number) =>
    t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4),
  elasticOut: (t: number) =>
    t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1,
  elasticInOut: (t: number) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
          : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1,
  bounceIn: (t: number) => 1 - bounceOut(1 - t),
  bounceOut,
  bounceInOut: (t: number) => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2),
} satisfies Record<string, EaseFn>;

export type EaseName = keyof typeof Easing;

export interface TweenOptions {
  /** Easing name or function (default "quadOut"). */
  ease?: EaseName | EaseFn;
  /** Seconds to wait before starting. */
  delay?: number;
  /** Number of extra repetitions (-1 = forever). */
  repeat?: number;
  /** Play backwards on every other repetition. */
  yoyo?: boolean;
  onStart?: () => void;
  onUpdate?: (progress: number) => void;
  onComplete?: () => void;
}

type NumericKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

/**
 * Animates numeric properties of `target` toward `to` over `duration` seconds.
 * Call `update(dt)` yourself, or create it through `engine.tweens.to(...)` which updates it for you.
 */
export class Tween<T extends object = Record<string, number>> {
  readonly target: T;
  readonly duration: number;
  private readonly to: Partial<Record<NumericKeys<T>, number>>;
  private from: Record<string, number> | null = null;
  private readonly ease: EaseFn;
  private delay: number;
  private elapsed = 0;
  private repeatsLeft: number;
  private forward = true;
  private readonly opts: TweenOptions;
  /** True once finished (or stopped). */
  done = false;
  /** 0..1 eased progress of the current cycle. */
  progress = 0;
  private resolveFinished: (() => void) | null = null;
  private finishedPromise: Promise<void> | null = null;

  constructor(target: T, to: Partial<Record<NumericKeys<T>, number>>, duration: number, opts: TweenOptions = {}) {
    this.target = target;
    this.to = to;
    this.duration = Math.max(0, duration);
    this.opts = opts;
    const e = opts.ease ?? 'quadOut';
    this.ease = typeof e === 'function' ? e : (Easing[e] ?? Easing.linear);
    this.delay = opts.delay ?? 0;
    this.repeatsLeft = opts.repeat ?? 0;
  }

  /** Resolves when the tween completes or is stopped. */
  get finished(): Promise<void> {
    if (!this.finishedPromise) {
      this.finishedPromise = this.done ? Promise.resolve() : new Promise((r) => (this.resolveFinished = r));
    }
    return this.finishedPromise;
  }

  /** Advance by dt seconds. Returns true while still running. */
  update(dt: number): boolean {
    if (this.done) return false;
    if (this.delay > 0) {
      this.delay -= dt;
      if (this.delay > 0) return true;
      dt = -this.delay;
      this.delay = 0;
    }
    const tgt = this.target as unknown as Record<string, number>;
    if (!this.from) {
      this.from = {};
      for (const k of Object.keys(this.to)) this.from[k] = tgt[k] ?? 0;
      this.opts.onStart?.();
    }
    this.elapsed += dt;
    const t = this.duration === 0 ? 1 : Math.min(1, this.elapsed / this.duration);
    this.apply(t);
    if (t >= 1) {
      if (this.repeatsLeft !== 0) {
        if (this.repeatsLeft > 0) this.repeatsLeft--;
        this.elapsed -= this.duration;
        if (this.opts.yoyo) this.forward = !this.forward;
        return true;
      }
      this.finish();
      this.opts.onComplete?.();
      return false;
    }
    return true;
  }

  private apply(t: number): void {
    const p = this.ease(this.forward ? t : 1 - t);
    this.progress = p;
    const tgt = this.target as unknown as Record<string, number>;
    const to = this.to as Record<string, number>;
    for (const k in to) {
      const a = this.from![k]!;
      tgt[k] = a + (to[k]! - a) * p;
    }
    this.opts.onUpdate?.(p);
  }

  private finish(): void {
    this.done = true;
    this.resolveFinished?.();
  }

  /** Stop immediately (optionally jumping to the end values). onComplete is NOT called. */
  stop(jumpToEnd = false): void {
    if (this.done) return;
    if (jumpToEnd) {
      if (!this.from) {
        const tgt = this.target as unknown as Record<string, number>;
        this.from = {};
        for (const k of Object.keys(this.to)) this.from[k] = tgt[k] ?? 0;
      }
      this.forward = true;
      this.apply(1);
    }
    this.finish();
  }
}

/** Owns a set of tweens and updates them every fixed step (exposed as `engine.tweens`). */
export class TweenManager {
  private tweens: Tween<any>[] = [];

  to<T extends object>(target: T, props: Partial<Record<NumericKeys<T>, number>>, duration: number, opts?: TweenOptions): Tween<T> {
    const t = new Tween(target, props, duration, opts);
    this.tweens.push(t);
    return t;
  }

  add<T extends object>(tween: Tween<T>): Tween<T> {
    this.tweens.push(tween);
    return tween;
  }

  update(dt: number): void {
    if (this.tweens.length === 0) return;
    const list = this.tweens;
    this.tweens = [];
    const keep: Tween<any>[] = [];
    for (const t of list) if (t.update(dt)) keep.push(t);
    // Tweens created during callbacks were pushed to the fresh array.
    this.tweens = keep.concat(this.tweens);
  }

  /** Stop all tweens on `target`. */
  killTweensOf(target: object): void {
    for (const t of this.tweens) if (t.target === target) t.stop();
    this.tweens = this.tweens.filter((t) => !t.done);
  }

  clear(): void {
    for (const t of this.tweens) t.stop();
    this.tweens = [];
  }

  get count(): number {
    return this.tweens.length;
  }
}

/** Simple timer scheduler (exposed via `engine.after` / `engine.every`). */
export class Timers {
  private items: { t: number; interval: number; fn: () => void; repeat: boolean; cancelled: boolean }[] = [];

  after(seconds: number, fn: () => void): { cancel(): void } {
    const item = { t: seconds, interval: seconds, fn, repeat: false, cancelled: false };
    this.items.push(item);
    return { cancel: () => void (item.cancelled = true) };
  }

  every(seconds: number, fn: () => void): { cancel(): void } {
    const item = { t: seconds, interval: Math.max(1e-4, seconds), fn, repeat: true, cancelled: false };
    this.items.push(item);
    return { cancel: () => void (item.cancelled = true) };
  }

  update(dt: number): void {
    const list = this.items;
    this.items = [];
    const keep: typeof list = [];
    for (const it of list) {
      if (it.cancelled) continue;
      it.t -= dt;
      let alive = true;
      while (it.t <= 0 && !it.cancelled) {
        it.fn();
        if (it.repeat) it.t += it.interval;
        else {
          alive = false;
          break;
        }
      }
      if (alive && !it.cancelled) keep.push(it);
    }
    this.items = keep.concat(this.items);
  }

  clear(): void {
    this.items = [];
  }
}
