/**
 * Ballistics: spread, recoil, projectile flight and damage resolution.
 *
 * Every random draw here is seeded from (matchSeed, playerId, shot sequence),
 * so the client can predict the exact same spread pattern the server will
 * compute. This is what lets the client draw a tracer immediately without the
 * shot later "teleporting" when the server's version arrives.
 */

import {
  type Vec3,
  vec3,
  v3add,
  v3scale,
  v3normalize,
  v3cross,
  clamp,
  anglesToForward,
} from '../core/math.js';
import { Rng, mixSeeds } from '../core/random.js';
import type { ResolvedWeapon } from '../config/loadout.js';
import { damageAtRange } from '../config/weapons.js';
import { HitZone, MovementState, SurfaceMaterial } from '../types/domain.js';
import type { CollisionWorld, RaycastHit } from './collision.js';

/** Everything about the shooter that affects where a bullet goes. */
export interface ShotContext {
  origin: Vec3;
  yaw: number;
  pitch: number;
  /** Accumulated spread from consecutive shots, in radians. */
  spreadAccum: number;
  isAiming: boolean;
  isCrouching: boolean;
  isMoving: boolean;
  isAirborne: boolean;
  /** Deterministic seed for this exact shot. */
  seed: number;
}

export interface ShotRay {
  origin: Vec3;
  direction: Vec3;
  /** Index within the pellet group (0 for single-projectile weapons). */
  pelletIndex: number;
}

/** Current cone half-angle in radians, given weapon and player state. */
export function currentSpread(w: ResolvedWeapon, ctx: ShotContext): number {
  let cone = w.spread.base + ctx.spreadAccum;
  if (ctx.isAiming) cone *= w.spread.adsMultiplier;
  if (ctx.isCrouching) cone *= w.spread.crouchMultiplier;
  if (ctx.isMoving) cone *= w.spread.movingMultiplier;
  if (ctx.isAirborne) cone *= w.spread.airborneMultiplier;
  return clamp(cone, 0, w.spread.max * 4);
}

/**
 * Build the ray(s) for one trigger pull.
 * Shotguns return `w.pellets` rays sharing one seed stream.
 */
export function computeShotRays(w: ResolvedWeapon, ctx: ShotContext): ShotRay[] {
  const forward = anglesToForward(ctx.yaw, ctx.pitch);
  const cone = currentSpread(w, ctx);
  const rng = new Rng(ctx.seed);

  // Build an orthonormal basis around the aim direction.
  const worldUp = Math.abs(forward.y) > 0.99 ? vec3(1, 0, 0) : vec3(0, 1, 0);
  const right = v3normalize(v3cross(forward, worldUp));
  const up = v3normalize(v3cross(right, forward));

  const rays: ShotRay[] = [];
  for (let i = 0; i < Math.max(1, w.pellets); i++) {
    // The first pellet of a shotgun goes dead centre so the weapon feels
    // reliable at point-blank range; the rest spread around it.
    let dir: Vec3;
    if (cone <= 1e-6) {
      dir = forward;
    } else {
      const disc = rng.insideUnitCircle();
      const offX = disc.x * cone;
      const offY = disc.y * cone;
      dir = v3normalize(
        v3add(forward, v3add(v3scale(right, offX), v3scale(up, offY))),
      );
    }
    rays.push({ origin: { ...ctx.origin }, direction: dir, pelletIndex: i });
  }
  return rays;
}

/** Recoil kick applied to the player's view after a shot. */
export interface RecoilKick {
  pitch: number;
  yaw: number;
}

/**
 * Recoil for shot number `shotIndex` in the current burst.
 * The vertical component is a deterministic pattern (learnable by the player);
 * the horizontal component alternates with a seeded jitter so it is
 * controllable but not perfectly memorizable.
 */
export function computeRecoil(
  w: ResolvedWeapon,
  shotIndex: number,
  isAiming: boolean,
  seed: number,
): RecoilKick {
  const rng = new Rng(mixSeeds(seed, shotIndex));
  // Climb ramps in over the first third of the magazine, then plateaus.
  const heat = clamp(shotIndex / Math.max(1, w.magazineSize / 3), 0, 1);
  const climb = 1 + (w.recoil.climb - 1) * heat;
  const adsScale = isAiming ? w.recoil.adsMultiplier : 1;

  const vertical = w.recoil.vertical * climb * adsScale;
  // Alternating sign gives the pattern a readable zig-zag shape.
  const sign = shotIndex % 2 === 0 ? 1 : -1;
  const horizontal = w.recoil.horizontal * climb * adsScale * sign * rng.range(0.55, 1.45);

  return { pitch: vertical, yaw: horizontal };
}

