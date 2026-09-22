/**
 * Client-side prediction and reconciliation.
 *
 * The player's own movement is simulated locally the instant they press a key,
 * so the game feels responsive regardless of latency. The server then tells us
 * where it thinks they are as of input N; we compare, and if we mispredicted,
 * we snap to the server's answer and *replay* every input after N.
 *
 * This works only because `stepMovement` and `stepWeapon` in @titan/shared are
 * pure and are the exact same code the server runs. Any divergence between the
 * two would show up here as constant rubber-banding.
 */

import {
  RingBuffer,
  WeaponPhase,
  cloneMovementState,
  createMovementState,
  createWeaponRuntime,
  stepMovement,
  stepWeapon,
  v3dist,
  type LocalPlayerState,
  type MovementProfile,
  type PlayerInput,
  type ResolvedWeapon,
  type MovementStateData,
  type Vec3,
  type WeaponRuntime,
  InputButton,
  createLogger,
} from '@titan/shared';
import type { CollisionWorld } from '@titan/shared';

const log = createLogger('Prediction');

interface HistoryEntry {
  input: PlayerInput;
  /** State *after* applying this input. */
  movement: MovementStateData;
  weapon: WeaponRuntime;
}

/**
 * Distance beyond which we stop smoothing and hard-snap.
 * Small errors are blended away invisibly; a large one means something real
 * happened (a teleport, a skill impulse, a correction) and must be respected
 * immediately.
 */
const SNAP_THRESHOLD = 2.0;
/** Below this, the error is not worth correcting at all. */
const IGNORE_THRESHOLD = 0.01;

export class PredictionSystem {
  private readonly history = new RingBuffer<HistoryEntry>(180);
  private movement: MovementStateData;
  private weapon: WeaponRuntime | null = null;
  private sequence = 0;

  /**
   * Visual offset between the predicted position and the rendered one.
   * Corrections are applied to the simulation immediately but eased away
   * visually, so a small misprediction never produces a visible jolt.
   */
  private readonly smoothing = { x: 0, y: 0, z: 0 };

  /** Diagnostics. */
  lastErrorDistance = 0;
  corrections = 0;
  replayedInputs = 0;

  constructor(spawn: Vec3, yaw: number) {
    this.movement = createMovementState(spawn, yaw);
  }

  reset(spawn: Vec3, yaw: number): void {
    this.movement = createMovementState(spawn, yaw);
    this.history.clear();
    this.smoothing.x = 0;
    this.smoothing.y = 0;
    this.smoothing.z = 0;
  }

  setWeapon(weapon: ResolvedWeapon): void {
    this.weapon = createWeaponRuntime(weapon);
  }

  get state(): MovementStateData {
    return this.movement;
  }

  get weaponRuntime(): WeaponRuntime | null {
    return this.weapon;
  }

  get nextSequence(): number {
    return this.sequence + 1;
  }

  /** Position to render at: the predicted position minus the smoothing offset. */
  renderPosition(): Vec3 {
    return {
      x: this.movement.position.x - this.smoothing.x,
      y: this.movement.position.y - this.smoothing.y,
      z: this.movement.position.z - this.smoothing.z,
    };
  }

  /**
   * Apply one local input: simulate it immediately and record it, so it can be
   * replayed if the server later disagrees.
   */
  applyInput(
    input: PlayerInput,
    world: CollisionWorld,
    profile: MovementProfile,
    weapon: ResolvedWeapon | null,
  ): { shotsFired: number; reloadCompleted: boolean; dryFired: boolean } {
    this.sequence = input.sequence;
    this.movement = stepMovement(this.movement, input, world, profile);

    let result = { shotsFired: 0, reloadCompleted: false, dryFired: false };
    if (this.weapon && weapon) {
      const stepped = stepWeapon(this.weapon, weapon, {
        fire: (input.buttons & InputButton.Fire) !== 0,
        aim: (input.buttons & InputButton.Aim) !== 0,
        reload: (input.buttons & InputButton.Reload) !== 0,
        deltaMs: input.deltaMs,
      });
      this.weapon = stepped.runtime;
      result = {
        shotsFired: stepped.shotsFired,
        reloadCompleted: stepped.reloadCompleted,
        dryFired: stepped.dryFired,
      };
    }

    this.history.push({
      input,
      movement: cloneMovementState(this.movement),
      weapon: this.weapon ? { ...this.weapon } : createWeaponRuntime(weapon!),
    });

    return result;
  }

