/**
 * Audio configuration.
 *
 * The client's audio engine is procedural (WebAudio synthesis) because this
 * build ships no recorded audio files — see docs/ASSETS.md for the sample specs
 * a real production build would drop in. Every entry here is therefore both a
 * *sample key* (for when real assets exist) and a *synthesis recipe* (used now).
 * The AudioEngine prefers a loaded sample and falls back to synthesis.
 */

import { SurfaceMaterial } from '../types/domain.js';

export enum AudioBus {
  Master = 'master',
  Music = 'music',
  Sfx = 'sfx',
  Voice = 'voice',
  Ui = 'ui',
  Ambience = 'ambience',
}

/** Recipe for procedurally synthesising a sound when no sample is available. */
export interface SynthRecipe {
  /** Base oscillator type or noise. */
  source: 'noise' | 'sine' | 'square' | 'saw' | 'triangle';
  /** Start/end frequency in Hz (pitch sweep). */
  freqStart: number;
  freqEnd: number;
  /** ADSR in seconds. */
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Band-pass/low-pass filter sweep. */
  filterStart: number;
  filterEnd: number;
  filterQ: number;
  /** Peak gain 0..1. */
  gain: number;
  /** Layered second source for body (e.g. a low thump under a rifle crack). */
  layer?: Omit<SynthRecipe, 'layer'>;
  /** Distortion amount 0..1. */
  drive?: number;
}

export interface SoundDefinition {
  key: string;
  bus: AudioBus;
  /** Sample file, if the asset pack provides one. */
  sampleKey?: string;
  /** Random pitch variation, ± this fraction. */
  pitchVariance: number;
  /** Base volume 0..1. */
  volume: number;
  /** Distance at which the sound is inaudible; 0 = 2D (UI/music). */
  maxDistance: number;
  /** Reference distance for the rolloff curve. */
  refDistance: number;
  /** Only one instance of this key can play at a time. */
  exclusive?: boolean;
  /** Minimum ms between retriggers — protects against machine-gun spam. */
  cooldownMs?: number;
  synth: SynthRecipe;
}

const s = (
  key: string,
  bus: AudioBus,
  volume: number,
  maxDistance: number,
  synth: SynthRecipe,
  extra: Partial<SoundDefinition> = {},
): SoundDefinition => ({
  key,
  bus,
  volume,
  maxDistance,
  refDistance: Math.max(1, maxDistance * 0.08),
  pitchVariance: 0.06,
  synth,
  ...extra,
});

