/**
 * Pixelforge — a small, dependency-free WebGL2 2D game engine.
 * Games receive the Engine instance; this module's named exports are for hosts and TypeScript users.
 */
export { boot, Engine, VERSION } from './engine';
export type { BootOptions, Game, GameLike } from './engine';

export { Assets } from './assets';
export { AudioManager, Sound } from './audio';
export type { PlayOptions, SoundHandle, ToneOptions, NoiseOptions } from './audio';
export { Camera } from './camera';
export {
  Input, InputState, GamepadState, GamepadButtons, computeLetterbox, clientToGame, combineAxis,
} from './input';
export type { MouseState, TouchPoint, Letterbox, GamepadButtonName } from './input';
export { FixedTimestep } from './loop';
export {
  Vec2, Rect, Color, Random, MathUtil, clamp, lerp, invLerp, remap, approach, wrap, degToRad, radToDeg, damp,
  circlesOverlap, circleRectOverlap,
} from './math';
export type { Point, RectLike, ColorLike } from './math';
export { ParticleEmitter } from './particles';
export type { EmitterConfig, Range } from './particles';
export { Physics, Body } from './physics';
export type { BodyOptions, PhysicsOptions, Side } from './physics';
export { Platform, Storage } from './platform';
export type { PlatformMessage } from './platform';
export { Renderer } from './renderer';
export type { SpriteOptions, ShapeOptions, TextOptions, TextureOptions, BlendMode, TextAlign, TextBaseline } from './renderer';
export { SceneManager } from './scenes';
export type { Scene, SceneLike } from './scenes';
export { Texture, SpriteSheet, Animation, ShelfPacker } from './texture';
export type { TexturePage } from './texture';
export { Tilemap } from './tilemap';
export type { TilemapJSON, TileRef, TileDrawFn } from './tilemap';
export { Tween, TweenManager, Timers, Easing } from './tween';
export type { EaseFn, EaseName, TweenOptions } from './tween';
