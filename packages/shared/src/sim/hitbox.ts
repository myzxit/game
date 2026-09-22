/**
 * Player hitboxes.
 *
 * Hitboxes are built from the player's movement state so they always match what
 * the client renders (crouching shrinks them, sliding lowers them). The server
 * rebuilds them from historical snapshots when lag-compensating, which is why
 * this is a pure function of state rather than something attached to a model.
 */

import { type Vec3, vec3 } from '../core/math.js';
import { HitZone, MovementState } from '../types/domain.js';
import type { AABB } from '../types/domain.js';
import { rayAabb } from './collision.js';
import { PLAYER_RADIUS } from '../core/constants.js';

export interface Hitbox {
  zone: HitZone;
  min: Vec3;
  max: Vec3;
}

export interface HitboxHit {
  zone: HitZone;
  distance: number;
  point: Vec3;
}

/** Fractions of total height at which each zone starts and ends. */
const ZONE_BANDS: { zone: HitZone; from: number; to: number; widthScale: number }[] = [
  { zone: HitZone.Head, from: 0.865, to: 1.0, widthScale: 0.52 },
  { zone: HitZone.Chest, from: 0.62, to: 0.865, widthScale: 1.0 },
  { zone: HitZone.Stomach, from: 0.42, to: 0.62, widthScale: 0.88 },
  { zone: HitZone.Limb, from: 0.0, to: 0.42, widthScale: 0.78 },
];

/**
 * Build the hitbox set for a player.
 * `position` is the feet position; `height` is the current capsule height.
 */
export function buildHitboxes(
  position: Vec3,
  height: number,
  state: MovementState = MovementState.Idle,
): Hitbox[] {
  // Sliding pitches the body forward, so the head sits lower and further out.
  const sliding = state === MovementState.Slide;
  const effectiveHeight = sliding ? height * 0.82 : height;

  const boxes: Hitbox[] = [];
  for (const band of ZONE_BANDS) {
    const halfWidth = PLAYER_RADIUS * band.widthScale;
    boxes.push({
      zone: band.zone,
      min: vec3(
        position.x - halfWidth,
        position.y + effectiveHeight * band.from,
        position.z - halfWidth,
      ),
      max: vec3(
        position.x + halfWidth,
        position.y + effectiveHeight * band.to,
        position.z + halfWidth,
      ),
    });
  }
  return boxes;
}

/** Coarse bounding box for the whole player — the broadphase before zone tests. */
export function playerBounds(position: Vec3, height: number): AABB {
  return {
    min: vec3(position.x - PLAYER_RADIUS, position.y, position.z - PLAYER_RADIUS),
    max: vec3(position.x + PLAYER_RADIUS, position.y + height, position.z + PLAYER_RADIUS),
  };
}

/**
 * Ray against a player's hitboxes.
 * Returns the nearest hit; head is tested first only in the sense that the
 * nearest intersection wins — overlapping zones resolve by distance, so a shot
 * that grazes the top of the chest into the head still registers as a headshot
 * only if the head box is genuinely hit first.
 */
export function raycastHitboxes(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  position: Vec3,
  height: number,
  state: MovementState = MovementState.Idle,
): HitboxHit | null {
  // Broadphase: skip the four zone tests if the bounds are missed entirely.
  const bounds = playerBounds(position, height);
  if (!rayAabb(origin, direction, bounds.min, bounds.max, maxDistance)) return null;

  let best: HitboxHit | null = null;
  for (const box of buildHitboxes(position, height, state)) {
    const hit = rayAabb(origin, direction, box.min, box.max, maxDistance);
    if (hit && (best === null || hit.distance < best.distance)) {
      best = { zone: box.zone, distance: hit.distance, point: hit.point };
    }
  }
  return best;
}

/** Centre-of-mass — used for splash damage, AI aim and spectator framing. */
export function playerCenter(position: Vec3, height: number): Vec3 {
  return vec3(position.x, position.y + height * 0.55, position.z);
}
