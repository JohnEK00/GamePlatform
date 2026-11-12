/** Fixed-timestep accumulator (pure). */
export class FixedTimestep {
  private acc = 0;

  constructor(
    /** Seconds per update step (default 1/60). */
    readonly step = 1 / 60,
    /** Largest frame delta accepted, to avoid the "spiral of death" after stalls. */
    readonly maxFrame = 0.25,
  ) {}

  /**
   * Advance real time by `frameDt` seconds, calling `update(step)` zero or more times.
   * Returns the interpolation alpha (0..1) for rendering between the last two steps.
   */
  advance(frameDt: number, update: (dt: number) => void): number {
    if (!(frameDt > 0)) frameDt = 0;
    this.acc += Math.min(frameDt, this.maxFrame);
    // Small epsilon so 60Hz displays don't alternate 0/2 steps due to float jitter.
    while (this.acc >= this.step - 1e-6) {
      update(this.step);
      this.acc -= this.step;
    }
    if (this.acc < 0) this.acc = 0;
    return this.acc / this.step;
  }

  reset(): void {
    this.acc = 0;
  }
}
