/** Scene stack. A scene has the same shape as a game object (load/update/render) plus optional hooks. */

export interface Scene<E = unknown> {
  load?(engine: E): void | Promise<void>;
  /** Called when the scene becomes active (after load). */
  enter?(engine: E): void;
  /** Called when the scene is removed. */
  exit?(engine: E): void;
  /** Called when another scene is pushed on top of this one. */
  pause?(engine: E): void;
  /** Called when this scene becomes the top again. */
  resume?(engine: E): void;
  update?(engine: E, dt: number): void;
  render?(engine: E, alpha: number): void;
  /** When true, the scene below keeps rendering underneath (pause menus, dialogs). */
  overlay?: boolean;
  /** When true, the scene below keeps updating too. */
  updateBelow?: boolean;
}

export type SceneLike<E> = Scene<E> | (new (engine: E) => Scene<E>);

export class SceneManager<E = unknown> {
  readonly stack: Scene<E>[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly engine: E) {}

  /** Top-most scene (or undefined). */
  get current(): Scene<E> | undefined {
    return this.stack[this.stack.length - 1];
  }
  get size(): number {
    return this.stack.length;
  }

  private make(s: SceneLike<E>): Scene<E> {
    return typeof s === 'function' ? new s(this.engine) : s;
  }

  // Operations are serialized so async loads can't interleave.
  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Load (awaiting async load()) and push a scene on top. */
  push(s: SceneLike<E>): Promise<Scene<E>> {
    return this.enqueue(async () => {
      const scene = this.make(s);
      await scene.load?.(this.engine);
      this.current?.pause?.(this.engine);
      this.stack.push(scene);
      scene.enter?.(this.engine);
      return scene;
    });
  }

  /** Remove the top scene. */
  pop(): Promise<Scene<E> | undefined> {
    return this.enqueue(() => {
      const top = this.stack.pop();
      top?.exit?.(this.engine);
      this.current?.resume?.(this.engine);
      return top;
    });
  }

  /** Replace the top scene (loads the new one first). */
  replace(s: SceneLike<E>): Promise<Scene<E>> {
    return this.enqueue(async () => {
      const scene = this.make(s);
      await scene.load?.(this.engine);
      const top = this.stack.pop();
      top?.exit?.(this.engine);
      this.stack.push(scene);
      scene.enter?.(this.engine);
      return scene;
    });
  }

  /** Remove every scene. */
  clear(): Promise<void> {
    return this.enqueue(() => {
      while (this.stack.length) this.stack.pop()!.exit?.(this.engine);
    });
  }

  /** Engine-internal: update the top scene (and those below while `updateBelow`). */
  update(dt: number): void {
    let i = this.stack.length - 1;
    while (i > 0 && this.stack[i]!.updateBelow) i--;
    const list = this.stack.slice(i);
    for (const s of list) s.update?.(this.engine, dt);
  }

  /** Engine-internal: render from the lowest visible scene upward. */
  render(alpha: number): void {
    let i = this.stack.length - 1;
    while (i > 0 && this.stack[i]!.overlay) i--;
    const list = this.stack.slice(Math.max(0, i));
    for (const s of list) s.render?.(this.engine, alpha);
  }
}