  /**
   * Reconcile against the server's authoritative state.
   *
   * `local.lastProcessedInput` tells us which of our inputs the server had
   * consumed when it produced this state. Everything after that is still
   * "in flight" and must be replayed on top of the server's answer.
   */
  reconcile(
    local: LocalPlayerState,
    world: CollisionWorld,
    profile: MovementProfile,
    weapon: ResolvedWeapon | null,
  ): void {
    const entries = this.history.toArray();
    const acknowledged = entries.find((e) => e.input.sequence === local.lastProcessedInput);

    // Ammo and cooldowns are authoritative — always take the server's numbers,
    // because the client cannot know about a hit that emptied its shield or a
    // reload the server rejected.
    if (this.weapon) {
      this.weapon.ammoInMag = local.ammoInMag;
      this.weapon.reserveAmmo = local.reserveAmmo;
      // Only accept the server's phase when it disagrees about *what* we're
      // doing, not about the exact remaining milliseconds; otherwise the reload
      // bar would stutter every snapshot.
      if (this.weapon.phase !== local.weaponPhase) {
        this.weapon.phase = local.weaponPhase as WeaponPhase;
        this.weapon.phaseTimeMs = local.weaponPhaseTimeMs;
      }
    }

    if (!acknowledged) {
      // We have no record of the acknowledged input — either the history is
      // empty (we just spawned) or we fell far behind. Accept the server's
      // state wholesale.
      this.movement.position = { ...local.position };
      this.movement.velocity = { ...local.velocity };
      this.movement.stamina = local.stamina;
      return;
    }

    const error = v3dist(acknowledged.movement.position, local.position);
    this.lastErrorDistance = error;

    if (error < IGNORE_THRESHOLD) {
      // Prediction was right. Discard the acknowledged history and move on.
      this.trimHistory(local.lastProcessedInput);
      return;
    }

    this.corrections++;

    // Where we currently think we are, so the visual offset can preserve it.
    const before = { ...this.movement.position };

    // Rewind to the server's state and replay everything after it.
    this.movement.position = { ...local.position };
    this.movement.velocity = { ...local.velocity };
    this.movement.stamina = local.stamina;

    const pending = entries.filter((e) => e.input.sequence > local.lastProcessedInput);
    this.replayedInputs = pending.length;

    for (const entry of pending) {
      this.movement = stepMovement(this.movement, entry.input, world, profile);
      // Replaying weapon state too keeps the predicted ammo count consistent
      // with the replayed shots.
      if (this.weapon && weapon) {
        this.weapon = stepWeapon(this.weapon, weapon, {
          fire: (entry.input.buttons & InputButton.Fire) !== 0,
          aim: (entry.input.buttons & InputButton.Aim) !== 0,
          reload: (entry.input.buttons & InputButton.Reload) !== 0,
          deltaMs: entry.input.deltaMs,
        }).runtime;
      }
      entry.movement = cloneMovementState(this.movement);
    }

    if (error > SNAP_THRESHOLD) {
      // Too large to hide: snap, and clear any pending smoothing so the player
      // sees the truth immediately.
      this.smoothing.x = 0;
      this.smoothing.y = 0;
      this.smoothing.z = 0;
      log.debug('hard correction', { error: error.toFixed(2), replayed: pending.length });
    } else {
      // Small error: keep rendering where we were and ease to the corrected
      // position over the next few frames.
      this.smoothing.x = before.x - this.movement.position.x;
      this.smoothing.y = before.y - this.movement.position.y;
      this.smoothing.z = before.z - this.movement.position.z;
    }

    this.trimHistory(local.lastProcessedInput);
  }

  /** Ease the visual correction offset toward zero. */
  updateSmoothing(dt: number): void {
    // ~120ms to settle: fast enough to stay honest, slow enough to be invisible.
    const factor = Math.exp(-18 * dt);
    this.smoothing.x *= factor;
    this.smoothing.y *= factor;
    this.smoothing.z *= factor;

    if (Math.abs(this.smoothing.x) < 0.0005) this.smoothing.x = 0;
    if (Math.abs(this.smoothing.y) < 0.0005) this.smoothing.y = 0;
    if (Math.abs(this.smoothing.z) < 0.0005) this.smoothing.z = 0;
  }

  private trimHistory(upTo: number): void {
    // RingBuffer overwrites oldest automatically, so this only needs to drop
    // entries that are definitively acknowledged.
    const kept = this.history.toArray().filter((e) => e.input.sequence > upTo);
    this.history.clear();
    for (const entry of kept) this.history.push(entry);
  }

  /** Force the predicted state, used on respawn. */
  teleport(position: Vec3, yaw: number): void {
    this.movement = createMovementState(position, yaw);
    this.history.clear();
    this.smoothing.x = 0;
    this.smoothing.y = 0;
    this.smoothing.z = 0;
  }

  stats(): { error: number; corrections: number; replayed: number; pending: number } {
    return {
      error: this.lastErrorDistance,
      corrections: this.corrections,
      replayed: this.replayedInputs,
      pending: this.history.length,
    };
  }
}
