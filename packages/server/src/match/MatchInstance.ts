/**
 * The authoritative match.
 *
 * This is where the game actually happens. Every tick it:
 *   1. drains each player's queued inputs and runs the shared movement and
 *      weapon simulation over them,
 *   2. resolves any shots those inputs produced, rewinding other players'
 *      hitboxes to the moment the shooter saw them,
 *   3. advances skills, projectiles, vehicles and timers,
 *   4. asks the game mode whether anything ended,
 *   5. records poses for the next tick's lag compensation.
 *
 * The client's word is never taken for an outcome. It says "I pressed fire on
 * input 412"; the server decides where that shot went and what it hit.
 */

import {
  CollisionWorld,
  DamageType,
  FireMode,
  GRAVITY,
  HitZone,
  InputButton,
  MatchPhase,
  MovementState,
  PLAYER_HEIGHT_STAND,
  RESPAWN_DELAY_MS,
  SurfaceMaterial,
  TICK_MS,
  TeamId,
  WeaponPhase,
  aabbContains,
  clamp,
  computeDamage,
  computeRecoil,
  computeShotRays,
  createLogger,
  createProjectile,
  explosionDamage,
  fallDamage,
  mixSeeds,
  penetrationLossFor,
  playerCenter,
  raycastHitboxes,
  requireMap,
  shotIntervalMs,
  stepMovement,
  stepProjectile,
  stepWeapon,
  v3add,
  v3dist,
  v3normalize,
  v3scale,
  v3sub,
  vec3,
  type KillEvent,
  type MapDefinition,
  type PlayerInput,
  type Projectile,
  type ResolvedWeapon,
  type ServerMessage,
  type Vec3,
} from '@titan/shared';
import { ServerMessageType } from '@titan/shared';
import { PlayerEntity } from './PlayerEntity.js';
import { SpawnSelector } from './SpawnSelector.js';
import { rewindTargetTime } from './LagCompensation.js';
import { MatchEventType, MatchRecorder } from './MatchEvents.js';
import type { GameMode, MatchView } from '../gamemodes/GameMode.js';
import type { LoadedWorld } from '../world/WorldRegistry.js';
import type { AntiCheat } from '../anticheat/AntiCheat.js';
import { SkillSystem } from '../combat/SkillSystem.js';
import { VehicleSystem } from '../combat/VehicleSystem.js';

const log = createLogger('Match');

export interface MatchPlayerSeed {
  id: string;
  displayName: string;
  team: TeamId;
  loadout: import('@titan/shared').Loadout;
  /** Matchmaking rating, kept for the post-match rank calculation. */
  rating: number;
}

export interface MatchOptions {
  id: string;
  modeId: string;
  mapId: string;
  seed: number;
  world: LoadedWorld;
  mode: GameMode;
  antiCheat: AntiCheat;
  players: MatchPlayerSeed[];
}

/** A message the match wants delivered. */
export interface OutboundMessage {
  /** null = broadcast to everyone in the match. */
  to: string[] | null;
  message: ServerMessage;
}

export class MatchInstance {
  readonly id: string;
  readonly modeId: string;
  readonly mapId: string;
  readonly seed: number;
  readonly map: MapDefinition;
  readonly world: CollisionWorld;
  readonly mode: GameMode;
  readonly recorder = new MatchRecorder();

  readonly players = new Map<string, PlayerEntity>();
  readonly ratings = new Map<string, number>();

  phase: MatchPhase = MatchPhase.Warmup;
  tick = 0;
  elapsedMs = 0;
  roundElapsedMs = 0;
  phaseTimeMs = 0;
  round = 1;

  readonly teamScores = new Map<TeamId, number>([
    [TeamId.Alpha, 0],
    [TeamId.Bravo, 0],
  ]);
  readonly roundsWon = new Map<TeamId, number>([
    [TeamId.Alpha, 0],
    [TeamId.Bravo, 0],
  ]);
  readonly playerScores = new Map<string, number>();
  readonly objectiveOwners = new Map<string, TeamId>();

  /** Result, set once the match ends. */
  winningTeam: TeamId = TeamId.None;
  winningPlayerId: string | null = null;
  ended = false;

  private readonly spawns: SpawnSelector;
  private readonly skills: SkillSystem;
  private readonly vehicles: VehicleSystem;
  private readonly antiCheat: AntiCheat;

  private readonly inputQueues = new Map<string, PlayerInput[]>();
  private readonly outbound: OutboundMessage[] = [];
  private readonly projectiles: Projectile[] = [];
  private nextProjectileId = 1;
  private readonly lastDeathPositions = new Map<string, Vec3>();
  /** Brushes destroyed this match (glass); reset between matches. */
  private readonly destroyedBrushes = new Set<number>();
  private firstBloodTaken = false;
  private readonly loadout = new Map<string, import('@titan/shared').Loadout>();

