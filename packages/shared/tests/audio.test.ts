/**
 * Audio data integrity.
 *
 * Content refers to sounds by key. A key that resolves to nothing fails
 * silently at runtime — the buggy shipped with an `engineSfxKey` naming a
 * recipe that did not exist, and was simply mute. These tests make a dangling
 * audio reference a test failure instead.
 */

import { describe, expect, it } from 'vitest';
import {
  AMBIENCES,
  ENGINES,
  FOOTSTEP_KEYS,
  MAPS,
  SOUNDS,
  VEHICLES,
  WEAPONS,
  getAmbience,
  getEngine,
  getSound,
} from '../src/index.js';

describe('audio references resolve', () => {
  it('every vehicle names an engine recipe that exists', () => {
    for (const v of VEHICLES) {
      expect(getEngine(v.engineSfxKey), `${v.id}: engine "${v.engineSfxKey}"`).toBeDefined();
    }
  });

  it('every weapon has a fire sound', () => {
    for (const w of WEAPONS) {
      expect(getSound(`sfx.weapon.${w.id}.fire`) ?? getSound(`sfx.weapon.${w.id}.swing`),
        `${w.id} has no fire/swing sound`).toBeDefined();
    }
  });

  it('every map ambience key exists', () => {
    for (const m of MAPS) {
      for (const key of m.environment.ambienceKeys) {
        expect(getAmbience(key), `${m.id}: ambience "${key}"`).toBeDefined();
      }
    }
  });

  it('keys are unique within each table', () => {
    for (const [name, table] of [
      ['SOUNDS', SOUNDS],
      ['AMBIENCES', AMBIENCES],
      ['ENGINES', ENGINES],
    ] as const) {
      const keys = table.map((e) => e.key);
      expect(new Set(keys).size, `${name} has duplicate keys`).toBe(keys.length);
    }
  });
});

describe('engine recipes are audible and sane', () => {
  it.each(ENGINES.map((e) => [e.key, e] as const))('%s', (_key, e) => {
    // Pitch and gain must rise with speed, or the loop tells the player nothing.
    expect(e.maxHz).toBeGreaterThan(e.idleHz);
    expect(e.filterMaxHz).toBeGreaterThan(e.filterIdleHz);
    expect(e.maxGain).toBeGreaterThan(e.idleGain);
    expect(e.idleGain).toBeGreaterThan(0);
    expect(e.maxGain).toBeLessThanOrEqual(1);
    // Audible fundamentals: below ~30 Hz is felt, not heard, on most speakers.
    expect(e.idleHz).toBeGreaterThanOrEqual(30);
    expect(e.maxHz).toBeLessThan(1000);
    expect(e.responseSec).toBeGreaterThan(0);
    expect(e.maxDistance).toBeGreaterThan(e.refDistance);
  });

  it('the buggy is audible from further away than a footstep', () => {
    // Its balance note promises the engine "announces it long before it
    // arrives". That is only true if it carries further than ordinary
    // movement sound, so pin it to the loudest footstep's range.
    const buggy = getEngine('sfx.vehicle.buggy_engine')!;
    const footsteps = Object.values(FOOTSTEP_KEYS).map((k) => getSound(k)!);
    expect(footsteps.length).toBeGreaterThan(0);
    for (const f of footsteps) expect(f).toBeDefined();
    const loudestFootstep = Math.max(...footsteps.map((s) => s.maxDistance));
    expect(buggy.maxDistance).toBeGreaterThan(loudestFootstep * 2);
  });
});