export const SOUNDS: readonly SoundDefinition[] = [
  // ------------------------------------------------------------ Weapons --
  s('sfx.weapon.tr9_sentinel.fire', AudioBus.Sfx, 0.85, 180, {
    source: 'noise', freqStart: 2200, freqEnd: 380, attack: 0.001, decay: 0.055, sustain: 0, release: 0.09,
    filterStart: 5200, filterEnd: 700, filterQ: 1.4, gain: 0.9, drive: 0.35,
    layer: { source: 'square', freqStart: 180, freqEnd: 62, attack: 0.001, decay: 0.09, sustain: 0, release: 0.12, filterStart: 900, filterEnd: 160, filterQ: 0.9, gain: 0.55 },
  }),
  s('sfx.weapon.ak_ridgeline.fire', AudioBus.Sfx, 0.95, 200, {
    source: 'noise', freqStart: 1900, freqEnd: 300, attack: 0.001, decay: 0.075, sustain: 0, release: 0.13,
    filterStart: 4400, filterEnd: 520, filterQ: 1.6, gain: 1.0, drive: 0.45,
    layer: { source: 'square', freqStart: 140, freqEnd: 48, attack: 0.001, decay: 0.13, sustain: 0, release: 0.17, filterStart: 700, filterEnd: 110, filterQ: 1.0, gain: 0.7 },
  }),
  s('sfx.weapon.vx3_lattice.fire', AudioBus.Sfx, 0.8, 170, {
    source: 'noise', freqStart: 2600, freqEnd: 460, attack: 0.001, decay: 0.045, sustain: 0, release: 0.07,
    filterStart: 6000, filterEnd: 900, filterQ: 1.2, gain: 0.85, drive: 0.28,
    layer: { source: 'triangle', freqStart: 220, freqEnd: 80, attack: 0.001, decay: 0.07, sustain: 0, release: 0.1, filterStart: 1100, filterEnd: 200, filterQ: 0.8, gain: 0.45 },
  }),
  s('sfx.weapon.vp4_hornet.fire', AudioBus.Sfx, 0.7, 140, {
    source: 'noise', freqStart: 3000, freqEnd: 620, attack: 0.0008, decay: 0.032, sustain: 0, release: 0.05,
    filterStart: 6800, filterEnd: 1300, filterQ: 1.1, gain: 0.75, drive: 0.22,
    layer: { source: 'square', freqStart: 260, freqEnd: 110, attack: 0.001, decay: 0.045, sustain: 0, release: 0.06, filterStart: 1400, filterEnd: 320, filterQ: 0.7, gain: 0.38 },
  }, { pitchVariance: 0.09 }),
  s('sfx.weapon.sk2_cinder.fire', AudioBus.Sfx, 0.75, 150, {
    source: 'noise', freqStart: 2700, freqEnd: 520, attack: 0.001, decay: 0.04, sustain: 0, release: 0.06,
    filterStart: 6000, filterEnd: 1000, filterQ: 1.2, gain: 0.8, drive: 0.26,
    layer: { source: 'square', freqStart: 210, freqEnd: 90, attack: 0.001, decay: 0.06, sustain: 0, release: 0.08, filterStart: 1200, filterEnd: 250, filterQ: 0.8, gain: 0.42 },
  }, { pitchVariance: 0.08 }),
  s('sfx.weapon.br12_fracture.fire', AudioBus.Sfx, 1.0, 220, {
    source: 'noise', freqStart: 1400, freqEnd: 180, attack: 0.001, decay: 0.14, sustain: 0, release: 0.25,
    filterStart: 3200, filterEnd: 260, filterQ: 1.0, gain: 1.0, drive: 0.55,
    layer: { source: 'square', freqStart: 95, freqEnd: 34, attack: 0.001, decay: 0.22, sustain: 0, release: 0.3, filterStart: 420, filterEnd: 70, filterQ: 1.1, gain: 0.85 },
  }),
  s('sfx.weapon.mk7_nightfall.fire', AudioBus.Sfx, 1.0, 400, {
    source: 'noise', freqStart: 2000, freqEnd: 240, attack: 0.001, decay: 0.12, sustain: 0, release: 0.5,
    filterStart: 5000, filterEnd: 300, filterQ: 1.8, gain: 1.0, drive: 0.5,
    layer: { source: 'saw', freqStart: 120, freqEnd: 40, attack: 0.001, decay: 0.3, sustain: 0, release: 0.6, filterStart: 600, filterEnd: 80, filterQ: 1.3, gain: 0.9 },
  }, { pitchVariance: 0.03 }),
  s('sfx.weapon.dm3_verdict.fire', AudioBus.Sfx, 0.9, 300, {
    source: 'noise', freqStart: 2300, freqEnd: 330, attack: 0.001, decay: 0.085, sustain: 0, release: 0.22,
    filterStart: 4800, filterEnd: 480, filterQ: 1.5, gain: 0.95, drive: 0.42,
    layer: { source: 'saw', freqStart: 150, freqEnd: 52, attack: 0.001, decay: 0.16, sustain: 0, release: 0.26, filterStart: 700, filterEnd: 120, filterQ: 1.1, gain: 0.7 },
  }),
  s('sfx.weapon.sp1_ember.fire', AudioBus.Sfx, 0.65, 120, {
    source: 'noise', freqStart: 2800, freqEnd: 500, attack: 0.0008, decay: 0.04, sustain: 0, release: 0.07,
    filterStart: 6200, filterEnd: 1000, filterQ: 1.2, gain: 0.7, drive: 0.25,
    layer: { source: 'square', freqStart: 240, freqEnd: 95, attack: 0.001, decay: 0.055, sustain: 0, release: 0.08, filterStart: 1300, filterEnd: 260, filterQ: 0.8, gain: 0.4 },
  }),
  s('sfx.weapon.arc9_tempest.fire', AudioBus.Sfx, 0.9, 200, {
    source: 'saw', freqStart: 880, freqEnd: 160, attack: 0.004, decay: 0.11, sustain: 0, release: 0.2,
    filterStart: 3400, filterEnd: 400, filterQ: 6.0, gain: 0.9, drive: 0.3,
    layer: { source: 'sine', freqStart: 1600, freqEnd: 300, attack: 0.002, decay: 0.09, sustain: 0, release: 0.15, filterStart: 4000, filterEnd: 900, filterQ: 2.0, gain: 0.5 },
  }),
  s('sfx.weapon.rift_blade.swing', AudioBus.Sfx, 0.6, 30, {
    source: 'noise', freqStart: 900, freqEnd: 2600, attack: 0.02, decay: 0.1, sustain: 0, release: 0.1,
    filterStart: 800, filterEnd: 4200, filterQ: 3.0, gain: 0.6,
  }),

  // Shared weapon mechanics.
  s('sfx.weapon.dryfire', AudioBus.Sfx, 0.45, 20, {
    source: 'square', freqStart: 1200, freqEnd: 400, attack: 0.001, decay: 0.02, sustain: 0, release: 0.02,
    filterStart: 4000, filterEnd: 1200, filterQ: 2.0, gain: 0.45,
  }, { cooldownMs: 180 }),
  s('sfx.weapon.reload_start', AudioBus.Sfx, 0.55, 25, {
    source: 'noise', freqStart: 700, freqEnd: 300, attack: 0.003, decay: 0.07, sustain: 0, release: 0.05,
    filterStart: 2200, filterEnd: 600, filterQ: 2.5, gain: 0.5,
  }),
  s('sfx.weapon.reload_magin', AudioBus.Sfx, 0.6, 25, {
    source: 'noise', freqStart: 520, freqEnd: 180, attack: 0.002, decay: 0.09, sustain: 0, release: 0.06,
    filterStart: 1800, filterEnd: 380, filterQ: 3.0, gain: 0.6,
  }),
  s('sfx.weapon.equip', AudioBus.Sfx, 0.45, 20, {
    source: 'noise', freqStart: 900, freqEnd: 350, attack: 0.002, decay: 0.06, sustain: 0, release: 0.05,
    filterStart: 2600, filterEnd: 700, filterQ: 2.0, gain: 0.45,
  }),
  s('sfx.weapon.casing', AudioBus.Sfx, 0.28, 14, {
    source: 'noise', freqStart: 4200, freqEnd: 2400, attack: 0.001, decay: 0.05, sustain: 0, release: 0.08,
    filterStart: 7000, filterEnd: 3000, filterQ: 5.0, gain: 0.3,
  }, { pitchVariance: 0.22 }),

  // ------------------------------------------------------------ Impacts --
  s('sfx.impact.metal', AudioBus.Sfx, 0.6, 60, {
    source: 'noise', freqStart: 5200, freqEnd: 1400, attack: 0.0005, decay: 0.05, sustain: 0, release: 0.13,
    filterStart: 8000, filterEnd: 2200, filterQ: 7.0, gain: 0.6,
  }, { pitchVariance: 0.18 }),
  s('sfx.impact.concrete', AudioBus.Sfx, 0.55, 55, {
    source: 'noise', freqStart: 2400, freqEnd: 500, attack: 0.0005, decay: 0.06, sustain: 0, release: 0.09,
    filterStart: 4000, filterEnd: 800, filterQ: 1.6, gain: 0.55,
  }, { pitchVariance: 0.16 }),
  s('sfx.impact.wood', AudioBus.Sfx, 0.5, 50, {
    source: 'noise', freqStart: 1600, freqEnd: 320, attack: 0.001, decay: 0.07, sustain: 0, release: 0.1,
    filterStart: 2600, filterEnd: 420, filterQ: 2.2, gain: 0.5,
  }, { pitchVariance: 0.18 }),
  s('sfx.impact.glass', AudioBus.Sfx, 0.65, 70, {
    source: 'noise', freqStart: 7000, freqEnd: 2600, attack: 0.0005, decay: 0.12, sustain: 0, release: 0.3,
    filterStart: 9000, filterEnd: 3500, filterQ: 9.0, gain: 0.65,
  }, { pitchVariance: 0.2 }),
  s('sfx.impact.dirt', AudioBus.Sfx, 0.45, 45, {
    source: 'noise', freqStart: 900, freqEnd: 180, attack: 0.001, decay: 0.06, sustain: 0, release: 0.07,
    filterStart: 1400, filterEnd: 220, filterQ: 1.2, gain: 0.45,
  }, { pitchVariance: 0.2 }),
  s('sfx.impact.water', AudioBus.Sfx, 0.5, 45, {
    source: 'noise', freqStart: 2000, freqEnd: 700, attack: 0.002, decay: 0.09, sustain: 0, release: 0.12,
    filterStart: 3000, filterEnd: 900, filterQ: 2.0, gain: 0.5,
  }, { pitchVariance: 0.2 }),
  s('sfx.impact.flesh', AudioBus.Sfx, 0.55, 40, {
    source: 'noise', freqStart: 700, freqEnd: 140, attack: 0.001, decay: 0.05, sustain: 0, release: 0.06,
    filterStart: 1100, filterEnd: 180, filterQ: 1.4, gain: 0.55,
  }, { pitchVariance: 0.14 }),
  s('sfx.impact.glass_break', AudioBus.Sfx, 0.8, 90, {
    source: 'noise', freqStart: 6000, freqEnd: 1200, attack: 0.001, decay: 0.5, sustain: 0, release: 0.7,
    filterStart: 9000, filterEnd: 1800, filterQ: 4.0, gain: 0.8,
  }),

  // ---------------------------------------------------------- Feedback ---
  s('sfx.hit.marker', AudioBus.Sfx, 0.5, 0, {
    source: 'sine', freqStart: 1400, freqEnd: 1400, attack: 0.001, decay: 0.03, sustain: 0, release: 0.03,
    filterStart: 6000, filterEnd: 6000, filterQ: 1.0, gain: 0.5,
  }, { pitchVariance: 0.02, cooldownMs: 40 }),
  s('sfx.hit.headshot', AudioBus.Sfx, 0.6, 0, {
    source: 'sine', freqStart: 2100, freqEnd: 2600, attack: 0.001, decay: 0.05, sustain: 0, release: 0.05,
    filterStart: 8000, filterEnd: 8000, filterQ: 1.0, gain: 0.6,
  }, { pitchVariance: 0.02, cooldownMs: 40 }),
  s('sfx.hit.kill', AudioBus.Sfx, 0.7, 0, {
    source: 'sine', freqStart: 900, freqEnd: 1800, attack: 0.002, decay: 0.12, sustain: 0, release: 0.12,
    filterStart: 5000, filterEnd: 7000, filterQ: 1.0, gain: 0.7,
  }),
  s('sfx.player.hurt', AudioBus.Sfx, 0.6, 0, {
    source: 'noise', freqStart: 500, freqEnd: 120, attack: 0.002, decay: 0.1, sustain: 0, release: 0.1,
    filterStart: 900, filterEnd: 200, filterQ: 1.2, gain: 0.6,
  }, { cooldownMs: 120 }),
  s('sfx.player.death', AudioBus.Sfx, 0.8, 0, {
    source: 'saw', freqStart: 400, freqEnd: 60, attack: 0.01, decay: 0.6, sustain: 0, release: 0.8,
    filterStart: 1400, filterEnd: 120, filterQ: 2.0, gain: 0.8,
  }),
  s('sfx.player.spawn', AudioBus.Sfx, 0.6, 0, {
    source: 'sine', freqStart: 200, freqEnd: 1200, attack: 0.02, decay: 0.35, sustain: 0, release: 0.3,
    filterStart: 800, filterEnd: 5000, filterQ: 1.5, gain: 0.6,
  }),
  s('sfx.player.land', AudioBus.Sfx, 0.5, 30, {
    source: 'noise', freqStart: 600, freqEnd: 90, attack: 0.001, decay: 0.09, sustain: 0, release: 0.1,
    filterStart: 900, filterEnd: 140, filterQ: 1.2, gain: 0.5,
  }, { pitchVariance: 0.12 }),
  s('sfx.player.jump', AudioBus.Sfx, 0.35, 25, {
    source: 'noise', freqStart: 400, freqEnd: 900, attack: 0.004, decay: 0.05, sustain: 0, release: 0.05,
    filterStart: 700, filterEnd: 1800, filterQ: 1.5, gain: 0.35,
  }, { pitchVariance: 0.14 }),
  s('sfx.player.slide', AudioBus.Sfx, 0.55, 35, {
    source: 'noise', freqStart: 1800, freqEnd: 400, attack: 0.03, decay: 0.5, sustain: 0.2, release: 0.2,
    filterStart: 2600, filterEnd: 600, filterQ: 2.5, gain: 0.55,
  }, { exclusive: true }),

  // ------------------------------------------------------------ Skills ---
  s('sfx.skill.dash', AudioBus.Sfx, 0.65, 45, {
    source: 'noise', freqStart: 300, freqEnd: 2400, attack: 0.008, decay: 0.18, sustain: 0, release: 0.15,
    filterStart: 600, filterEnd: 4000, filterQ: 3.0, gain: 0.65,
  }),
  s('sfx.skill.barrier', AudioBus.Sfx, 0.7, 50, {
    source: 'saw', freqStart: 120, freqEnd: 420, attack: 0.02, decay: 0.4, sustain: 0.1, release: 0.3,
    filterStart: 500, filterEnd: 2000, filterQ: 4.0, gain: 0.7,
  }),
  s('sfx.skill.scan', AudioBus.Sfx, 0.7, 60, {
    source: 'sine', freqStart: 600, freqEnd: 2400, attack: 0.01, decay: 0.5, sustain: 0, release: 0.5,
    filterStart: 2000, filterEnd: 7000, filterQ: 5.0, gain: 0.7,
  }),
  s('sfx.skill.ion', AudioBus.Sfx, 0.9, 120, {
    source: 'noise', freqStart: 1200, freqEnd: 90, attack: 0.002, decay: 0.4, sustain: 0, release: 0.6,
    filterStart: 3000, filterEnd: 150, filterQ: 1.5, gain: 0.95, drive: 0.6,
  }),
  s('sfx.skill.phase', AudioBus.Sfx, 0.6, 40, {
    source: 'triangle', freqStart: 1800, freqEnd: 300, attack: 0.03, decay: 0.4, sustain: 0.1, release: 0.4,
    filterStart: 4000, filterEnd: 800, filterQ: 6.0, gain: 0.6,
  }),
  s('sfx.skill.repair', AudioBus.Sfx, 0.55, 40, {
    source: 'sine', freqStart: 400, freqEnd: 900, attack: 0.05, decay: 0.6, sustain: 0.4, release: 0.4,
    filterStart: 1200, filterEnd: 3000, filterQ: 2.0, gain: 0.55,
  }, { exclusive: true }),

  // ---------------------------------------------------------------- UI ---
  s('ui.click', AudioBus.Ui, 0.4, 0, {
    source: 'sine', freqStart: 900, freqEnd: 700, attack: 0.001, decay: 0.03, sustain: 0, release: 0.03,
    filterStart: 4000, filterEnd: 2000, filterQ: 1.0, gain: 0.4,
  }, { pitchVariance: 0.03 }),
  s('ui.hover', AudioBus.Ui, 0.2, 0, {
    source: 'sine', freqStart: 1400, freqEnd: 1400, attack: 0.001, decay: 0.02, sustain: 0, release: 0.02,
    filterStart: 6000, filterEnd: 6000, filterQ: 1.0, gain: 0.2,
  }, { cooldownMs: 40 }),
  s('ui.back', AudioBus.Ui, 0.35, 0, {
    source: 'sine', freqStart: 700, freqEnd: 420, attack: 0.001, decay: 0.04, sustain: 0, release: 0.04,
    filterStart: 3000, filterEnd: 1400, filterQ: 1.0, gain: 0.35,
  }),
  s('ui.error', AudioBus.Ui, 0.45, 0, {
    source: 'square', freqStart: 320, freqEnd: 180, attack: 0.002, decay: 0.12, sustain: 0, release: 0.1,
    filterStart: 1200, filterEnd: 500, filterQ: 1.5, gain: 0.45,
  }),
  s('ui.purchase', AudioBus.Ui, 0.55, 0, {
    source: 'sine', freqStart: 700, freqEnd: 1500, attack: 0.005, decay: 0.25, sustain: 0, release: 0.2,
    filterStart: 3000, filterEnd: 6000, filterQ: 1.0, gain: 0.55,
  }),
  s('ui.reward', AudioBus.Ui, 0.65, 0, {
    source: 'sine', freqStart: 600, freqEnd: 1800, attack: 0.01, decay: 0.5, sustain: 0.1, release: 0.4,
    filterStart: 2500, filterEnd: 7000, filterQ: 1.2, gain: 0.65,
  }),
  s('ui.levelup', AudioBus.Ui, 0.8, 0, {
    source: 'sine', freqStart: 440, freqEnd: 1760, attack: 0.02, decay: 0.8, sustain: 0.2, release: 0.6,
    filterStart: 2000, filterEnd: 8000, filterQ: 1.0, gain: 0.8,
  }),
  s('ui.rankup', AudioBus.Ui, 0.85, 0, {
    source: 'saw', freqStart: 330, freqEnd: 1320, attack: 0.03, decay: 1.0, sustain: 0.25, release: 0.8,
    filterStart: 1500, filterEnd: 6000, filterQ: 1.4, gain: 0.85,
  }),
  s('ui.quest_complete', AudioBus.Ui, 0.6, 0, {
    source: 'triangle', freqStart: 880, freqEnd: 1320, attack: 0.01, decay: 0.4, sustain: 0.1, release: 0.3,
    filterStart: 4000, filterEnd: 6000, filterQ: 1.0, gain: 0.6,
  }),
  s('ui.notification', AudioBus.Ui, 0.45, 0, {
    source: 'sine', freqStart: 1200, freqEnd: 1600, attack: 0.005, decay: 0.15, sustain: 0, release: 0.12,
    filterStart: 5000, filterEnd: 7000, filterQ: 1.0, gain: 0.45,
  }),
];

