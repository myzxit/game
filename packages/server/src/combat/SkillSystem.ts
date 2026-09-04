/**
 * Skills.
 *
 * Each skill category has one behaviour, driven by the `params` block in its
 * config — so tuning is a data edit and adding a *new kind* of skill is a small
 * addition here. Everything a skill does (damage, healing, reveals, barriers)
 * goes through the same authoritative paths as gunfire, so a skill can never
 * bypass friendly fire or spawn protection.
 */

import {
  DamageType,
  HitZone,
  SkillCategory,
  SurfaceMaterial,
  ServerMessageType,
  anglesToForward,
  createLogger,
  explosionDamage,
  playerCenter,
  v3add,
  v3dist,
  v3scale,
  vec3,
  type SkillDefinition,
  type Vec3,
} from '@titan/shared';
import type { PlayerEntity } from '../match/PlayerEntity.js';
import type { MatchInstance } from '../match/MatchInstance.js';
import { MatchEventType } from '../match/MatchEvents.js';

const log = createLogger('Skills');

/** A deployed barrier. */
interface Barrier {
  id: number;
  ownerId: string;
  team: number;
  position: Vec3;
  health: number;
  remainingMs: number;
  width: number;
  height: number;
}

/** A thrown charge in flight. */
interface ThrownCharge {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  fuseMs: number;
  damage: number;
  radius: number;
}

/** An in-progress channelled heal. */
interface HealField {
  ownerId: string;
  remainingMs: number;
  healPerSecond: number;
  radius: number;
  interruptOnDamage: boolean;
  /** Health the owner had last tick, to detect interruption. */
  lastOwnerHealth: number;
}

export class SkillSystem {
  private readonly barriers: Barrier[] = [];
  private readonly charges: ThrownCharge[] = [];
  private readonly healFields: HealField[] = [];
  private nextId = 1;

  constructor(private readonly match: MatchInstance) {}

  /** Attempt to use a player's equipped skill. */
  activate(player: PlayerEntity, aimYaw: number, aimPitch: number): boolean {
    if (!player.canUseSkill()) return false;
    const skill = player.consumeSkill();
    if (!skill) return false;

    const origin = player.eye;
    const forward = anglesToForward(aimYaw, aimPitch);

    switch (skill.category) {
      case SkillCategory.Mobility:
        this.applyDash(player, skill, aimYaw, aimPitch);
        break;
      case SkillCategory.Defense:
        if (skill.params.shieldHp !== undefined) this.deployBarrier(player, skill, forward);
        else this.startHealField(player, skill);
        break;
      case SkillCategory.Offense:
        this.throwCharge(player, skill, origin, forward);
        break;
      case SkillCategory.Utility:
        if (skill.params.radius !== undefined && skill.params.revealDurationMs !== undefined) {
          this.scanPulse(player, skill);
        } else {
          this.phase(player, skill);
        }
        break;
    }

    this.match.recorder.record({
      type: MatchEventType.SkillUsed,
      at: this.match.elapsedMs,
      tick: this.match.tick,
      playerId: player.id,
      skillId: skill.id,
      position: player.position,
    });

    this.match.broadcast({
      type: ServerMessageType.CombatEvent,
      event: {
        kind: 'skill',
        playerId: player.id,
        skillId: skill.id,
        at: [origin.x, origin.y, origin.z],
      },
    });

    return true;
  }

  // ------------------------------------------------------------ behaviours --

  private applyDash(player: PlayerEntity, skill: SkillDefinition, yaw: number, pitch: number): void {
    const impulse = skill.params.impulse ?? 15;
    const vertical = skill.params.verticalBoost ?? 0;
    const dir = anglesToForward(yaw, Math.min(pitch, 0.2));

    player.movement.velocity.x = dir.x * impulse;
    player.movement.velocity.z = dir.z * impulse;
    if (vertical > 0) {
      player.movement.velocity.y = Math.max(player.movement.velocity.y, vertical);
      player.movement.grounded = false;
    }
    // The dash lockout lives in the shared movement state so the client
    // predicts the same loss of steering authority.
    player.movement.dashTimeMs = Math.max(player.movement.dashTimeMs, skill.durationMs);
  }

