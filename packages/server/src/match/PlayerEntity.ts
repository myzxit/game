/**
 * A player inside a match.
 *
 * This is the authoritative state. The client keeps a predicted copy of the
 * movement and weapon parts; everything else (health, score, streaks) exists
 * only here.
 */

import {
  ASSIST_DAMAGE_THRESHOLD,
  ASSIST_WINDOW_MS,
  DEFAULT_MOVEMENT,
  MAX_HEALTH,
  MAX_SHIELD,
  MovementState,
  RingBuffer,
  SHIELD_REGEN_DELAY_MS,
  SHIELD_REGEN_PER_SEC,
  SnapshotFlag,
  TeamId,
  WeaponPhase,
  clamp,
  createMovementState,
  createWeaponRuntime,
  effectiveMovement,
  eyePosition,
  getCharacter,
  getSkill,
  resolveSkill,
  resolveWeapon,
  type Loadout,
  type MovementProfile,
  type MovementStateData,
  type PlayerInput,
  type ResolvedWeapon,
  type SkillDefinition,
  type Vec3,
  type WeaponRuntime,
} from '@titan/shared';
import { PoseHistory } from './LagCompensation.js';

/** Recent damage taken, for assist attribution. */
interface DamageRecord {
  attackerId: string;
  amount: number;
  at: number;
}

export interface SkillState {
  definition: SkillDefinition;
  cooldownMs: number;
  energy: number;
  /** Remaining active duration, 0 when inactive. */
  activeMs: number;
  uses: number;
}

export const MAX_SKILL_ENERGY = 100;
/** Energy regenerated per second while alive. */
const SKILL_ENERGY_PER_SEC = 4.5;
/** Energy granted per point of damage dealt — rewards engaging. */
const SKILL_ENERGY_PER_DAMAGE = 0.06;

export class PlayerEntity {
  readonly id: string;
  displayName: string;
  team: TeamId;

  movement: MovementStateData;
  movementProfile: MovementProfile;

  health = MAX_HEALTH;
  shield = 0;
  maxHealth = MAX_HEALTH;
  maxShield = MAX_SHIELD;
  alive = true;

  /** Weapon slots: 0 primary, 1 secondary, 2 melee. */
  readonly weapons: (ResolvedWeapon | null)[] = [null, null, null];
  readonly runtimes: (WeaponRuntime | null)[] = [null, null, null];
  activeSlot = 0;

  skill: SkillState | null = null;

  loadout: Loadout;
  characterId: string;
  skinId: string | null = null;

  /** Scoring. */
  kills = 0;
  deaths = 0;
  assists = 0;
  score = 0;
  damageDealt = 0;
  headshots = 0;
  shotsFired = 0;
  shotsHit = 0;
  killStreak = 0;
  bestStreak = 0;
  /** Kills inside the multi-kill window. */
  multiKillCount = 0;
  lastKillAt = 0;

  /** Timers, all in ms. */
  respawnInMs = 0;
  spawnProtectedMs = 0;
  lastDamageTakenAt = 0;
  /** Set while phased by the Phase Veil skill. */
  phasedMs = 0;
  /** Set while revealed by an enemy scan. */
  scannedMs = 0;

  /** Networking. */
  lastProcessedInput = -1;
  lastAckedSnapshot = -1;
  roundTripMs = 60;
  /** Set when the socket drops; the slot is held for the grace window. */
  disconnectedAt: number | null = null;

  /** Vehicle currently occupied, if any. */
  vehicleId: number | null = null;
  vehicleDistance = 0;

  /** Recoil the server has applied; the client blends toward this. */
  recoilPitch = 0;
  recoilYaw = 0;

  readonly poseHistory = new PoseHistory();
  private readonly recentDamage = new RingBuffer<DamageRecord>(32);

  /** Zones visited this match, for exploration quests. */
  readonly visitedZones = new Set<string>();

  constructor(id: string, displayName: string, team: TeamId, loadout: Loadout, spawn: Vec3, yaw: number) {
    this.id = id;
    this.displayName = displayName;
    this.team = team;
    this.loadout = loadout;
    this.characterId = loadout.characterId;
    this.skinId = loadout.characterSkinId;
    this.movement = createMovementState(spawn, yaw);
    this.movementProfile = DEFAULT_MOVEMENT;
    this.applyLoadout(loadout);
  }

  /** Rebuild weapons and character bonuses from a loadout. */
  applyLoadout(loadout: Loadout): void {
    this.loadout = loadout;
    this.characterId = loadout.characterId;
    this.skinId = loadout.characterSkinId;

    const ids = [loadout.primaryWeaponId, loadout.secondaryWeaponId, loadout.meleeWeaponId];
    for (let slot = 0; slot < 3; slot++) {
      const weaponId = ids[slot]!;
      const attachments = loadout.attachments[weaponId] ?? {};
      const resolved = resolveWeapon(weaponId, attachments);
      this.weapons[slot] = resolved;
      this.runtimes[slot] = resolved ? createWeaponRuntime(resolved) : null;
    }

    const character = getCharacter(loadout.characterId);
    this.maxHealth = MAX_HEALTH + (character?.healthBonus ?? 0);
    this.maxShield = MAX_SHIELD + (character?.shieldBonus ?? 0);

    const skillDef = getSkill(loadout.skillId);
    this.skill = skillDef
      ? { definition: skillDef, cooldownMs: 0, energy: MAX_SKILL_ENERGY, activeMs: 0, uses: 0 }
      : null;

    this.refreshMovementProfile();
  }