const SOUND_BY_KEY = new Map(SOUNDS.map((x) => [x.key, x]));
export const getSound = (key: string): SoundDefinition | undefined => SOUND_BY_KEY.get(key);

/** Footstep sound key per surface. Volume also varies with movement state. */
export const FOOTSTEP_KEYS: Record<SurfaceMaterial, string> = {
  [SurfaceMaterial.Metal]: 'sfx.impact.metal',
  [SurfaceMaterial.Concrete]: 'sfx.impact.concrete',
  [SurfaceMaterial.Asphalt]: 'sfx.impact.concrete',
  [SurfaceMaterial.Wood]: 'sfx.impact.wood',
  [SurfaceMaterial.Glass]: 'sfx.impact.glass',
  [SurfaceMaterial.Brick]: 'sfx.impact.concrete',
  [SurfaceMaterial.Plastic]: 'sfx.impact.wood',
  [SurfaceMaterial.Fabric]: 'sfx.impact.dirt',
  [SurfaceMaterial.Dirt]: 'sfx.impact.dirt',
  [SurfaceMaterial.Grass]: 'sfx.impact.dirt',
  [SurfaceMaterial.Water]: 'sfx.impact.water',
  [SurfaceMaterial.Flesh]: 'sfx.impact.flesh',
};