  private deployBarrier(player: PlayerEntity, skill: SkillDefinition, forward: Vec3): void {
    const distance = skill.params.deployDistance ?? 2;
    const position = v3add(player.position, v3scale(vec3(forward.x, 0, forward.z), distance));

    this.barriers.push({
      id: this.nextId++,
      ownerId: player.id,
      team: player.team,
      position,
      health: skill.params.shieldHp ?? 300,
      remainingMs: skill.durationMs,
      width: skill.params.width ?? 2.5,
      height: skill.params.height ?? 1.7,
    });

    // Barriers are transient world state, so the client learns about them from
    // a skill event rather than the entity snapshot (which only carries
    // players) and reconstructs the visual from the skill's config.
    this.match.broadcast({
      type: ServerMessageType.CombatEvent,
      event: {
        kind: 'skill',
        playerId: player.id,
        skillId: skill.id,
        at: [position.x, position.y, position.z],
      },
    });
  }

  private throwCharge(player: PlayerEntity, skill: SkillDefinition, origin: Vec3, forward: Vec3): void {
    const speed = skill.params.throwSpeed ?? 20;
    this.charges.push({
      id: this.nextId++,
      ownerId: player.id,
      position: { ...origin },
      // A slight upward bias so a flat throw arcs rather than hitting the floor.
      velocity: v3scale(vec3(forward.x, forward.y + 0.25, forward.z), speed),
      fuseMs: skill.params.fuseMs ?? 1500,
      damage: skill.params.damage ?? 60,
      radius: skill.params.radius ?? 4,
    });
  }

  private scanPulse(player: PlayerEntity, skill: SkillDefinition): void {
    const radius = skill.params.radius ?? 25;
    const duration = skill.params.revealDurationMs ?? 3000;

    for (const target of this.match.players.values()) {
      if (target.id === player.id || !target.alive) continue;
      if (this.match.mode.config.teamBased && target.team === player.team) continue;
      if (v3dist(target.position, player.position) > radius) continue;
      target.scannedMs = Math.max(target.scannedMs, duration);
    }

    this.match.broadcast({
      type: ServerMessageType.CombatEvent,
      event: {
        kind: 'skill',
        playerId: player.id,
        skillId: skill.id,
        at: [player.position.x, player.position.y, player.position.z],
      },
    });
  }

  private phase(player: PlayerEntity, skill: SkillDefinition): void {
    player.phasedMs = skill.durationMs;
  }

  private startHealField(player: PlayerEntity, skill: SkillDefinition): void {
    this.healFields.push({
      ownerId: player.id,
      remainingMs: skill.durationMs,
      healPerSecond: skill.params.healPerSecond ?? 20,
      radius: skill.params.teamRadius ?? 5,
      interruptOnDamage: (skill.params.interruptOnDamage ?? 1) > 0,
      lastOwnerHealth: player.health,
    });
  }

  // ----------------------------------------------------------------- tick --

  step(dtMs: number, now: number): void {
    const dt = dtMs / 1000;

    this.stepBarriers(dtMs);
    this.stepCharges(dt, dtMs, now);
    this.stepHealFields(dt, dtMs);
  }

  private stepBarriers(dtMs: number): void {
    for (let i = this.barriers.length - 1; i >= 0; i--) {
      const barrier = this.barriers[i]!;
      barrier.remainingMs -= dtMs;
      if (barrier.remainingMs <= 0 || barrier.health <= 0) {
        this.barriers.splice(i, 1);
      }
    }
  }