  constructor(options: MatchOptions) {
    this.id = options.id;
    this.modeId = options.modeId;
    this.mapId = options.mapId;
    this.seed = options.seed;
    this.map = options.world.map;
    this.world = options.world.collision;
    this.mode = options.mode;
    this.antiCheat = options.antiCheat;

    this.spawns = new SpawnSelector(this.map, this.world, options.seed);
    this.skills = new SkillSystem(this);
    this.vehicles = new VehicleSystem(this);

    let alphaIndex = 0;
    let bravoIndex = 0;
    for (const seed of options.players) {
      const index = seed.team === TeamId.Bravo ? bravoIndex++ : alphaIndex++;
      const spawn = this.spawns.selectInitial(seed.team, index);
      const entity = new PlayerEntity(
        seed.id,
        seed.displayName,
        seed.team,
        seed.loadout,
        spawn.position,
        spawn.yaw,
      );
      entity.health = entity.maxHealth;
      entity.shield = entity.maxShield;
      this.players.set(seed.id, entity);
      this.playerScores.set(seed.id, 0);
      this.ratings.set(seed.id, seed.rating);
      this.loadout.set(seed.id, seed.loadout);
      this.inputQueues.set(seed.id, []);

      this.recorder.record({
        type: MatchEventType.PlayerJoin,
        at: 0,
        tick: 0,
        playerId: seed.id,
        displayName: seed.displayName,
        team: seed.team,
      });
    }

    this.phaseTimeMs = this.mode.config.warmupSec * 1000;
    this.recorder.record({
      type: MatchEventType.MatchStart,
      at: 0,
      tick: 0,
      mapId: this.mapId,
      modeId: this.modeId,
      seed: this.seed,
    });
    this.mode.onMatchStart(this.view);
    this.vehicles.spawnFromMap(this.map);

    log.info('match created', {
      matchId: this.id,
      mode: this.modeId,
      map: this.mapId,
      players: this.players.size,
    });
  }

  // ======================================================== view for modes ==

  get view(): MatchView {
    return {
      mapId: this.mapId,
      phase: this.phase,
      players: this.players,
      elapsedMs: this.elapsedMs,
      roundElapsedMs: this.roundElapsedMs,
      round: this.round,
      teamScores: this.teamScores,
      roundsWon: this.roundsWon,
      playerScores: this.playerScores,
      objectiveOwners: this.objectiveOwners,
      livingPlayers: (team?: TeamId) =>
        Array.from(this.players.values()).filter(
          (p) => p.alive && p.disconnectedAt === null && (team === undefined || p.team === team),
        ),
      teamOf: (playerId: string) => this.players.get(playerId)?.team ?? TeamId.None,
    };
  }

  // ============================================================== ingress ==

  /** Queue validated inputs from a client. */
  enqueueInputs(playerId: string, inputs: PlayerInput[]): void {
    const player = this.players.get(playerId);
    if (!player) return;

    const queue = this.inputQueues.get(playerId);
    if (!queue) return;

    for (const input of inputs) {
      // Drop replays and out-of-order duplicates.
      if (!this.antiCheat.checkSequence(playerId, input)) continue;
      queue.push(input);
    }

    // Bound the backlog. A client that floods us with inputs must not be able
    // to make the server do unbounded work on a later tick.
    const MAX_BACKLOG = 40;
    if (queue.length > MAX_BACKLOG) {
      this.antiCheat.reportFlood(playerId, `input backlog ${queue.length}`);
      queue.splice(0, queue.length - MAX_BACKLOG);
    }
  }

  setPing(playerId: string, roundTripMs: number): void {
    const player = this.players.get(playerId);
    if (player) player.roundTripMs = clamp(roundTripMs, 0, 1000);
  }

  switchWeapon(playerId: string, slot: number): void {
    const player = this.players.get(playerId);
    if (!player?.alive) return;
    player.switchWeapon(slot);
  }