/** Bullet impact sound per surface. */
export const IMPACT_KEYS: Record<SurfaceMaterial, string> = { ...FOOTSTEP_KEYS };

/** Ambience loops. Layered continuously; the client crossfades between maps. */
export interface AmbienceDefinition {
  key: string;
  /** Low-frequency noise bed characteristics. */
  filterHz: number;
  filterQ: number;
  gain: number;
  /** Slow LFO applied to gain, in Hz, for a living, non-static bed. */
  lfoHz: number;
  lfoDepth: number;
}

export const AMBIENCES: readonly AmbienceDefinition[] = [
  { key: 'amb.wind_open', filterHz: 420, filterQ: 0.6, gain: 0.16, lfoHz: 0.08, lfoDepth: 0.5 },
  { key: 'amb.machinery_low', filterHz: 110, filterQ: 3.0, gain: 0.13, lfoHz: 0.25, lfoDepth: 0.25 },
  { key: 'amb.distant_traffic', filterHz: 260, filterQ: 0.9, gain: 0.09, lfoHz: 0.05, lfoDepth: 0.4 },
  { key: 'amb.rain_medium', filterHz: 2600, filterQ: 0.5, gain: 0.2, lfoHz: 0.12, lfoDepth: 0.18 },
  { key: 'amb.city_night', filterHz: 340, filterQ: 0.8, gain: 0.12, lfoHz: 0.06, lfoDepth: 0.35 },
  { key: 'amb.neon_hum', filterHz: 1200, filterQ: 8.0, gain: 0.05, lfoHz: 0.4, lfoDepth: 0.3 },
  { key: 'amb.hub_hum', filterHz: 180, filterQ: 4.0, gain: 0.1, lfoHz: 0.15, lfoDepth: 0.2 },
  { key: 'amb.crowd_low', filterHz: 700, filterQ: 1.2, gain: 0.07, lfoHz: 0.09, lfoDepth: 0.4 },
];

