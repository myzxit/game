/**
 * Player settings.
 *
 * Graphics presets are the important part: the Low preset must stay genuinely
 * playable on integrated graphics, and — the rule that matters — it may reduce
 * *decoration* but never gameplay legibility. Enemies, tracers, hitmarkers,
 * ammo and objectives are rendered identically at every preset; what changes is
 * shadows, post-processing, particle counts, detail props and draw distance.
 *
 * Settings are persisted to localStorage immediately and synced to the server
 * so they follow the player between machines.
 */

import { DEFAULT_LOCALE, clamp, type LocaleId } from '@titan/shared';

export type GraphicsPreset = 'low' | 'medium' | 'high' | 'custom';
export type ColorblindMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';

export interface GraphicsSettings {
  preset: GraphicsPreset;
  /** Render scale, 0.5-1.0. The cheapest lever on a weak GPU. */
  resolutionScale: number;
  fpsLimit: number;
  shadows: boolean;
  /** Shadow map size. */
  shadowQuality: 512 | 1024 | 2048;
  postProcessing: boolean;
  bloom: boolean;
  /** 0 = off, 1 = full. Scales particle counts. */
  vfxQuality: number;
  particleDensity: number;
  /** Fog far plane multiplier. */
  viewDistance: number;
  antialiasing: boolean;
  anisotropy: number;
  /** Decorative props marked detailOnly are skipped when false. */
  detailProps: boolean;
  reflections: boolean;
  /** Maximum dynamic lights. Point lights are the main cost on low-end GPUs. */
  maxDynamicLights: number;
}

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  voice: number;
  ui: number;
  ambience: number;
  spatial: boolean;
}

export interface ControlSettings {
  sensitivity: number;
  adsSensitivityMultiplier: number;
  invertY: boolean;
  toggleAds: boolean;
  toggleCrouch: boolean;
  toggleSprint: boolean;
  gamepadSensitivity: number;
  /** Action -> KeyboardEvent.code */
  keybinds: Record<string, string>;
  touchLayout: 'default' | 'left-handed';
}

export interface GameplaySettings {
  fov: number;
  crosshairColor: string;
  crosshairSize: number;
  crosshairGap: number;
  crosshairDot: boolean;
  damageNumbers: boolean;
  hitmarkers: boolean;
  killfeed: boolean;
  minimapRotate: boolean;
  showFps: boolean;
  showPing: boolean;
}

export interface AccessibilitySettings {
  /** 0 = no camera shake at all. */
  cameraShake: number;
  reduceMotion: boolean;
  textScale: number;
  subtitles: boolean;
  subtitleScale: number;
  colorblind: ColorblindMode;
  highContrast: boolean;
  /** Caps bloom and muzzle-flash intensity for photosensitivity. */
  reduceFlashing: boolean;
  /** Shows an on-screen indicator for important sounds. */
  visualAudioCues: boolean;
}

export interface Settings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  gameplay: GameplaySettings;
  accessibility: AccessibilitySettings;
  locale: LocaleId;
}

export const DEFAULT_KEYBINDS: Record<string, string> = {
  moveForward: 'KeyW',
  moveBack: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  jump: 'Space',
  crouch: 'ControlLeft',
  sprint: 'ShiftLeft',
  reload: 'KeyR',
  dash: 'KeyQ',
  skill: 'KeyE',
  melee: 'KeyV',
  interact: 'KeyF',
  inspect: 'KeyH',
  weapon1: 'Digit1',
  weapon2: 'Digit2',
  weapon3: 'Digit3',
  scoreboard: 'Tab',
  chat: 'Enter',
  map: 'KeyM',
};

/** Preset definitions. `custom` is whatever the player last set. */
export const GRAPHICS_PRESETS: Record<Exclude<GraphicsPreset, 'custom'>, GraphicsSettings> = {
  low: {
    preset: 'low',
    resolutionScale: 0.72,
    fpsLimit: 60,
    shadows: false,
    shadowQuality: 512,
    postProcessing: false,
    bloom: false,
    vfxQuality: 0.4,
    particleDensity: 0.35,
    viewDistance: 0.6,
    antialiasing: false,
    anisotropy: 1,
    detailProps: false,
    reflections: false,
    maxDynamicLights: 4,
  },
  medium: {
    preset: 'medium',
    resolutionScale: 0.9,
    fpsLimit: 120,
    shadows: true,
    shadowQuality: 1024,
    postProcessing: true,
    bloom: true,
    vfxQuality: 0.75,
    particleDensity: 0.7,
    viewDistance: 0.85,
    antialiasing: true,
    anisotropy: 4,
    detailProps: true,
    reflections: false,
    maxDynamicLights: 10,
  },
  high: {
    preset: 'high',
    resolutionScale: 1,
    fpsLimit: 240,
    shadows: true,
    shadowQuality: 2048,
    postProcessing: true,
    bloom: true,
    vfxQuality: 1,
    particleDensity: 1,
    viewDistance: 1,
    antialiasing: true,
    anisotropy: 8,
    detailProps: true,
    reflections: true,
    maxDynamicLights: 24,
  },
};

