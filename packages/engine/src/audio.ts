/** WebAudio wrapper: sound playback, master volume/mute, gesture unlock and a tiny SFX synth. */

/** A decoded sound (from engine.assets.loadSound or engine.audio.createSound). */
export class Sound {
  constructor(readonly buffer: AudioBuffer | null) {}
  get duration(): number {
    return this.buffer?.duration ?? 0;
  }
}

export interface PlayOptions {
  /** 0..1+ (default 1). */
  volume?: number;
  loop?: boolean;
  /** Playback rate (1 = normal; 2 = octave up). */
  pitch?: number;
  /** Stereo pan -1 (left) .. 1 (right). */
  pan?: number;
}

export interface SoundHandle {
  stop(): void;
  setVolume(v: number): void;
  readonly playing: boolean;
}

export interface ToneOptions {
  /** Start frequency in Hz (default 440). */
  freq?: number;
  /** End frequency for a slide (default = freq). */
  freqEnd?: number;
  /** Seconds (default 0.15). */
  duration?: number;
  type?: OscillatorType;
  volume?: number;
  /** Attack seconds (default 0.005). */
  attack?: number;
  /** Vibrato depth in Hz. */
  vibrato?: number;
  vibratoRate?: number;
}

export interface NoiseOptions {
  duration?: number;
  volume?: number;
  /** Low-pass cutoff start/end in Hz (default 4000 → 400). */
  filterStart?: number;
  filterEnd?: number;
}

const NOOP_HANDLE: SoundHandle = { stop() {}, setVolume() {}, playing: false };

type AudioCtor = typeof AudioContext;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 1;
  private _muted = false;
  private suspendedByEngine = false;
  private noiseBuf: AudioBuffer | null = null;
  private readonly active = new Set<AudioBufferSourceNode | OscillatorNode>();
  /** True once the browser allowed audio to start (after a user gesture). */
  unlocked = false;

  /** Lazily create the AudioContext (null if WebAudio is unavailable). */
  get context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const g = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** Attach gesture listeners that resume the AudioContext (browsers require a user gesture). */
  attachUnlock(target: EventTarget = window): () => void {
    const events = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
    const handler = (): void => {
      this.unlock();
      if (this.unlocked) for (const e of events) target.removeEventListener(e, handler, true);
    };
    for (const e of events) target.addEventListener(e, handler, true);
    return () => {
      for (const e of events) target.removeEventListener(e, handler, true);
    };
  }

  unlock(): void {
    const ctx = this.context;
    if (!ctx) return;
    if (ctx.state === 'suspended' && !this.suspendedByEngine) void ctx.resume().catch(() => {});
    // Play a silent buffer (old iOS).
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
    this.unlocked = true;
  }

  get masterVolume(): number {
    return this.volume;
  }
  set masterVolume(v: number) {
    this.volume = Math.max(0, v);
    if (this.master && !this._muted) this.master.gain.value = this.volume;
  }

  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  /** Engine-internal: suspend/resume output on pause. */
  setSuspended(s: boolean): void {
    this.suspendedByEngine = s;
    const ctx = this.ctx;
    if (!ctx) return;
    if (s && ctx.state === 'running') void ctx.suspend().catch(() => {});
    if (!s && ctx.state === 'suspended' && this.unlocked) void ctx.resume().catch(() => {});
  }

  /** Decode encoded audio bytes into a Sound. */
  async decode(data: ArrayBuffer): Promise<Sound> {
    const ctx = this.context;
    if (!ctx) return new Sound(null);
    const buf = await new Promise<AudioBuffer>((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
    return new Sound(buf);
  }

  /** Generate a sound procedurally: `fn(t, i)` returns a sample in -1..1 for time t (seconds). */
  createSound(seconds: number, fn: (t: number, i: number) => number, sampleRate = 44100): Sound {
    const ctx = this.context;
    if (!ctx) return new Sound(null);
    const n = Math.max(1, Math.floor(seconds * sampleRate));
    const buf = ctx.createBuffer(1, n, sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.max(-1, Math.min(1, fn(i / sampleRate, i)));
    return new Sound(buf);
  }

  /** Play a Sound. Returns a handle with stop(). Safe to call before unlock (it just queues silently). */
  play(sound: Sound | null | undefined, o: PlayOptions = {}): SoundHandle {
    const ctx = this.context;
    if (!ctx || !this.master || !sound || !sound.buffer) return NOOP_HANDLE;
    // Don't pile up one-shot sounds while audio is locked/suspended.
    if (ctx.state !== 'running' && !o.loop) return NOOP_HANDLE;
    const src = ctx.createBufferSource();
    src.buffer = sound.buffer;
    src.loop = !!o.loop;
    src.playbackRate.value = o.pitch ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = o.volume ?? 1;
    let node: AudioNode = src;
    node.connect(gain);
    node = gain;
    if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      node.connect(p);
      node = p;
    }
    node.connect(this.master);
    let playing = true;
    src.onended = () => {
      playing = false;
      this.active.delete(src);
    };
    this.active.add(src);
    src.start();
    return {
      stop: () => {
        if (!playing) return;
        playing = false;
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        this.active.delete(src);
      },
      setVolume: (v: number) => void (gain.gain.value = v),
      get playing() {
        return playing;
      },
    };
  }

  /** Play a synthesized tone — handy for retro sound effects without assets. */
  tone(o: ToneOptions = {}): SoundHandle {
    const ctx = this.context;
    if (!ctx || !this.master || ctx.state !== 'running') return NOOP_HANDLE;
    const t0 = ctx.currentTime;
    const dur = o.duration ?? 0.15;
    const f0 = o.freq ?? 440;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'square';
    osc.frequency.setValueAtTime(f0, t0);
    if (o.freqEnd !== undefined && o.freqEnd !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t0 + dur);
    const g = ctx.createGain();
    const vol = (o.volume ?? 0.25) * 0.5;
    const atk = Math.min(o.attack ?? 0.005, dur / 2);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = o.vibratoRate ?? 8;
      lg.gain.value = o.vibrato;
      lfo.connect(lg);
      lg.connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.05);
    }
    return this.track(osc, t0, dur);
  }

  /** Play a burst of filtered noise (explosions, hits, whooshes). */
  noise(o: NoiseOptions = {}): SoundHandle {
    const ctx = this.context;
    if (!ctx || !this.master || ctx.state !== 'running') return NOOP_HANDLE;
    if (!this.noiseBuf) {
      const n = ctx.sampleRate * 2;
      this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = ctx.currentTime;
    const dur = o.duration ?? 0.3;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(o.filterStart ?? 4000, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.filterEnd ?? 400), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, (o.volume ?? 0.3) * 0.6), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    return this.track(src, t0, dur);
  }

  private track(node: AudioBufferSourceNode | OscillatorNode, t0: number, dur: number): SoundHandle {
    let playing = true;
    node.onended = () => {
      playing = false;
      this.active.delete(node);
    };
    this.active.add(node);
    node.start(t0);
    node.stop(t0 + dur + 0.02);
    return {
      stop: () => {
        if (!playing) return;
        playing = false;
        try {
          node.stop();
        } catch {
          /* ignore */
        }
        this.active.delete(node);
      },
      setVolume: () => {},
      get playing() {
        return playing;
      },
    };
  }

  /** Stop every playing sound. */
  stopAll(): void {
    for (const n of this.active) {
      try {
        n.stop();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
  }
}