export const getAmbience = (key: string): AmbienceDefinition | undefined =>
  AMBIENCES.find((a) => a.key === key);

/**
 * Music tracks. Also procedural: each is a chord progression + tempo that the
 * client's MusicEngine sequences. Real stems drop in via the asset manifest.
 */
export interface MusicTrack {
  key: string;
  bpm: number;
  /** Semitone offsets from the root, per bar. */
  progression: number[][];
  rootHz: number;
  /** Instrument character. */
  voice: 'pad' | 'pulse' | 'drive' | 'sparse';
  gain: number;
  loop: boolean;
}

export const MUSIC: readonly MusicTrack[] = [
  { key: 'music.menu', bpm: 84, rootHz: 110, voice: 'pad', gain: 0.3, loop: true,
    progression: [[0, 7, 12], [-3, 4, 9], [-5, 2, 7], [-3, 4, 11]] },
  { key: 'music.lobby', bpm: 96, rootHz: 123, voice: 'pulse', gain: 0.26, loop: true,
    progression: [[0, 5, 12], [2, 7, 14], [-2, 3, 10], [0, 5, 12]] },
  { key: 'music.combat', bpm: 132, rootHz: 98, voice: 'drive', gain: 0.22, loop: true,
    progression: [[0, 3, 7], [0, 3, 8], [-2, 1, 5], [-4, 0, 3]] },
  { key: 'music.victory', bpm: 110, rootHz: 130, voice: 'pad', gain: 0.38, loop: false,
    progression: [[0, 4, 7, 12], [5, 9, 12, 17], [7, 11, 14, 19], [0, 4, 7, 12]] },
  { key: 'music.defeat', bpm: 72, rootHz: 87, voice: 'sparse', gain: 0.32, loop: false,
    progression: [[0, 3, 7], [-2, 1, 5], [-4, -1, 3], [-5, -1, 2]] },
  { key: 'music.event', bpm: 118, rootHz: 116, voice: 'pulse', gain: 0.28, loop: true,
    progression: [[0, 4, 9], [2, 6, 11], [-1, 4, 7], [0, 4, 9]] },
];