export function defaultSettings(): Settings {
  return {
    graphics: { ...GRAPHICS_PRESETS.medium },
    audio: { master: 0.8, music: 0.5, sfx: 1, voice: 1, ui: 0.8, ambience: 0.7, spatial: true },
    controls: {
      sensitivity: 0.0022,
      adsSensitivityMultiplier: 0.75,
      invertY: false,
      toggleAds: false,
      toggleCrouch: false,
      toggleSprint: false,
      gamepadSensitivity: 2.4,
      keybinds: { ...DEFAULT_KEYBINDS },
      touchLayout: 'default',
    },
    gameplay: {
      fov: 90,
      crosshairColor: '#4ef0a0',
      crosshairSize: 6,
      crosshairGap: 4,
      crosshairDot: true,
      damageNumbers: true,
      hitmarkers: true,
      killfeed: true,
      minimapRotate: true,
      showFps: false,
      showPing: true,
    },
    accessibility: {
      cameraShake: 1,
      reduceMotion: false,
      textScale: 1,
      subtitles: false,
      subtitleScale: 1,
      colorblind: 'none',
      highContrast: false,
      reduceFlashing: false,
      visualAudioCues: false,
    },
    locale: DEFAULT_LOCALE,
  };
}

const STORAGE_KEY = 'titan.settings.v1';

type Listener = (settings: Settings) => void;

export class SettingsStore {
  private settings: Settings = defaultSettings();
  private readonly listeners = new Set<Listener>();
  /** Called when settings change, so they can be pushed to the server. */
  onSync: ((settings: Settings) => void) | null = null;

  constructor() {
    this.load();
  }

