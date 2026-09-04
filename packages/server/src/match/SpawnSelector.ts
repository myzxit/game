/**
 * Spawn selection.
 *
 * Spawning is one of the biggest sources of "this game feels unfair", so this
 * scores every candidate rather than picking at random:
 *   - never inside geometry,
 *   - never in an enemy's line of sight,
 *   - as far from the nearest enemy as possible,
 *   - near teammates when that doesn't conflict with the above,
 *   - avoid the point where you just died.
 *
 * Ties are broken with the match's seeded RNG so spawns are reproducible.
 */

import {
  CollisionWorld,
  Rng,
  TeamId,
  mixSeeds,
  v3dist,
  vec3,
  PLAYER_RADIUS,
  PLAYER_HEIGHT_STAND,
  type MapDefinition,
  type SpawnPoint,
  type Vec3,
} from '@titan/shared';

export interface SpawnCandidateContext {
  team: TeamId;
  /** Positions of living enemies. */
  enemies: { position: Vec3; eye: Vec3 }[];
  /** Positions of living teammates. */
  allies: Vec3[];
  /** Where this player last died, if anywhere. */
  lastDeathPosition: Vec3 | null;
}

export interface ChosenSpawn {
  position: Vec3;
  yaw: number;
  score: number;
}

/** Enemies closer than this make a spawn nearly unusable. */
const DANGER_RADIUS = 22;
/** Being visible to an enemy is the single worst property a spawn can have. */
const VISIBILITY_PENALTY = 1000;

export class SpawnSelector {
  private readonly rng: Rng;

  constructor(
    private readonly map: MapDefinition,
    private readonly world: CollisionWorld,
    seed: number,
  ) {
    this.rng = new Rng(mixSeeds(seed, 0x5b0a));
  }

  /** Spawn points usable by a team (team-owned plus neutral). */
  private candidatesFor(team: TeamId): SpawnPoint[] {
    const owned = this.map.spawns.filter((s) => s.team === team);
    const neutral = this.map.spawns.filter((s) => s.team === TeamId.None);
    // Team modes prefer their own base but can fall back to neutral points when
    // the base is being spawn-camped.
    return owned.length > 0 ? [...owned, ...neutral] : this.map.spawns.slice();
  }

  /** Is a spawn point physically free? */
  private isClear(point: SpawnPoint): boolean {
    const min = vec3(
      point.at.x - PLAYER_RADIUS,
      point.at.y + 0.05,
      point.at.z - PLAYER_RADIUS,
    );
    const max = vec3(
      point.at.x + PLAYER_RADIUS,
      point.at.y + PLAYER_HEIGHT_STAND,
      point.at.z + PLAYER_RADIUS,
    );
    return !this.world.overlapsAny(min, max);
  }

  private score(point: SpawnPoint, ctx: SpawnCandidateContext): number {
    let score = point.priority * 50;

    const eye = vec3(point.at.x, point.at.y + PLAYER_HEIGHT_STAND - 0.16, point.at.z);

    let nearestEnemy = Infinity;
    for (const enemy of ctx.enemies) {
      const distance = v3dist(point.at, enemy.position);
      nearestEnemy = Math.min(nearestEnemy, distance);

      // Line of sight is only worth testing for enemies who are close enough
      // to matter; a visible enemy 200m away is not a spawn hazard.
      if (distance < 70 && this.world.hasLineOfSight(eye, enemy.eye)) {
        score -= VISIBILITY_PENALTY;
      }
    }

    if (nearestEnemy < Infinity) {
      // Reward distance, but with diminishing returns past the danger radius.
      score += Math.min(nearestEnemy, DANGER_RADIUS * 3) * 8;
      if (nearestEnemy < DANGER_RADIUS) score -= (DANGER_RADIUS - nearestEnemy) * 30;
    } else {
      score += DANGER_RADIUS * 3 * 8;
    }

    // Spawning near a teammate is good, but only mildly — it must never
    // outweigh safety.
    let nearestAlly = Infinity;
    for (const ally of ctx.allies) nearestAlly = Math.min(nearestAlly, v3dist(point.at, ally));
    if (nearestAlly < Infinity && nearestAlly < 40) score += (40 - nearestAlly) * 2;

    // Don't drop the player straight back where they died.
    if (ctx.lastDeathPosition) {
      const fromDeath = v3dist(point.at, ctx.lastDeathPosition);
      if (fromDeath < 15) score -= (15 - fromDeath) * 25;
    }

    return score;
  }

  /**
   * Pick the best spawn.
   * Falls back to any clear point, then to the first point at all, so this can
   * never fail to return somewhere to put the player.
   */
  select(ctx: SpawnCandidateContext): ChosenSpawn {
    const candidates = this.candidatesFor(ctx.team).filter((p) => this.isClear(p));
    const usable = candidates.length > 0 ? candidates : this.candidatesFor(ctx.team);

    if (usable.length === 0) {
      // No spawn data at all — put them at the map origin rather than crash.
      return { position: vec3(0, 2, 0), yaw: 0, score: 0 };
    }

    let best: SpawnPoint[] = [];
    let bestScore = -Infinity;

    for (const point of usable) {
      const score = this.score(point, ctx);
      if (score > bestScore + 1e-6) {
        bestScore = score;
        best = [point];
      } else if (Math.abs(score - bestScore) <= 1e-6) {
        best.push(point);
      }
    }

    // Break ties randomly so repeated spawns don't always land on the same pad.
    const chosen = best.length === 1 ? best[0]! : this.rng.pick(best);
    return { position: { ...chosen.at }, yaw: chosen.yaw, score: bestScore };
  }

  /** Initial spawns at match start: spread a team across its base. */
  selectInitial(team: TeamId, index: number): ChosenSpawn {
    const candidates = this.candidatesFor(team).filter((p) => p.team === team && this.isClear(p));
    const pool = candidates.length > 0 ? candidates : this.candidatesFor(team);
    if (pool.length === 0) return { position: vec3(0, 2, 0), yaw: 0, score: 0 };
    const point = pool[index % pool.length]!;
    return { position: { ...point.at }, yaw: point.yaw, score: 0 };
  }
}