export const getMusic = (key: string): MusicTrack | undefined => MUSIC.find((m) => m.key === key);

// ---------------------------------------------------------------- engines

/**
 * A continuous engine loop, driven by the vehicle's speed each frame rather
 * than triggered once. Two oscillators (a saw fundamental and a square
 * sub-octave) under a low-pass give a small motor its buzz; a thin noise layer
 * adds intake hiss. Pitch and gain are mapped from `speedRatio` (|speed| /
 * maxSpeed, 0..1) so the engine audibly winds up as the vehicle accelerates.
 *
 * Only heard while a vehicle is driven — an empty buggy is silent, so its
 * engine is a real cue that someone is coming, which is what its balance note
 * promises.
 */
export interface EngineDefinition {
  key: string;
  bus: AudioBus;
  /** Fundamental at idle and at full speed, Hz. */
  idleHz: number;
  maxHz: number;
  /** Low-pass cutoff at idle and at full speed, Hz. */
  filterIdleHz: number;
  filterMaxHz: number;
  filterQ: number;
  /** Loop gain at idle and at full speed, 0..1. */
  idleGain: number;
  maxGain: number;
  /** Relative level of the square sub-octave and the noise hiss. */
  subLevel: number;
  hissLevel: number;
  /** Seconds for pitch/gain to settle toward a new speed. */
  responseSec: number;
  /** Spatial rolloff for non-occupants. */
  maxDistance: number;
  refDistance: number;
}

export const ENGINES: readonly EngineDefinition[] = [
  {
    key: 'sfx.vehicle.buggy_engine',
    bus: AudioBus.Sfx,
    idleHz: 46,
    maxHz: 150,
    filterIdleHz: 380,
    filterMaxHz: 1900,
    filterQ: 1.3,
    idleGain: 0.18,
    maxGain: 0.5,
    subLevel: 0.6,
    hissLevel: 0.22,
    responseSec: 0.25,
    // Loud on purpose: the buggy's whole balance is that you hear it coming.
    // 160m is more than twice a footstep's range and just under a rifle's
    // (180-220m); a test pins the footstep ratio.
    maxDistance: 160,
    refDistance: 9,
  },
];

export const getEngine = (key: string): EngineDefinition | undefined =>
  ENGINES.find((e) => e.key === key);