/** Spread added by a shot, clamped to the weapon's maximum. */
export function addSpread(w: ResolvedWeapon, current: number): number {
  return Math.min(w.spread.max, current + w.spread.perShot);
}

/** Spread recovery over time when not firing. */
export function recoverSpread(w: ResolvedWeapon, current: number, dt: number): number {
  return Math.max(0, current - w.spread.recovery * dt);
}

// --------------------------------------------------------------------------
// Damage
// --------------------------------------------------------------------------

export function zoneMultiplier(w: ResolvedWeapon, zone: HitZone): number {
  switch (zone) {
    case HitZone.Head:
      return w.headshotMultiplier;
    case HitZone.Stomach:
      return w.stomachMultiplier;
    case HitZone.Limb:
      return w.limbMultiplier;
    default:
      return 1;
  }
}

/** Damage a single bullet deals, before shields. */
export function computeDamage(
  w: ResolvedWeapon,
  distance: number,
  zone: HitZone,
  penetrationLoss = 0,
): number {
  const base = damageAtRange(w, distance);
  const scaled = base * zoneMultiplier(w, zone) * (1 - clamp(penetrationLoss, 0, 1));
  return Math.max(0, Math.round(scaled * 100) / 100);
}

/** How much damage a bullet loses passing through a material. */
export const PENETRATION_LOSS: Partial<Record<SurfaceMaterial, number>> = {
  [SurfaceMaterial.Glass]: 0.12,
  [SurfaceMaterial.Wood]: 0.35,
  [SurfaceMaterial.Plastic]: 0.3,
  [SurfaceMaterial.Fabric]: 0.15,
  [SurfaceMaterial.Dirt]: 0.6,
};

export function penetrationLossFor(material: SurfaceMaterial): number {
  return PENETRATION_LOSS[material] ?? 1; // unlisted materials stop the bullet
}

/**
 * Falloff-adjusted damage for an explosion at `distance` from its centre.
 * Linear to zero at the edge, with a minimum of 15% at the very rim so a
 * near-miss still registers as a hit for feedback purposes.
 */
export function explosionDamage(maxDamage: number, distance: number, radius: number): number {
  if (radius <= 0 || distance >= radius) return 0;
  const t = 1 - distance / radius;
  return Math.round(maxDamage * (0.15 + 0.85 * t) * 100) / 100;
}

// --------------------------------------------------------------------------
// Projectiles
// --------------------------------------------------------------------------

export interface Projectile {
  id: number;
  ownerId: string;
  weaponId: string;
  position: Vec3;
  velocity: Vec3;
  gravity: number;
  /** ms remaining before the projectile expires. */
  lifetimeMs: number;
  /** Distance travelled so far — used for damage falloff on impact. */
  distanceTravelled: number;
  explosionRadius: number;
}

export interface ProjectileStepResult {
  projectile: Projectile;
  /** Set when the projectile hit world geometry this step. */
  worldHit: RaycastHit | null;
  expired: boolean;
}

export function createProjectile(
  id: number,
  ownerId: string,
  w: ResolvedWeapon,
  origin: Vec3,
  direction: Vec3,
): Projectile {
  return {
    id,
    ownerId,
    weaponId: w.id,
    position: { ...origin },
    velocity: v3scale(direction, w.projectileSpeed),
    gravity: w.projectileGravity,
    lifetimeMs: (w.maxRange / Math.max(1, w.projectileSpeed)) * 1000,
    distanceTravelled: 0,
    explosionRadius: w.explosionRadius,
  };
}

/**
 * Advance a projectile. Movement is swept against the world with a raycast, so
 * fast projectiles cannot tunnel through thin walls.
 */
export function stepProjectile(
  p: Projectile,
  dt: number,
  world: CollisionWorld,
): ProjectileStepResult {
  const next: Projectile = {
    ...p,
    position: { ...p.position },
    velocity: { ...p.velocity },
  };

  next.velocity.y -= next.gravity * dt;
  const delta = v3scale(next.velocity, dt);
  const distance = Math.hypot(delta.x, delta.y, delta.z);

  let worldHit: RaycastHit | null = null;
  if (distance > 1e-6) {
    const dir = v3scale(delta, 1 / distance);
    worldHit = world.raycast(next.position, dir, distance, true);
    if (worldHit) {
      next.position = { ...worldHit.point };
      next.distanceTravelled += worldHit.distance;
    } else {
      next.position = v3add(next.position, delta);
      next.distanceTravelled += distance;
    }
  }

  next.lifetimeMs -= dt * 1000;
  return { projectile: next, worldHit, expired: next.lifetimeMs <= 0 };
}