  get current(): Settings {
    return this.settings;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.settings);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.settings);
      } catch (error) {
        console.error('[Settings] listener failed', error);
      }
    }
  }

  /** Apply a partial update to one section. */
  update<K extends keyof Settings>(section: K, patch: Partial<Settings[K]>): void {
    this.settings = {
      ...this.settings,
      [section]: { ...(this.settings[section] as object), ...patch },
    } as Settings;

    // Any manual graphics change moves the player off a named preset, so the
    // UI stops claiming they are on "Medium" when they are not.
    if (section === 'graphics' && !('preset' in patch)) {
      this.settings.graphics.preset = 'custom';
    }

    this.clampAll();
    this.persist();
    this.notify();
  }

  setLocale(locale: LocaleId): void {
    this.settings.locale = locale;
    this.persist();
    this.notify();
  }

  applyPreset(preset: Exclude<GraphicsPreset, 'custom'>): void {
    this.settings.graphics = { ...GRAPHICS_PRESETS[preset] };
    this.persist();
    this.notify();
  }

  setKeybind(action: string, code: string): void {
    // A key can only be bound to one action; rebinding clears the old owner.
    for (const [existing, bound] of Object.entries(this.settings.controls.keybinds)) {
      if (bound === code && existing !== action) delete this.settings.controls.keybinds[existing];
    }
    this.settings.controls.keybinds[action] = code;
    this.persist();
    this.notify();
  }

  resetKeybinds(): void {
    this.settings.controls.keybinds = { ...DEFAULT_KEYBINDS };
    this.persist();
    this.notify();
  }

  reset(): void {
    this.settings = defaultSettings();
    this.persist();
    this.notify();
  }

  /** Keep every value inside a range the renderer and audio engine can handle. */
  private clampAll(): void {
    const g = this.settings.graphics;
    g.resolutionScale = clamp(g.resolutionScale, 0.5, 1);
    g.vfxQuality = clamp(g.vfxQuality, 0, 1);
    g.particleDensity = clamp(g.particleDensity, 0, 1);
    g.viewDistance = clamp(g.viewDistance, 0.4, 1.5);
    g.fpsLimit = clamp(Math.round(g.fpsLimit), 30, 480);
    g.maxDynamicLights = clamp(Math.round(g.maxDynamicLights), 0, 48);

    const a = this.settings.audio;
    for (const key of ['master', 'music', 'sfx', 'voice', 'ui', 'ambience'] as const) {
      a[key] = clamp(a[key], 0, 1);
    }

    const c = this.settings.controls;
    c.sensitivity = clamp(c.sensitivity, 0.0002, 0.02);
    c.adsSensitivityMultiplier = clamp(c.adsSensitivityMultiplier, 0.1, 2);
    c.gamepadSensitivity = clamp(c.gamepadSensitivity, 0.5, 8);

    const p = this.settings.gameplay;
    p.fov = clamp(p.fov, 70, 120);
    p.crosshairSize = clamp(p.crosshairSize, 1, 20);
    p.crosshairGap = clamp(p.crosshairGap, 0, 20);

    const acc = this.settings.accessibility;
    acc.cameraShake = clamp(acc.cameraShake, 0, 1);
    acc.textScale = clamp(acc.textScale, 0.8, 1.6);
    acc.subtitleScale = clamp(acc.subtitleScale, 0.8, 2);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Private browsing, or storage disabled. Settings still work for this
      // session; there is nothing useful to tell the player here.
    }
    this.onSync?.(this.settings);
  }

  private load(): void {
    let stored: unknown;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      stored = JSON.parse(raw);
    } catch {
      return;
    }
    this.merge(stored);
  }

  /** Merge stored settings over the defaults, ignoring anything unrecognised. */
  merge(stored: unknown): void {
    if (typeof stored !== 'object' || stored === null) return;
    const source = stored as Record<string, unknown>;
    const base = defaultSettings();

    const mergeSection = <K extends keyof Settings>(key: K): void => {
      const value = source[key as string];
      if (typeof value !== 'object' || value === null) return;
      this.settings[key] = { ...(base[key] as object), ...(value as object) } as Settings[K];
    };

    mergeSection('graphics');
    mergeSection('audio');
    mergeSection('controls');
    mergeSection('gameplay');
    mergeSection('accessibility');

    if (typeof source.locale === 'string') {
      this.settings.locale = source.locale as LocaleId;
    }

    // Keybinds need a deep merge so a newly added action gets its default.
    this.settings.controls.keybinds = {
      ...DEFAULT_KEYBINDS,
      ...(this.settings.controls.keybinds ?? {}),
    };

    this.clampAll();
    this.notify();
  }

  /** Shape sent to the server, small enough to pass the settings validator. */
  toPayload(): Record<string, unknown> {
    return {
      graphics: JSON.stringify(this.settings.graphics).slice(0, 500),
      audio: JSON.stringify(this.settings.audio).slice(0, 300),
      gameplay: JSON.stringify(this.settings.gameplay).slice(0, 400),
      accessibility: JSON.stringify(this.settings.accessibility).slice(0, 400),
      controls: this.settings.controls.keybinds,
      sensitivity: this.settings.controls.sensitivity,
      adsSensitivityMultiplier: this.settings.controls.adsSensitivityMultiplier,
      invertY: this.settings.controls.invertY,
      toggleAds: this.settings.controls.toggleAds,
      toggleCrouch: this.settings.controls.toggleCrouch,
      toggleSprint: this.settings.controls.toggleSprint,
      locale: this.settings.locale,
    };
  }

  /** Restore from the server payload written by `toPayload`. */
  fromPayload(payload: Record<string, unknown>): void {
    const parseSection = (key: string): unknown => {
      const raw = payload[key];
      if (typeof raw !== 'string') return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const merged: Record<string, unknown> = {};
    for (const key of ['graphics', 'audio', 'gameplay', 'accessibility']) {
      const value = parseSection(key);
      if (value) merged[key] = value;
    }
    if (typeof payload.locale === 'string') merged.locale = payload.locale;

    const controls: Record<string, unknown> = {};
    if (payload.controls && typeof payload.controls === 'object') {
      controls.keybinds = payload.controls;
    }
    for (const key of [
      'sensitivity',
      'adsSensitivityMultiplier',
      'invertY',
      'toggleAds',
      'toggleCrouch',
      'toggleSprint',
    ]) {
      if (payload[key] !== undefined) controls[key] = payload[key];
    }
    if (Object.keys(controls).length > 0) merged.controls = controls;

    this.merge(merged);
  }
}

/**
 * Suggest a preset from what the browser tells us about the device.
 *
 * This is a starting point, not a verdict — the player can always override it,
 * and the renderer additionally drops the preset if the measured frame rate
 * stays poor (see `Renderer.autoAdjust`).
 */
export function suggestPreset(): Exclude<GraphicsPreset, 'custom'> {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (mobile || memory <= 2 || cores <= 2) return 'low';
  if (memory <= 4 || cores <= 4) return 'medium';
  return 'high';
}