  /** Movement speed depends on the character and the equipped weapon. */
  refreshMovementProfile(): void {
    const character = getCharacter(this.characterId);
    const weapon = this.activeWeapon;
    this.movementProfile = effectiveMovement(
      DEFAULT_MOVEMENT,
      character?.moveSpeedMultiplier ?? 1,
      weapon?.mobility ?? 1,
    );
  }

  get activeWeapon(): ResolvedWeapon | null {
    return this.weapons[this.activeSlot] ?? null;
  }

  get activeRuntime(): WeaponRuntime | null {
    return this.runtimes[this.activeSlot] ?? null;
  }

  get eye(): Vec3 {
    return eyePosition(this.movement);
  }

  get position(): Vec3 {
    return this.movement.position;
  }

  get isSpawnProtected(): boolean {
    return this.spawnProtectedMs > 0;
  }

  /** Total effective health, for TTK calculations and the HUD. */
  get effectiveHealth(): number {
    return this.health + this.shield;
  }

  switchWeapon(slot: number): boolean {
    if (slot < 0 || slot > 2) return false;
    if (slot === this.activeSlot) return false;
    if (!this.weapons[slot]) return false;

    const runtime = this.runtimes[slot]!;
    const weapon = this.weapons[slot]!;
    // Re-entering a slot restarts the equip animation but keeps its ammo.
    this.runtimes[slot] = {
      ...runtime,
      phase: WeaponPhase.Equipping,
      phaseTimeMs: weapon.equipTimeMs,
      cooldownMs: 0,
      burstRemaining: 0,
      spread: 0,
      shotIndex: 0,
      adsProgress: 0,
      triggerHeld: true, // require a fresh trigger press after swapping
    };
    this.activeSlot = slot;
    this.refreshMovementProfile();
    return true;
  }

  /**
   * Apply damage. Shields absorb first.
   * Returns the split so the caller can report it and decide on a kill.
   */
  applyDamage(amount: number, attackerId: string | null, now: number): {
    healthDamage: number;
    shieldDamage: number;
    lethal: boolean;
  } {
    if (!this.alive || amount <= 0) return { healthDamage: 0, shieldDamage: 0, lethal: false };

    const shieldDamage = Math.min(this.shield, amount);
    this.shield -= shieldDamage;
    const healthDamage = Math.min(this.health, amount - shieldDamage);
    this.health -= healthDamage;

    this.lastDamageTakenAt = now;
    if (attackerId && attackerId !== this.id) {
      this.recentDamage.push({ attackerId, amount: healthDamage + shieldDamage, at: now });
    }

    const lethal = this.health <= 0;
    if (lethal) this.health = 0;
    return { healthDamage, shieldDamage, lethal };
  }

  /**
   * Who assisted in this player's death: anyone who dealt at least
   * ASSIST_DAMAGE_THRESHOLD within the assist window, excluding the killer.
   */
  assistants(killerId: string | null, now: number): string[] {
    const totals = new Map<string, number>();
    for (const record of this.recentDamage.toArray()) {
      if (now - record.at > ASSIST_WINDOW_MS) continue;
      if (record.attackerId === killerId) continue;
      totals.set(record.attackerId, (totals.get(record.attackerId) ?? 0) + record.amount);
    }
    return Array.from(totals.entries())
      .filter(([, amount]) => amount >= ASSIST_DAMAGE_THRESHOLD)
      .map(([id]) => id);
  }

  kill(now: number): void {
    this.alive = false;
    this.health = 0;
    this.shield = 0;
    this.deaths++;
    this.killStreak = 0;
    this.multiKillCount = 0;
    this.recentDamage.clear();
    this.movement.velocity = { x: 0, y: 0, z: 0 };
    void now;
  }

  /** Record a kill by this player, returning the multi-kill count. */
  registerKill(now: number): { streak: number; multiKill: number } {
    this.kills++;
    this.killStreak++;
    this.bestStreak = Math.max(this.bestStreak, this.killStreak);

    const MULTIKILL_WINDOW = 4500;
    this.multiKillCount = now - this.lastKillAt <= MULTIKILL_WINDOW ? this.multiKillCount + 1 : 1;
    this.lastKillAt = now;

    return { streak: this.killStreak, multiKill: this.multiKillCount };
  }

