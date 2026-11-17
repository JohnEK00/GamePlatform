/**
 * Pixelforge — a small, dependency-free WebGL2 2D game engine.
 * Games receive the Engine instance; this module's named exports are for hosts and TypeScript users.
 */
export { boot, Engine, VERSION, MAX_OVERRIDE_KEYS, isOverridesObject } from './engine';
export type { BootOptions, Game, GameLike } from './engine';

export { Assets } from './assets';
export { BitmapFont, parseBMFont, layoutText, RESERVED_FONT_NAMES } from './bmfont';
export type { BitmapFontData, BitmapGlyph, Kerning, GridFontOptions, FontMetricsSource, LayoutOptions, TextLayout, LaidGlyph, PageRegion } from './bmfont';
export { NineSlice, nineSliceQuads } from './nineslice';
export type { Insets, NineSliceOptions, NineQuad } from './nineslice';
export { Ui, defaultTheme } from './ui';
export type {
  UiTheme, ButtonOptions, PanelOptions, UiInput, UiRenderer, UiDeps, SliderOptions, ToggleOptions, TextFieldOptions, ListOptions,
} from './ui';
export { filterText, applyTextEvents, visibleRun, caretFromX, truncateToWidth, TEXT_EDIT_KEYS } from './uitext';
export type { TextEvent, MeasureFn, TextEditOptions } from './uitext';
export { PIXEL_GLYPHS, pixelFontData } from './pixelfont';
export { AudioManager, Sound } from './audio';
export type { PlayOptions, SoundHandle, ToneOptions, NoiseOptions } from './audio';
export { Camera } from './camera';
export { screenshotSize, FrameCapture } from './capture';
export type { ScreenshotOptions, ShareScreenshotOptions, ScreenshotError, CaptureResult, FrameGrabber } from './capture';
export {
  Input, InputState, GamepadState, GamepadButtons, computeLetterbox, clientToGame, combineAxis,
} from './input';
export type { MouseState, TouchPoint, Letterbox, GamepadButtonKey, InputDevice } from './input';
export {
  BINDABLE_KEYS, GAMEPAD_BUTTON_NAMES, keyLabel, gamepadLabel, parseActions, applyOverrides, ActionMap,
  isBindableKey, isGamepadButtonName, MAX_ACTIONS, MAX_ACTION_KEYS, MAX_ACTION_GAMEPAD, ACTION_NAME_MAX, ACTION_ID_RE,
} from './actions';
export type { ControlAction, GamepadButtonName, GamepadOverrides, ButtonSource, PadSource } from './actions';
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
export {
  Platform, Storage, ACHIEVEMENT_ID_RE, LEADERBOARD_TIMEOUT_MS, SCORE_RESULT_TIMEOUT_MS, MAX_PENDING_LEADERBOARD,
  SHARE_INTERVAL_MS, SHARE_RESULT_TIMEOUT_MS, sanitizeCaption,
} from './platform';
export type { LeaderboardPeriod, LeaderboardView, ScoreResultView, PlatformReply } from './platform';
export { BundleFiles, deriveStorageKey, mimeType, normalizePath } from './files';
export type { FileMap, FileData } from './files';
export { DrawCounter, FrameMeter, debugLines } from './debug';
export type { DebugStats } from './debug';
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
