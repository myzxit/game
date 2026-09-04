/**
 * Snapshot quantisation and delta compression.
 *
 * JSON is verbose, so instead of switching to a binary format (which would make
 * the protocol far harder to debug) we shrink the payload two ways:
 *   1. quantise floats to the smallest precision that is visually lossless,
 *   2. send only the fields that changed since the client's acknowledged
 *      snapshot.
 *
 * Together these cut a 12-player snapshot to roughly a third of its naive size,
 * which is enough headroom at 20 Hz.
 */

import type { Vec3 } from '../core/math.js';
import type { PlayerSnapshot, ServerSnapshot } from './protocol.js';

/** Positions to the centimetre — well below what a player can perceive. */
export const POS_SCALE = 100;
/** Velocities to 1 cm/s. */
export const VEL_SCALE = 100;
/** Angles to ~0.001 rad (0.057 degrees) — finer than any monitor can show. */
export const ANGLE_SCALE = 1000;

export const quantizePos = (v: Vec3): [number, number, number] => [
  Math.round(v.x * POS_SCALE),
  Math.round(v.y * POS_SCALE),
  Math.round(v.z * POS_SCALE),
];

export const dequantizePos = (v: [number, number, number]): Vec3 => ({
  x: v[0] / POS_SCALE,
  y: v[1] / POS_SCALE,
  z: v[2] / POS_SCALE,
});

export const quantizeVel = (v: Vec3): [number, number, number] => [
  Math.round(v.x * VEL_SCALE),
  Math.round(v.y * VEL_SCALE),
  Math.round(v.z * VEL_SCALE),
];

export const dequantizeVel = (v: [number, number, number]): Vec3 => ({
  x: v[0] / VEL_SCALE,
  y: v[1] / VEL_SCALE,
  z: v[2] / VEL_SCALE,
});

export const quantizeAngle = (a: number): number => Math.round(a * ANGLE_SCALE);
export const dequantizeAngle = (a: number): number => a / ANGLE_SCALE;

/** A player entry with only the changed fields, plus its id. */
export type PlayerDelta = Partial<PlayerSnapshot> & { id: string };

const arraysEqual = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Diff one player against its previous state.
 * Returns null when nothing changed at all (the common case for idle players).
 */
export function diffPlayer(prev: PlayerSnapshot, next: PlayerSnapshot): PlayerDelta | null {
  const delta: PlayerDelta = { id: next.id };
  let changed = false;

  const check = <K extends keyof PlayerSnapshot>(key: K): void => {
    const a = prev[key];
    const b = next[key];
    const same = Array.isArray(a) && Array.isArray(b)
      ? arraysEqual(a as number[], b as number[])
      : a === b;
    if (!same) {
      (delta as Record<string, unknown>)[key as string] = b;
      changed = true;
    }
  };

  // Fields that change most often first — no functional effect, but it keeps
  // the emitted JSON key order stable and gzip-friendly.
  check('pos');
  check('vel');
  check('yaw');
  check('pitch');
  check('flags');
  check('health');
  check('shield');
  check('state');
  check('height');
  check('ads');
  check('alive');
  check('weaponId');
  check('score');
  check('kills');
  check('deaths');
  check('ping');
  check('team');
  check('characterId');
  check('skinId');
  check('displayName');

  return changed ? delta : null;
}

/** Reapply a delta onto a base snapshot entry. */
export function applyPlayerDelta(base: PlayerSnapshot, delta: PlayerDelta): PlayerSnapshot {
  return { ...base, ...delta };
}

export interface DeltaSnapshot extends Omit<ServerSnapshot, 'players'> {
  players: PlayerDelta[];
}

/**
 * Build a delta snapshot against `base`.
 * Players absent from `base` are sent in full; players absent from `next` are
 * listed in `removed`.
 */
export function buildDeltaSnapshot(
  base: ServerSnapshot | null,
  next: ServerSnapshot,
): DeltaSnapshot {
  if (!base) {
    return { ...next, baseId: -1, players: next.players, removed: [] };
  }

  const baseById = new Map(base.players.map((p) => [p.id, p]));
  const players: PlayerDelta[] = [];

  for (const p of next.players) {
    const prev = baseById.get(p.id);
    if (!prev) {
      players.push(p); // new player: full state
      continue;
    }
    const d = diffPlayer(prev, p);
    if (d) players.push(d);
    baseById.delete(p.id);
  }

  return {
    ...next,
    baseId: base.id,
    players,
    removed: Array.from(baseById.keys()),
  };
}

/**
 * Reconstruct a full snapshot on the client from a delta and the base it
 * references. Returns null if the base is missing — the client then requests a
 * full snapshot by acknowledging -1.
 */
export function applyDeltaSnapshot(
  base: ServerSnapshot | null,
  delta: DeltaSnapshot,
): ServerSnapshot | null {
  if (delta.baseId === -1) {
    return { ...delta, players: delta.players as PlayerSnapshot[] };
  }
  if (!base || base.id !== delta.baseId) return null;

  const byId = new Map(base.players.map((p) => [p.id, p]));
  for (const id of delta.removed) byId.delete(id);

  for (const d of delta.players) {
    const prev = byId.get(d.id);
    // A delta for an unknown player means we're missing state; treat the
    // partial entry as full — it will self-correct on the next full snapshot.
    byId.set(d.id, prev ? applyPlayerDelta(prev, d) : (d as PlayerSnapshot));
  }

  return { ...delta, players: Array.from(byId.values()) };
}

/** Encode for the wire. Kept behind a function so a binary codec can drop in. */
export function encode(message: unknown): string {
  return JSON.stringify(message);
}

/** Decode a wire payload. Returns null on malformed input — never throws. */
export function decode(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Approximate encoded size, for bandwidth telemetry. */
export function encodedSize(message: unknown): number {
  return encode(message).length;
}