  requestRespawn(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || player.alive) return;
    if (!this.mode.canRespawn(this.view, player)) return;
    // Honour the respawn delay: an early request just means "spawn me as soon
    // as the timer allows" rather than skipping it.
    if (player.respawnInMs > 0) return;
    this.respawnPlayer(player);
  }

  useSkill(playerId: string, aimYaw: number, aimPitch: number): void {
    const player = this.players.get(playerId);
    if (!player?.alive || this.phase !== MatchPhase.Live) return;
    this.skills.activate(player, aimYaw, aimPitch);
  }

  applyLoadout(playerId: string, loadout: import('@titan/shared').Loadout): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.loadout.set(playerId, loadout);
    // Applying mid-life would let a player swap to a full magazine on demand,
    // so a change only takes effect on the next spawn.
    if (!player.alive) player.applyLoadout(loadout);
  }

  markDisconnected(playerId: string, now: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.disconnectedAt = now;
    // A disconnected player is a sitting duck; take them out of the world but
    // keep their slot and stats for the reconnect window.
    player.alive = false;
    log.info('player disconnected mid-match', { matchId: this.id, playerId });
  }

  markReconnected(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    player.disconnectedAt = null;
    if (this.mode.canRespawn(this.view, player)) {
      player.respawnInMs = 1500;
    }
    log.info('player reconnected', { matchId: this.id, playerId });
    return true;
  }

  removePlayer(playerId: string, reason: string): void {
    if (!this.players.has(playerId)) return;
    this.recorder.record({
      type: MatchEventType.PlayerLeave,
      at: this.elapsedMs,
      tick: this.tick,
      playerId,
      reason,
    });
    this.players.delete(playerId);
    this.inputQueues.delete(playerId);
    this.playerScores.delete(playerId);
  }

  // ================================================================= tick ==

  /** Advance one server tick. */
  step(now: number): void {
    if (this.ended) return;

    const dtMs = TICK_MS;
    this.tick++;
    this.elapsedMs += dtMs;
    if (this.phase === MatchPhase.Live) this.roundElapsedMs += dtMs;

    this.advancePhase(dtMs, now);

    // Timers first, so cooldowns and respawn counters are current.
    for (const player of this.players.values()) {
      player.tickTimers(dtMs, now);
      if (!player.alive && player.disconnectedAt === null) {
        player.respawnInMs = Math.max(0, player.respawnInMs - dtMs);
        if (player.respawnInMs === 0 && this.mode.canRespawn(this.view, player)) {
          this.respawnPlayer(player);
        }
      }
    }

    // Simulate each player's queued inputs.
    for (const player of this.players.values()) {
      this.simulatePlayer(player, now);
    }

    this.skills.step(dtMs, now);
    this.vehicles.step(dtMs, now);
    this.stepProjectiles(dtMs, now);

    if (this.phase === MatchPhase.Live) {
      const delta = this.mode.onTick(this.view, dtMs);
      if (delta) this.applyScoreDelta(delta);
      this.trackZones();
      this.checkOutOfBounds(now);
      this.syncObjectiveOwners();
      this.evaluateEnd(now);
    }

    // Record poses last, so history reflects the end-of-tick state.
    for (const player of this.players.values()) player.recordPose(now);
  }

  private advancePhase(dtMs: number, now: number): void {
    this.phaseTimeMs = Math.max(0, this.phaseTimeMs - dtMs);
    if (this.phaseTimeMs > 0) return;

    switch (this.phase) {
      case MatchPhase.Warmup:
        this.phase = MatchPhase.Countdown;
        this.phaseTimeMs = this.mode.config.countdownSec * 1000;
        break;
      case MatchPhase.Countdown:
        this.phase = MatchPhase.Live;
        this.roundElapsedMs = 0;
        this.beginRound(now);
        break;
      case MatchPhase.RoundEnd:
        this.round++;
        this.phase = MatchPhase.Live;
        this.roundElapsedMs = 0;
        this.beginRound(now);
        break;
      default:
        break;
    }
  }

  private beginRound(now: number): void {
    if (this.mode.config.roundBased) {
      // Reset everyone to a fresh spawn with full health and ammo.
      let alphaIndex = 0;
      let bravoIndex = 0;
      for (const player of this.players.values()) {
        const loadout = this.loadout.get(player.id);
        if (loadout) player.applyLoadout(loadout);
        const index = player.team === TeamId.Bravo ? bravoIndex++ : alphaIndex++;
        const spawn = this.spawns.selectInitial(player.team, index);
        player.resetForRound(spawn.position, spawn.yaw, now);
      }
      this.destroyedBrushes.clear();
      this.world.resetDestruction();
      this.vehicles.reset();
    }
    this.mode.onRoundStart(this.view, this.round);
    this.recorder.record({
      type: MatchEventType.RoundStart,
      at: this.elapsedMs,
      tick: this.tick,
      round: this.round,
    });
    this.broadcast({ type: ServerMessageType.MatchState, ...this.matchStatePayload() });
  }

  // ======================================================= player stepping ==

  private simulatePlayer(player: PlayerEntity, now: number): void {
    const queue = this.inputQueues.get(player.id);

    // Process at most a few inputs per tick, so a backlog is worked off
    // smoothly rather than teleporting the player.
    const MAX_PER_TICK = 4;
    const toProcess = queue ? queue.splice(0, MAX_PER_TICK) : [];

    let consumedMs = 0;
    for (const input of toProcess) {
      consumedMs += input.deltaMs;
      if (!this.antiCheat.checkTimeBudget(player.id, input.deltaMs, now)) continue;

      const before = player.movement.position;

      if (player.alive && player.vehicleId === null) {
        player.movement = stepMovement(player.movement, input, this.world, player.movementProfile);

        // Fall damage on landing.
        if (player.movement.landedSpeed > 0) {
          const damage = fallDamage(player.movement.landedSpeed, player.movementProfile);
          if (damage > 0) this.applyDamage(player, null, damage, DamageType.Fall, HitZone.Limb, null, 0, now);
        }

        this.antiCheat.checkMovement(
          player.id,
          before,
          player.movement.position,
          input.deltaMs,
          player.movementProfile,
          now,
        );
      } else {
        // Dead or riding: still track look direction so the camera is right.
        player.movement.yaw = input.yaw;
        player.movement.pitch = input.pitch;
      }

      player.applyInputMeta(input);

      if (player.alive) this.simulateWeapon(player, input, now);
    }

    // The simulation must advance on server time, not only when input happens
    // to arrive. Any part of the tick not covered by real input is simulated
    // with a neutral input, which matters in two ways:
    //
    //   - physics: a player whose packets stop mid-air would otherwise freeze
    //     there instead of falling, and an idle player never settles onto the
    //     ground (so they count as airborne, which widens their weapon spread);
    //   - weapon timers: a reload or an equip would stall until the player's
    //     connection recovered.
    //
    // The neutral input carries zero movement and zero buttons, so idle time
    // can never move the player under their own power or fire their weapon.
    const remainingMs = TICK_MS - consumedMs;
    if (player.alive && remainingMs > 0.5) {
      const idle: PlayerInput = {
        sequence: player.lastProcessedInput,
        deltaMs: remainingMs,
        moveX: 0,
        moveZ: 0,
        yaw: player.movement.yaw,
        pitch: player.movement.pitch,
        buttons: 0,
        clientTimeMs: now,
      };

      if (player.vehicleId === null) {
        const before = player.movement.position;
        player.movement = stepMovement(player.movement, idle, this.world, player.movementProfile);
        if (player.movement.landedSpeed > 0) {
          const damage = fallDamage(player.movement.landedSpeed, player.movementProfile);
          if (damage > 0) {
            this.applyDamage(player, null, damage, DamageType.Fall, HitZone.Limb, null, 0, now);
          }
        }
        void before;
      }

      this.simulateWeapon(player, idle, now);
    }
  }

  private simulateWeapon(player: PlayerEntity, input: PlayerInput, now: number): void {
    const weapon = player.activeWeapon;
    const runtime = player.activeRuntime;
    if (!weapon || !runtime) return;

    // Firing is blocked during warmup, spawn protection, and while phased.
    const canFire =
      this.phase === MatchPhase.Live &&
      player.phasedMs <= 0 &&
      !(player.isSpawnProtected && (input.buttons & InputButton.Fire) !== 0 && false);

    const result = stepWeapon(runtime, weapon, {
      fire: canFire && (input.buttons & InputButton.Fire) !== 0,
      aim: (input.buttons & InputButton.Aim) !== 0,
      reload: (input.buttons & InputButton.Reload) !== 0,
      deltaMs: input.deltaMs,
    });

    player.runtimes[player.activeSlot] = result.runtime;

    if (result.dryFired) {
      this.send(player.id, {
        type: ServerMessageType.CombatEvent,
        event: { kind: 'impact', at: [0, 0, 0], normal: [0, 1, 0], material: SurfaceMaterial.Metal },
      });
    }

    for (let i = 0; i < result.shotsFired; i++) {
      // Firing cancels spawn protection: you cannot shoot from behind it.
      if (player.spawnProtectedMs > 0) player.spawnProtectedMs = 0;

      if (!this.antiCheat.checkFireRate(player.id, shotIntervalMs(weapon), now)) continue;
      this.fireShot(player, weapon, result.runtime.totalShotsFired + i, input, now);
    }
  }

  // ================================================================ combat ==

  private fireShot(
    player: PlayerEntity,
    weapon: ResolvedWeapon,
    shotIndex: number,
    input: PlayerInput,
    now: number,
  ): void {
    const runtime = player.activeRuntime!;
    const origin = player.eye;
    const isAiming = runtime.adsProgress > 0.5;

    // The seed is derived from the match seed, the player and the shot index,
    // so the client can predict the identical spread pattern.
    const seed = mixSeeds(this.seed, hashId(player.id), shotIndex);

    const rays = computeShotRays(weapon, {
      origin,
      yaw: player.movement.yaw,
      pitch: player.movement.pitch,
      spreadAccum: runtime.spread,
      isAiming,
      isCrouching: player.movement.crouching,
      isMoving: Math.hypot(player.movement.velocity.x, player.movement.velocity.z) > 1.2,
      isAirborne: !player.movement.grounded,
      seed,
    });

    player.shotsFired += rays.length;

    // Recoil is applied server-side and reported; the client blends toward it.
    const kick = computeRecoil(weapon, shotIndex, isAiming, seed);
    player.recoilPitch += kick.pitch;
    player.recoilYaw += kick.yaw;

    this.recorder.record({
      type: MatchEventType.Shot,
      at: this.elapsedMs,
      tick: this.tick,
      playerId: player.id,
      weaponId: weapon.id,
      origin,
      direction: rays[0]!.direction,
      seed,
      pellets: rays.length,
    });

    // Tell everyone about the shot so tracers, muzzle flash and sound play.
    // Suppressed weapons still produce a tracer but are excluded from the
    // minimap reveal (handled client-side from `suppressed`).
    this.broadcast({
      type: ServerMessageType.CombatEvent,
      event: {
        kind: 'shot',
        shooterId: player.id,
        origin: [origin.x, origin.y, origin.z],
        direction: [rays[0]!.direction.x, rays[0]!.direction.y, rays[0]!.direction.z],
        weaponId: weapon.id,
        pellets: rays.length,
        seed,
      },
    });

    if (weapon.projectileSpeed > 0) {
      for (const ray of rays) {
        this.projectiles.push(
          createProjectile(this.nextProjectileId++, player.id, weapon, origin, ray.direction),
        );
      }
      return;
    }

    // Hitscan: rewind everyone else to the moment this player saw them.
    const rewindTo = rewindTargetTime(now, player.roundTripMs);
    let anyHit = false;

    for (const ray of rays) {
      const hit = this.traceShot(player, weapon, ray.origin, ray.direction, rewindTo, now);
      if (hit) anyHit = true;
    }

    if (anyHit) player.shotsHit++;
    void input;
  }

  /**
   * Trace one bullet: find the nearest wall, then the nearest player in front
   * of it, accounting for penetrable surfaces.
   */
  private traceShot(
    shooter: PlayerEntity,
    weapon: ResolvedWeapon,
    origin: Vec3,
    direction: Vec3,
    rewindTo: number,
    now: number,
  ): boolean {
    let remainingRange = weapon.maxRange;
    let currentOrigin = origin;
    let penetrationLoss = 0;
    let travelled = 0;

    // Walk through up to two penetrable surfaces.
    for (let pass = 0; pass < 3 && remainingRange > 0; pass++) {
      const worldHit = this.world.raycast(currentOrigin, direction, remainingRange, true);
      const wallDistance = worldHit ? worldHit.distance : remainingRange;

      // Nearest player in front of the wall.
      let nearest: { player: PlayerEntity; zone: HitZone; distance: number; point: Vec3 } | null = null;

      for (const target of this.players.values()) {
        if (target.id === shooter.id) continue;
        if (!target.alive || target.disconnectedAt !== null) continue;
        if (target.isSpawnProtected) continue;
        if (!this.canDamage(shooter, target)) continue;

        const pose = target.poseHistory.sample(rewindTo);
        const position = pose?.position ?? target.position;
        const height = pose?.height ?? target.movement.height;
        const state = pose?.state ?? target.movement.state;

        const hit = raycastHitboxes(currentOrigin, direction, wallDistance, position, height, state);
        if (hit && (!nearest || hit.distance < nearest.distance)) {
          nearest = { player: target, zone: hit.zone, distance: hit.distance, point: hit.point };
        }
      }

      if (nearest) {
        const totalDistance = travelled + nearest.distance;
        if (!this.antiCheat.checkReach(shooter.id, totalDistance, weapon.maxRange, now)) return false;

        const damage = computeDamage(weapon, totalDistance, nearest.zone, penetrationLoss);
        this.applyDamage(
          nearest.player,
          shooter,
          damage,
          weapon.damageType,
          nearest.zone,
          weapon.id,
          totalDistance,
          now,
        );

        // Impact feedback at the point of contact.
        this.broadcast({
          type: ServerMessageType.CombatEvent,
          event: {
            kind: 'impact',
            at: [nearest.point.x, nearest.point.y, nearest.point.z],
            normal: [-direction.x, -direction.y, -direction.z],
            material: SurfaceMaterial.Flesh,
          },
        });
        return true;
      }

      if (!worldHit) return false;

      // Hit geometry. Report the impact for decals and sound.
      this.broadcast({
        type: ServerMessageType.CombatEvent,
        event: {
          kind: 'impact',
          at: [worldHit.point.x, worldHit.point.y, worldHit.point.z],
          normal: [worldHit.normal.x, worldHit.normal.y, worldHit.normal.z],
          material: worldHit.material,
        },
      });

      // Break glass.
      if (worldHit.material === SurfaceMaterial.Glass) this.breakBrush(worldHit.brushId, worldHit.point);

      const loss = penetrationLossFor(worldHit.material);
      if (loss >= 1) return false; // stopped

      penetrationLoss = Math.min(0.95, penetrationLoss + loss);
      travelled += worldHit.distance + 0.05;
      remainingRange -= worldHit.distance + 0.05;
      currentOrigin = v3add(currentOrigin, v3scale(direction, worldHit.distance + 0.05));
    }

    return false;
  }

  /** Friendly fire rules. */
  canDamage(attacker: PlayerEntity, victim: PlayerEntity): boolean {
    if (attacker.id === victim.id) return true;
    if (!this.mode.config.teamBased) return true;
    if (attacker.team !== victim.team) return true;
    return this.mode.config.friendlyFire;
  }

  /**
   * Apply damage and resolve a kill if it is lethal.
   * This is the single place health changes, so scoring, quests and the killfeed
   * can never disagree about what happened.
   */
  applyDamage(
    victim: PlayerEntity,
    attacker: PlayerEntity | null,
    rawAmount: number,
    type: DamageType,
    zone: HitZone,
    weaponId: string | null,
    distance: number,
    now: number,
  ): void {
    if (!victim.alive || rawAmount <= 0) return;
    if (victim.isSpawnProtected && attacker && attacker.id !== victim.id) return;

    let amount = rawAmount;
    if (attacker && attacker.id !== victim.id && attacker.team === victim.team && this.mode.config.teamBased) {
      amount *= this.mode.config.friendlyFireScale;
      if (amount <= 0) return;
    }

    const { healthDamage, shieldDamage, lethal } = victim.applyDamage(amount, attacker?.id ?? null, now);
    const dealt = healthDamage + shieldDamage;
    if (dealt <= 0) return;

    if (attacker && attacker.id !== victim.id) {
      attacker.damageDealt += dealt;
      attacker.addSkillEnergyForDamage(dealt);
      if (zone === HitZone.Head) attacker.headshots++;

      this.recorder.record({
        type: MatchEventType.Hit,
        at: this.elapsedMs,
        tick: this.tick,
        attackerId: attacker.id,
        victimId: victim.id,
        damage: dealt,
        zone,
        weaponId: weaponId ?? 'unknown',
        distance,
      });

      // Hitmarker to the shooter — immediate, outside the snapshot cadence.
      this.send(attacker.id, {
        type: ServerMessageType.CombatEvent,
        event: {
          kind: 'hit',
          targetId: victim.id,
          damage: Math.round(dealt),
          zone,
          lethal,
          shieldOnly: healthDamage === 0,
        },
      });
    }

    // Directional damage indicator for the victim.
    const from = attacker
      ? v3normalize(v3sub(attacker.position, victim.position))
      : vec3(0, 1, 0);
    this.send(victim.id, {
      type: ServerMessageType.CombatEvent,
      event: {
        kind: 'damaged',
        attackerId: attacker?.id ?? null,
        amount: Math.round(dealt),
        fromDirection: [from.x, from.y, from.z],
      },
    });

    if (lethal) this.killPlayer(victim, attacker, weaponId, zone, distance, type, now);
  }

  private killPlayer(
    victim: PlayerEntity,
    attacker: PlayerEntity | null,
    weaponId: string | null,
    zone: HitZone,
    distance: number,
    type: DamageType,
    now: number,
  ): void {
    const assistIds = victim.assistants(attacker?.id ?? null, now);
    victim.kill(now);
    this.lastDeathPositions.set(victim.id, { ...victim.position });

    let streak = 0;
    let multiKill = 0;
    if (attacker && attacker.id !== victim.id) {
      const result = attacker.registerKill(now);
      streak = result.streak;
      multiKill = result.multiKill;

      if (streak >= 3) {
        this.broadcast({
          type: ServerMessageType.CombatEvent,
          event: { kind: 'streak', playerId: attacker.id, count: streak },
        });
      }
      if (multiKill >= 2) {
        this.broadcast({
          type: ServerMessageType.CombatEvent,
          event: { kind: 'multikill', playerId: attacker.id, count: multiKill },
        });
      }
    }

    for (const assistId of assistIds) {
      const assister = this.players.get(assistId);
      if (assister) assister.assists++;
    }

    const event: KillEvent = {
      killerId: attacker?.id ?? null,
      victimId: victim.id,
      assistIds,
      weaponId,
      zone,
      distance,
      killStreak: streak,
      multiKill,
      timestamp: now,
    };

    this.recorder.record({
      type: MatchEventType.Kill,
      at: this.elapsedMs,
      tick: this.tick,
      killerId: event.killerId,
      victimId: event.victimId,
      weaponId,
      zone,
      distance,
      assistIds,
      streak,
      multiKill,
    });

    const delta = this.mode.onKill(this.view, event);
    if (delta) this.applyScoreDelta(delta);

    this.broadcast({
      type: ServerMessageType.CombatEvent,
      event: { kind: 'killed', victimId: victim.id, killerId: attacker?.id ?? null },
    });

    this.broadcast({
      type: ServerMessageType.KillFeed,
      killerId: attacker?.id ?? null,
      killerName: attacker?.displayName ?? '',
      victimId: victim.id,
      victimName: victim.displayName,
      weaponId,
      headshot: zone === HitZone.Head,
      killerTeam: attacker?.team ?? TeamId.None,
      victimTeam: victim.team,
      assistNames: assistIds.map((id) => this.players.get(id)?.displayName ?? ''),
    });

    // Schedule the respawn.
    if (this.mode.canRespawn(this.view, victim)) {
      victim.respawnInMs = this.mode.config.respawnDelayMs || RESPAWN_DELAY_MS;
    }

    if (!this.firstBloodTaken && attacker && attacker.id !== victim.id) {
      this.firstBloodTaken = true;
    }

    void type;
  }

  private respawnPlayer(player: PlayerEntity): void {
    const enemies = Array.from(this.players.values())
      .filter((p) => p.alive && p.id !== player.id && (!this.mode.config.teamBased || p.team !== player.team))
      .map((p) => ({ position: p.position, eye: p.eye }));
    const allies = Array.from(this.players.values())
      .filter((p) => p.alive && p.id !== player.id && this.mode.config.teamBased && p.team === player.team)
      .map((p) => p.position);

    const spawn = this.spawns.select({
      team: player.team,
      enemies,
      allies,
      lastDeathPosition: this.lastDeathPositions.get(player.id) ?? null,
    });

    const loadout = this.loadout.get(player.id);
    if (loadout) player.applyLoadout(loadout);
    player.respawn(spawn.position, spawn.yaw, Date.now());

    this.recorder.record({
      type: MatchEventType.Spawn,
      at: this.elapsedMs,
      tick: this.tick,
      playerId: player.id,
      position: spawn.position,
    });

    this.broadcast({
      type: ServerMessageType.CombatEvent,
      event: {
        kind: 'respawn',
        playerId: player.id,
        at: [spawn.position.x, spawn.position.y, spawn.position.z],
      },
    });
  }

  // =========================================================== projectiles ==

  private stepProjectiles(dtMs: number, now: number): void {
    const dt = dtMs / 1000;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i]!;
      const result = stepProjectile(projectile, dt, this.world);
      this.projectiles[i] = result.projectile;

      // Direct hit on a player?
      let struck: PlayerEntity | null = null;
      for (const target of this.players.values()) {
        if (target.id === projectile.ownerId) continue;
        if (!target.alive || target.isSpawnProtected) continue;
        const center = playerCenter(target.position, target.movement.height);
        if (v3dist(result.projectile.position, center) <= 0.75) {
          struck = target;
          break;
        }
      }

      if (struck || result.worldHit || result.expired) {
        this.detonate(result.projectile, struck, result.worldHit?.point ?? result.projectile.position, now);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private detonate(projectile: Projectile, direct: PlayerEntity | null, at: Vec3, now: number): void {
    const owner = this.players.get(projectile.ownerId) ?? null;
    const weapon = owner?.weapons.find((w) => w?.id === projectile.weaponId) ?? null;
    if (!weapon) return;

    if (direct) {
      const damage = computeDamage(weapon, projectile.distanceTravelled, HitZone.Chest);
      this.applyDamage(direct, owner, damage, weapon.damageType, HitZone.Chest, weapon.id, projectile.distanceTravelled, now);
    }

    if (projectile.explosionRadius > 0) {
      this.broadcast({
        type: ServerMessageType.CombatEvent,
        event: { kind: 'impact', at: [at.x, at.y, at.z], normal: [0, 1, 0], material: SurfaceMaterial.Metal },
      });

      for (const target of this.players.values()) {
        if (!target.alive || target.isSpawnProtected) continue;
        if (target.id === direct?.id) continue;
        if (owner && !this.canDamage(owner, target)) continue;

        const center = playerCenter(target.position, target.movement.height);
        const distance = v3dist(at, center);
        if (distance > projectile.explosionRadius) continue;
        // Splash needs line of sight, so a wall actually protects you.
        if (!this.world.hasLineOfSight(at, center)) continue;

        const base = computeDamage(weapon, projectile.distanceTravelled, HitZone.Chest);
        const damage = explosionDamage(base, distance, projectile.explosionRadius);
        this.applyDamage(target, owner, damage, DamageType.Explosive, HitZone.Chest, weapon.id, distance, now);
      }
    }
  }

  // ================================================================ world ==

  breakBrush(brushId: number, at: Vec3): void {
    if (this.destroyedBrushes.has(brushId)) return;
    if (!this.world.removeBrush(brushId)) return;
    this.destroyedBrushes.add(brushId);
    this.recorder.record({
      type: MatchEventType.GlassBreak,
      at: this.elapsedMs,
      tick: this.tick,
      brushId,
      position: at,
    });
  }

  /** Kill anyone who leaves the playable volume. */
  private checkOutOfBounds(now: number): void {
    const { min, max } = this.map.bounds;
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      const p = player.position;
      const outside =
        p.x < min.x - 5 || p.x > max.x + 5 || p.z < min.z - 5 || p.z > max.z + 5 || p.y < min.y - 20;
      if (outside) {
        this.applyDamage(player, null, 9999, DamageType.Environment, HitZone.Chest, null, 0, now);
      }
    }
  }

  /** Note which map zones each player has entered, for exploration quests. */
  private trackZones(): void {
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      for (const zone of this.map.zones) {
        if (player.visitedZones.has(zone.id)) continue;
        if (aabbContains({ min: zone.min, max: zone.max }, player.position)) {
          player.visitedZones.add(zone.id);
        }
      }
    }
  }

  private syncObjectiveOwners(): void {
    for (const state of this.mode.objectiveState(this.view)) {
      this.objectiveOwners.set(state.id, state.owner);
    }
  }

  // =============================================================== scoring ==

  private applyScoreDelta(delta: { team?: { team: TeamId; amount: number }; players?: { playerId: string; amount: number }[] }): void {
    if (delta.team) {
      const current = this.teamScores.get(delta.team.team) ?? 0;
      this.teamScores.set(delta.team.team, Math.max(0, current + delta.team.amount));
    }
    for (const entry of delta.players ?? []) {
      const current = this.playerScores.get(entry.playerId) ?? 0;
      const next = Math.max(0, current + entry.amount);
      this.playerScores.set(entry.playerId, next);
      const player = this.players.get(entry.playerId);
      if (player) player.score = next;
    }
  }

  private evaluateEnd(now: number): void {
    if (this.mode.config.roundBased) {
      const roundResult = this.mode.checkRoundEnd(this.view);
      if (roundResult.ended) {
        if (roundResult.winningTeam !== TeamId.None) {
          const won = this.roundsWon.get(roundResult.winningTeam) ?? 0;
          this.roundsWon.set(roundResult.winningTeam, won + 1);
        }
        this.recorder.record({
          type: MatchEventType.RoundEnd,
          at: this.elapsedMs,
          tick: this.tick,
          round: this.round,
          winningTeam: roundResult.winningTeam,
        });

        const matchResult = this.mode.checkMatchEnd(this.view);
        if (matchResult.ended) {
          this.finish(matchResult.winningTeam, matchResult.winningPlayerId, now);
          return;
        }

        this.phase = MatchPhase.RoundEnd;
        this.phaseTimeMs = this.mode.config.roundResetSec * 1000;
        this.broadcast({ type: ServerMessageType.MatchState, ...this.matchStatePayload() });
        return;
      }
    }

    const result = this.mode.checkMatchEnd(this.view);
    if (result.ended) this.finish(result.winningTeam, result.winningPlayerId, now);
  }

  private finish(winningTeam: TeamId, winningPlayerId: string | null, now: number): void {
    this.ended = true;
    this.phase = MatchPhase.MatchEnd;
    this.winningTeam = winningTeam;
    this.winningPlayerId = winningPlayerId;
    this.phaseTimeMs = this.mode.config.postMatchSec * 1000;

    this.recorder.record({
      type: MatchEventType.MatchEnd,
      at: this.elapsedMs,
      tick: this.tick,
      winningTeam,
      winningPlayerId,
      durationMs: this.elapsedMs,
    });

    log.info('match ended', {
      matchId: this.id,
      winningTeam,
      winningPlayerId,
      durationMs: Math.round(this.elapsedMs),
    });
    void now;
  }

  // ============================================================= messaging ==

  broadcast(message: ServerMessage): void {
    this.outbound.push({ to: null, message });
  }

  send(playerId: string, message: ServerMessage): void {
    this.outbound.push({ to: [playerId], message });
  }

  /** Drain queued messages. The server transport delivers them. */
  drainOutbound(): OutboundMessage[] {
    const messages = this.outbound.slice();
    this.outbound.length = 0;
    return messages;
  }

  matchStatePayload() {
    const aliveCount: Record<string, number> = {};
    for (const team of [TeamId.Alpha, TeamId.Bravo]) {
      aliveCount[String(team)] = this.view.livingPlayers(team).length;
    }

    const timeRemainingMs =
      this.phase === MatchPhase.Live && this.mode.config.roundBased
        ? Math.max(0, this.mode.config.roundTimeSec * 1000 - this.roundElapsedMs)
        : this.phase === MatchPhase.Live && this.mode.config.timeLimitSec > 0
          ? Math.max(0, this.mode.config.timeLimitSec * 1000 - this.elapsedMs)
          : this.phaseTimeMs;

    return {
      phase: this.phase,
      timeRemainingMs,
      scores: Object.fromEntries(Array.from(this.teamScores, ([k, v]) => [String(k), v])),
      round: this.round,
      roundsWon: Object.fromEntries(Array.from(this.roundsWon, ([k, v]) => [String(k), v])),
      objectives: this.mode.objectiveState(this.view),
      aliveCount,
    };
  }

  get isFinished(): boolean {
    return this.ended && this.phaseTimeMs <= 0;
  }

  get activePlayerCount(): number {
    return Array.from(this.players.values()).filter((p) => p.disconnectedAt === null).length;
  }

  /** Read-only access for the skill and vehicle systems. */
  get liveProjectiles(): readonly Projectile[] {
    return this.projectiles;
  }

  /**
   * The authoritative vehicle system, so the connection layer can route a
   * client's board / drive / exit requests into it. Every one of its entry
   * points re-validates against server state — proximity, seat count, liveness
   * — so routing a message here grants the client nothing.
   */
  get vehicleSystem(): VehicleSystem {
    return this.vehicles;
  }

  spawnSelector(): SpawnSelector {
    return this.spawns;
  }
}

function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export { GRAVITY, PLAYER_HEIGHT_STAND, MovementState, FireMode, WeaponPhase };