  private stepCharges(dt: number, dtMs: number, now: number): void {
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const charge = this.charges[i]!;
      charge.fuseMs -= dtMs;

      // Simple ballistic arc with a world sweep so it can't pass through walls.
      charge.velocity.y -= 22 * dt;
      const delta = v3scale(charge.velocity, dt);
      const distance = Math.hypot(delta.x, delta.y, delta.z);

      if (distance > 1e-6) {
        const dir = v3scale(delta, 1 / distance);
        const hit = this.match.world.raycast(charge.position, dir, distance, true);
        if (hit) {
          // Bounce with heavy damping so it settles quickly.
          charge.position = v3add(hit.point, v3scale(hit.normal, 0.05));
          const dot =
            charge.velocity.x * hit.normal.x +
            charge.velocity.y * hit.normal.y +
            charge.velocity.z * hit.normal.z;
          charge.velocity = v3scale(
            {
              x: charge.velocity.x - 2 * dot * hit.normal.x,
              y: charge.velocity.y - 2 * dot * hit.normal.y,
              z: charge.velocity.z - 2 * dot * hit.normal.z,
            },
            0.35,
          );
        } else {
          charge.position = v3add(charge.position, delta);
        }
      }

      if (charge.fuseMs <= 0) {
        this.detonateCharge(charge, now);
        this.charges.splice(i, 1);
      }
    }
  }

  private detonateCharge(charge: ThrownCharge, now: number): void {
    const owner = this.match.players.get(charge.ownerId) ?? null;

    this.match.broadcast({
      type: ServerMessageType.CombatEvent,
      event: {
        kind: 'impact',
        at: [charge.position.x, charge.position.y, charge.position.z],
        normal: [0, 1, 0],
        material: SurfaceMaterial.Metal,
      },
    });

    for (const target of this.match.players.values()) {
      if (!target.alive || target.isSpawnProtected) continue;
      if (owner && !this.match.canDamage(owner, target)) continue;

      const center = playerCenter(target.position, target.movement.height);
      const distance = v3dist(charge.position, center);
      if (distance > charge.radius) continue;
      // Cover works against skills exactly as it does against bullets.
      if (!this.match.world.hasLineOfSight(charge.position, center)) continue;

      const damage = explosionDamage(charge.damage, distance, charge.radius);
      this.match.applyDamage(
        target,
        owner,
        damage,
        DamageType.Explosive,
        HitZone.Chest,
        null,
        distance,
        now,
      );
    }
  }

  private stepHealFields(dt: number, dtMs: number): void {
    for (let i = this.healFields.length - 1; i >= 0; i--) {
      const field = this.healFields[i]!;
      const owner = this.match.players.get(field.ownerId);

      if (!owner?.alive) {
        this.healFields.splice(i, 1);
        continue;
      }

      // Taking damage interrupts the channel — this is what makes the skill a
      // disengage tool rather than a sustain button mid-fight.
      if (field.interruptOnDamage && owner.health < field.lastOwnerHealth) {
        this.healFields.splice(i, 1);
        continue;
      }
      field.lastOwnerHealth = owner.health;

      field.remainingMs -= dtMs;
      if (field.remainingMs <= 0) {
        this.healFields.splice(i, 1);
        continue;
      }

      const heal = field.healPerSecond * dt;
      for (const target of this.match.players.values()) {
        if (!target.alive) continue;
        const sameTeam = !this.match.mode.config.teamBased
          ? target.id === owner.id
          : target.team === owner.team;
        if (!sameTeam) continue;
        if (v3dist(target.position, owner.position) > field.radius) continue;
        target.health = Math.min(target.maxHealth, target.health + heal);
      }
    }
  }

  /** Barriers block bullets; the match asks about them when tracing. */
  barrierAt(position: Vec3, radius = 0.5): Barrier | null {
    for (const barrier of this.barriers) {
      if (v3dist(barrier.position, position) <= barrier.width / 2 + radius) return barrier;
    }
    return null;
  }

  damageBarrier(barrier: Barrier, amount: number): void {
    barrier.health -= amount;
    if (barrier.health <= 0) {
      log.debug('barrier destroyed', { barrierId: barrier.id, ownerId: barrier.ownerId });
    }
  }

  /** Active state, for the snapshot's world events. */
  activeBarriers(): readonly Barrier[] {
    return this.barriers;
  }

  reset(): void {
    this.barriers.length = 0;
    this.charges.length = 0;
    this.healFields.length = 0;
  }
}