  respawn(position: Vec3, yaw: number, now: number): void {
    this.movement = createMovementState(position, yaw);
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.alive = true;
    this.respawnInMs = 0;
    this.spawnProtectedMs = 2500;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.phasedMs = 0;
    this.vehicleId = null;
    this.lastDamageTakenAt = now;

    // Full resupply on respawn.
    for (let slot = 0; slot < 3; slot++) {
      const weapon = this.weapons[slot];
      if (!weapon) continue;
      this.runtimes[slot] = createWeaponRuntime(weapon);
    }
    this.activeSlot = 0;
    if (this.skill) {
      this.skill.cooldownMs = 0;
      this.skill.energy = MAX_SKILL_ENERGY;
      this.skill.activeMs = 0;
    }
    this.refreshMovementProfile();
  }

  /** Per-tick timers that don't depend on input. */
  tickTimers(dtMs: number, now: number): void {
    const dt = dtMs / 1000;

    this.spawnProtectedMs = Math.max(0, this.spawnProtectedMs - dtMs);
    this.phasedMs = Math.max(0, this.phasedMs - dtMs);
    this.scannedMs = Math.max(0, this.scannedMs - dtMs);

    if (this.skill) {
      this.skill.cooldownMs = Math.max(0, this.skill.cooldownMs - dtMs);
      this.skill.activeMs = Math.max(0, this.skill.activeMs - dtMs);
      if (this.alive) {
        this.skill.energy = Math.min(
          MAX_SKILL_ENERGY,
          this.skill.energy + SKILL_ENERGY_PER_SEC * dt,
        );
      }
    }

    // Shields regenerate after a lull, health does not — that is what makes
    // disengaging meaningful without removing the cost of a bad fight.
    if (this.alive && now - this.lastDamageTakenAt >= SHIELD_REGEN_DELAY_MS) {
      this.shield = Math.min(this.maxShield, this.shield + SHIELD_REGEN_PER_SEC * dt);
    }

    // Recoil decays back toward centre.
    const weapon = this.activeWeapon;
    if (weapon) {
      const recovery = weapon.recoil.recovery * dt;
      this.recoilPitch = Math.max(0, this.recoilPitch - recovery * this.recoilPitch);
      this.recoilYaw -= this.recoilYaw * Math.min(1, recovery);
    }
  }

  /** Reward energy for damage dealt, so aggression charges the ability. */
  addSkillEnergyForDamage(damage: number): void {
    if (!this.skill) return;
    this.skill.energy = Math.min(
      MAX_SKILL_ENERGY,
      this.skill.energy + damage * SKILL_ENERGY_PER_DAMAGE,
    );
  }

  canUseSkill(): boolean {
    if (!this.skill || !this.alive) return false;
    const resolved = resolveSkill(this.skill.definition.id, this.skill.uses) ?? this.skill.definition;
    return this.skill.cooldownMs <= 0 && this.skill.energy >= resolved.energyCost;
  }

  /** Consume the skill. Returns the resolved (upgrade-adjusted) definition. */
  consumeSkill(): SkillDefinition | null {
    if (!this.skill || !this.canUseSkill()) return null;
    const resolved = resolveSkill(this.skill.definition.id, this.skill.uses) ?? this.skill.definition;
    this.skill.energy -= resolved.energyCost;
    this.skill.cooldownMs = resolved.cooldownMs;
    this.skill.activeMs = resolved.durationMs;
    this.skill.uses++;
    return resolved;
  }

  /** Bitflags for the snapshot. */
  snapshotFlags(): number {
    let flags = 0;
    const runtime = this.activeRuntime;
    if (runtime) {
      if (runtime.triggerHeld) flags |= SnapshotFlag.Firing;
      if (runtime.phase === WeaponPhase.Reloading) flags |= SnapshotFlag.Reloading;
      if (runtime.adsProgress > 0.5) flags |= SnapshotFlag.Aiming;
    }
    if (this.isSpawnProtected) flags |= SnapshotFlag.SpawnProtected;
    if (this.phasedMs > 0) flags |= SnapshotFlag.Phased;
    if (this.vehicleId !== null) flags |= SnapshotFlag.InVehicle;
    if (this.movement.crouching) flags |= SnapshotFlag.Crouching;
    if (this.scannedMs > 0) flags |= SnapshotFlag.Scanned;
    return flags;
  }

  get accuracy(): number {
    return this.shotsFired > 0 ? clamp(this.shotsHit / this.shotsFired, 0, 1) : 0;
  }

  /** Record the current pose for lag compensation. */
  recordPose(serverTimeMs: number): void {
    this.poseHistory.record({
      timeMs: serverTimeMs,
      position: { ...this.movement.position },
      height: this.movement.height,
      state: this.movement.state,
      alive: this.alive,
    });
  }

  /** Reset between rounds in a round-based mode. */
  resetForRound(position: Vec3, yaw: number, now: number): void {
    this.respawn(position, yaw, now);
    this.killStreak = 0;
    this.multiKillCount = 0;
    this.poseHistory.clear();
  }

  applyInputMeta(input: PlayerInput): void {
    this.lastProcessedInput = input.sequence;
  }

  get movementState(): MovementState {
    return this.movement.state;
  }
}
