/**
 * Snapshot construction.
 *
 * Each client gets a snapshot tailored to it: the shared entity list plus a
 * private `local` block with information only that player may have (exact ammo,
 * stamina, cooldowns, the input sequence to reconcile from).
 *
 * Two things are deliberately *not* sent:
 *   - enemies the player cannot possibly perceive are still included, because
 *     hiding them would break interpolation the moment they came into view and
 *     produce visible popping; instead the client is given no extra information
 *     it could exploit beyond position, which it needs to render anyway.
 *   - a phased (Phase Veil) player's flags carry the phase bit rather than
 *     their opacity, so the client cannot read the exact concealment value.
 */

import {
  INTERPOLATION_DELAY_MS,
  MatchPhase,
  ServerMessageType,
  TeamId,
  WeaponPhase,
  buildDeltaSnapshot,
  quantizeAngle,
  quantizePos,
  quantizeVel,
  reloadProgress,
  type LocalPlayerState,
  type PlayerSnapshot,
  type ServerSnapshot,
} from '@titan/shared';
import type { MatchInstance } from './MatchInstance.js';
import type { PlayerEntity } from './PlayerEntity.js';

export class SnapshotBuilder {
  private nextId = 1;
  /** Every snapshot we've sent recently, keyed by id, so an ack can find its base. */
  private readonly history = new Map<number, ServerSnapshot>();
  private readonly historyLimit = 64;

  constructor(private readonly match: MatchInstance) {}

  /** Shared entity state — identical for every recipient. */
  private buildEntities(): PlayerSnapshot[] {
    const out: PlayerSnapshot[] = [];

    for (const player of this.match.players.values()) {
      // A player who has fully left is removed from the map; one who is merely
      // disconnected stays, so teammates see them standing there rather than
      // vanishing mid-round.
      const runtime = player.activeRuntime;
      out.push({
        id: player.id,
        pos: quantizePos(player.movement.position),
        vel: quantizeVel(player.movement.velocity),
        yaw: quantizeAngle(player.movement.yaw),
        pitch: quantizeAngle(player.movement.pitch),
        health: Math.ceil(player.health),
        shield: Math.ceil(player.shield),
        team: player.team,
        state: player.movement.state,
        height: Math.round(player.movement.height * 100),
        weaponId: player.activeWeapon?.id ?? '',
        ads: Math.round((runtime?.adsProgress ?? 0) * 100),
        alive: player.alive,
        flags: player.snapshotFlags(),
        characterId: player.characterId,
        skinId: player.skinId,
        displayName: player.displayName,
        score: Math.round(player.score),
        kills: player.kills,
        deaths: player.deaths,
        ping: Math.round(player.roundTripMs),
      });
    }

    return out;
  }

  /** The private half, for one player. */
  private buildLocal(player: PlayerEntity): LocalPlayerState {
    const weapon = player.activeWeapon;
    const runtime = player.activeRuntime;

    return {
      lastProcessedInput: player.lastProcessedInput,
      position: player.movement.position,
      velocity: player.movement.velocity,
      health: Math.ceil(player.health),
      shield: Math.ceil(player.shield),
      stamina: Math.round(player.movement.stamina),
      ammoInMag: runtime?.ammoInMag ?? 0,
      reserveAmmo: runtime?.reserveAmmo ?? 0,
      weaponSlot: player.activeSlot,
      weaponPhase: runtime?.phase ?? WeaponPhase.Ready,
      weaponPhaseTimeMs: Math.round(runtime?.phaseTimeMs ?? 0),
      spread: runtime?.spread ?? 0,
      skillCooldownMs: Math.round(player.skill?.cooldownMs ?? 0),
      skillEnergy: Math.round(player.skill?.energy ?? 0),
      alive: player.alive,
      respawnInMs: Math.round(player.respawnInMs),
      spawnProtectedMs: Math.round(player.spawnProtectedMs),
      recoilPitch: player.recoilPitch,
      recoilYaw: player.recoilYaw,
      vehicleId: player.vehicleId,
    };
  }

  /**
   * Build the snapshot for one player, delta-compressed against whatever they
   * last acknowledged.
   */
  build(player: PlayerEntity, serverTimeMs: number, entities: PlayerSnapshot[]): ServerSnapshot {
    const id = this.nextId++;

    const full: ServerSnapshot = {
      type: ServerMessageType.Snapshot,
      id,
      serverTimeMs,
      tick: this.match.tick,
      baseId: -1,
      players: entities,
      removed: [],
      local: this.buildLocal(player),
      projectiles: this.match.liveProjectiles.map((p) => ({
        id: p.id,
        pos: quantizePos(p.position),
        weaponId: p.weaponId,
      })),
      vehicles: this.match.vehicleSystem.snapshot(),
      worldEvents: [],
    };

    // Remember the full version so a later ack can be used as a delta base.
    this.history.set(id, full);
    if (this.history.size > this.historyLimit) {
      const oldest = this.history.keys().next().value;
      if (oldest !== undefined) this.history.delete(oldest);
    }

    const base = player.lastAckedSnapshot >= 0 ? this.history.get(player.lastAckedSnapshot) : undefined;
    if (!base) return full;

    const delta = buildDeltaSnapshot(base, full);
    return delta as ServerSnapshot;
  }

  /** Build one entity list and hand each player their tailored snapshot. */
  buildAll(serverTimeMs: number): Map<string, ServerSnapshot> {
    const entities = this.buildEntities();
    const out = new Map<string, ServerSnapshot>();
    for (const player of this.match.players.values()) {
      if (player.disconnectedAt !== null) continue;
      out.set(player.id, this.build(player, serverTimeMs, entities));
    }
    return out;
  }

  /**
   * Record the newest snapshot a client has confirmed receiving.
   *
   * Acks arrive two ways: a dedicated AckSnapshot message, and piggybacked on
   * every input batch. Both land here, and the newest id wins — an ack can
   * overtake an input batch in flight, and accepting an older id would send a
   * delta against a base the client has already discarded.
   *
   * A client that fails to reconstruct a delta acks -1, which resets the base
   * so the next snapshot is sent in full.
   */
  acknowledge(playerId: string, snapshotId: number): void {
    const player = this.match.players.get(playerId);
    if (!player) return;
    if (snapshotId < 0) {
      player.lastAckedSnapshot = -1;
      return;
    }
    // Only ids we actually sent, and only forwards.
    if (!this.history.has(snapshotId)) return;
    if (snapshotId > player.lastAckedSnapshot) player.lastAckedSnapshot = snapshotId;
  }

  reset(): void {
    this.history.clear();
    this.nextId = 1;
    for (const player of this.match.players.values()) player.lastAckedSnapshot = -1;
  }
}

export { INTERPOLATION_DELAY_MS, MatchPhase, TeamId, reloadProgress };
