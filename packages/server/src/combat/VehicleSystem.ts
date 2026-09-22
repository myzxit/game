/**
 * Vehicles.
 *
 * A simple arcade driving model: throttle and steering with grip-limited
 * lateral velocity, swept against the same collision world players use. The
 * vehicle carries its occupants' positions, so riding is genuinely dangerous —
 * you are a larger, louder, less agile target.
 */

import {
  type VehicleSnapshot,
  DamageType,
  HitZone,
  ServerMessageType,
  SurfaceMaterial,
  clamp,
  createLogger,
  getVehicle,
  v3add,
  v3dist,
  v3scale,
  vec3,
  yawToForward,
  type MapDefinition,
  type VehicleDefinition,
  type Vec3,
} from '@titan/shared';
import type { MatchInstance } from '../match/MatchInstance.js';
import type { PlayerEntity } from '../match/PlayerEntity.js';
import { MatchEventType } from '../match/MatchEvents.js';

const log = createLogger('Vehicles');

export interface VehicleInstance {
  id: number;
  defId: string;
  def: VehicleDefinition;
  position: Vec3;
  /** Spawn pad, for respawning after destruction. */
  homePosition: Vec3;
  homeYaw: number;
  yaw: number;
  /** Forward speed in m/s; negative is reverse. */
  speed: number;
  velocityY: number;
  health: number;
  driverId: string | null;
  passengerIds: string[];
  destroyed: boolean;
  respawnInMs: number;
  /** Latest input from the driver. */
  throttle: number;
  steer: number;
  brake: boolean;
  grounded: boolean;
}

/** Distance within which a player may board. */
const BOARD_RANGE = 3.2;

/**
 * Half-width of the axis-aligned box a vehicle collides with.
 *
 * The collision world is AABB-only, so a rotated buggy has to be approximated
 * by a square. Using the *longer* half-extent made that square 4.2m across,
 * wider than the buggy by a metre each side: it overlapped the crates beside
 * its pad every tick, and every tick's "wall hit" cut its speed by 75%. The
 * result was a vehicle that crawled at 0.07 m/s under full throttle. The mean
 * of the two extents keeps the box honest about width without letting the
 * nose sink a full metre into walls.
 */
export function vehicleFootprint(def: VehicleDefinition): number {
  return (def.size.x + def.size.z) / 2;
}

export class VehicleSystem {
  private readonly vehicles = new Map<number, VehicleInstance>();
  private nextId = 1;

  constructor(private readonly match: MatchInstance) {}

  spawnFromMap(map: MapDefinition): void {
    for (const spawn of map.vehicleSpawns) {
      const def = getVehicle(spawn.vehicleId);
      if (!def) {
        log.warn('map references unknown vehicle', { vehicleId: spawn.vehicleId });
        continue;
      }
      const id = this.nextId++;
      this.vehicles.set(id, {
        id,
        defId: def.id,
        def,
        position: { ...spawn.at },
        homePosition: { ...spawn.at },
        homeYaw: spawn.yaw,
        yaw: spawn.yaw,
        speed: 0,
        velocityY: 0,
        health: def.health,
        driverId: null,
        passengerIds: [],
        destroyed: false,
        respawnInMs: 0,
        throttle: 0,
        steer: 0,
        brake: false,
        grounded: false,
      });
    }
  }

  get all(): VehicleInstance[] {
    return Array.from(this.vehicles.values());
  }

  get(id: number): VehicleInstance | null {
    return this.vehicles.get(id) ?? null;
  }

  /** Attempt to board. Returns the vehicle on success. */
  enter(player: PlayerEntity, vehicleId: number): VehicleInstance | null {
    if (!player.alive || player.vehicleId !== null) return null;
    const vehicle = this.vehicles.get(vehicleId);
    if (!vehicle || vehicle.destroyed) return null;
    if (v3dist(player.position, vehicle.position) > BOARD_RANGE) return null;

    const occupants = (vehicle.driverId ? 1 : 0) + vehicle.passengerIds.length;
    if (occupants >= vehicle.def.seats) return null;

    if (!vehicle.driverId) vehicle.driverId = player.id;
    else vehicle.passengerIds.push(player.id);

    player.vehicleId = vehicleId;
    this.match.recorder.record({
      type: MatchEventType.VehicleEnter,
      at: this.match.elapsedMs,
      tick: this.match.tick,
      playerId: player.id,
      vehicleId,
    });
    return vehicle;
  }

  /** Leave the vehicle, placing the player beside it. */
  exit(player: PlayerEntity): void {
    if (player.vehicleId === null) return;
    const vehicle = this.vehicles.get(player.vehicleId);
    player.vehicleId = null;
    if (!vehicle) return;

    if (vehicle.driverId === player.id) {
      // Promote a passenger so an abandoned vehicle isn't stuck with riders.
      vehicle.driverId = vehicle.passengerIds.shift() ?? null;
      vehicle.throttle = 0;
      vehicle.steer = 0;
    } else {
      vehicle.passengerIds = vehicle.passengerIds.filter((id) => id !== player.id);
    }

    // Step out to the side, and only somewhere the player actually fits.
    const side = vec3(Math.cos(vehicle.yaw), 0, -Math.sin(vehicle.yaw));
    for (const offset of [2.0, -2.0, 3.0, -3.0]) {
      const candidate = v3add(vehicle.position, v3scale(side, offset));
      const min = vec3(candidate.x - 0.45, candidate.y + 0.1, candidate.z - 0.45);
      const max = vec3(candidate.x + 0.45, candidate.y + 1.85, candidate.z + 0.45);
      if (!this.match.world.overlapsAny(min, max)) {
        player.movement.position = candidate;
        player.movement.velocity = vec3(0, 0, 0);
        return;
      }
    }
    // Nowhere clear: drop them on the vehicle itself rather than inside a wall.
    player.movement.position = { ...vehicle.position };
  }

  setInput(playerId: string, throttle: number, steer: number, brake: boolean): void {
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.driverId !== playerId) continue;
      vehicle.throttle = clamp(throttle, -1, 1);
      vehicle.steer = clamp(steer, -1, 1);
      vehicle.brake = brake;
      return;
    }
  }

  step(dtMs: number, now: number): void {
    const dt = dtMs / 1000;

    for (const vehicle of this.vehicles.values()) {
      if (vehicle.destroyed) {
        vehicle.respawnInMs -= dtMs;
        if (vehicle.respawnInMs <= 0) this.respawn(vehicle);
        continue;
      }

      this.driveVehicle(vehicle, dt, now);
      this.syncOccupants(vehicle);
    }
  }

  private driveVehicle(vehicle: VehicleInstance, dt: number, now: number): void {
    const def = vehicle.def;

    // Longitudinal motion.
    if (vehicle.brake) {
      vehicle.speed -= Math.sign(vehicle.speed) * Math.min(Math.abs(vehicle.speed), def.brakeForce * dt);
    } else if (vehicle.throttle !== 0) {
      const target = vehicle.throttle > 0 ? def.maxSpeed : -def.reverseSpeed;
      const accel = def.acceleration * Math.abs(vehicle.throttle) * dt;
      vehicle.speed = vehicle.speed < target
        ? Math.min(target, vehicle.speed + accel)
        : Math.max(target, vehicle.speed - accel);
    } else {
      // Engine braking / rolling resistance.
      const drag = def.acceleration * 0.4 * dt;
      vehicle.speed -= Math.sign(vehicle.speed) * Math.min(Math.abs(vehicle.speed), drag);
    }

    // Steering authority falls off with speed, so a buggy at full tilt cannot
    // turn on a coin.
    const speedRatio = clamp(Math.abs(vehicle.speed) / def.maxSpeed, 0, 1);
    const steerScale = 1 - def.steerSpeedFalloff * speedRatio;
    // Only steer when actually moving — a stationary car should not spin.
    if (Math.abs(vehicle.speed) > 0.4) {
      vehicle.yaw += vehicle.steer * def.steerRate * steerScale * dt * Math.sign(vehicle.speed);
    }

    // Gravity and ground.
    vehicle.velocityY -= 22 * dt;

    const forward = yawToForward(vehicle.yaw);
    const velocity = vec3(forward.x * vehicle.speed, vehicle.velocityY, forward.z * vehicle.speed);

    const before = { ...vehicle.position };
    const move = this.match.world.moveBox(
      vehicle.position,
      velocity,
      dt,
      vehicleFootprint(def),
      def.size.y * 2,
      0.45,
    );

    vehicle.position = move.position;
    vehicle.grounded = move.grounded;
    vehicle.velocityY = move.velocity.y;

    // Hitting something scrubs speed and damages the vehicle.
    if (move.hitWall) {
      const impactSpeed = Math.abs(vehicle.speed);
      vehicle.speed *= 0.25;
      if (impactSpeed > def.collisionDamageThreshold) {
        const damage = (impactSpeed - def.collisionDamageThreshold) * def.collisionDamageScale;
        this.damage(vehicle, damage, null, now);
      }
    }

    if (move.landingSpeed > def.collisionDamageThreshold) {
      this.damage(
        vehicle,
        (move.landingSpeed - def.collisionDamageThreshold) * def.collisionDamageScale,
        null,
        now,
      );
    }

    // Ramming.
    if (Math.abs(vehicle.speed) > 6) {
      for (const player of this.match.players.values()) {
        if (!player.alive || player.vehicleId !== null) continue;
        if (v3dist(player.position, vehicle.position) > Math.max(def.size.x, def.size.z) + 0.8) continue;

        const driver = vehicle.driverId ? this.match.players.get(vehicle.driverId) ?? null : null;
        if (driver && !this.match.canDamage(driver, player)) continue;

        const damage = Math.min(def.ramDamageMax, Math.abs(vehicle.speed) * def.ramDamageScale);
        this.match.applyDamage(
          player,
          driver,
          damage,
          DamageType.Vehicle,
          HitZone.Chest,
          null,
          0,
          now,
        );
        vehicle.speed *= 0.7;
      }
    }

    // Track distance for the driving quest.
    if (vehicle.driverId) {
      const driver = this.match.players.get(vehicle.driverId);
      if (driver) driver.vehicleDistance += v3dist(before, vehicle.position);
    }
  }

  /** Occupants ride along with the vehicle. */
  private syncOccupants(vehicle: VehicleInstance): void {
    const ids = [vehicle.driverId, ...vehicle.passengerIds].filter((id): id is string => id !== null);
    ids.forEach((id, index) => {
      const player = this.match.players.get(id);
      if (!player) return;
      if (!player.alive) {
        this.exit(player);
        return;
      }
      const side = index === 0 ? -0.5 : 0.5;
      const right = vec3(Math.cos(vehicle.yaw), 0, -Math.sin(vehicle.yaw));
      player.movement.position = v3add(
        vec3(vehicle.position.x, vehicle.position.y + 0.9, vehicle.position.z),
        v3scale(right, side),
      );
      player.movement.velocity = vec3(0, 0, 0);
      player.movement.grounded = true;
    });
  }

  /** Bullets that hit a vehicle damage it and partially protect the occupants. */
  damage(vehicle: VehicleInstance, amount: number, attackerId: string | null, now: number): void {
    if (vehicle.destroyed || amount <= 0) return;
    vehicle.health -= amount;
    if (vehicle.health > 0) return;

    vehicle.destroyed = true;
    vehicle.respawnInMs = vehicle.def.respawnSec * 1000;
    vehicle.speed = 0;

    // Everyone aboard is thrown clear and takes the destruction damage.
    const occupants = [vehicle.driverId, ...vehicle.passengerIds].filter(
      (id): id is string => id !== null,
    );
    vehicle.driverId = null;
    vehicle.passengerIds = [];

    for (const id of occupants) {
      const player = this.match.players.get(id);
      if (!player) continue;
      player.vehicleId = null;
      const attacker = attackerId ? this.match.players.get(attackerId) ?? null : null;
      this.match.applyDamage(player, attacker, 45, DamageType.Explosive, HitZone.Chest, null, 0, now);
    }

    this.match.recorder.record({
      type: MatchEventType.VehicleDestroy,
      at: this.match.elapsedMs,
      tick: this.match.tick,
      vehicleId: vehicle.id,
      killerId: attackerId,
    });

    this.match.broadcast({
      type: ServerMessageType.CombatEvent,
      event: {
        kind: 'impact',
        at: [vehicle.position.x, vehicle.position.y, vehicle.position.z],
        normal: [0, 1, 0],
        material: SurfaceMaterial.Metal,
      },
    });
  }

  private respawn(vehicle: VehicleInstance): void {
    vehicle.position = { ...vehicle.homePosition };
    vehicle.yaw = vehicle.homeYaw;
    vehicle.speed = 0;
    vehicle.velocityY = 0;
    vehicle.health = vehicle.def.health;
    vehicle.destroyed = false;
    vehicle.respawnInMs = 0;
  }

  reset(): void {
    for (const vehicle of this.vehicles.values()) {
      for (const id of [vehicle.driverId, ...vehicle.passengerIds]) {
        if (!id) continue;
        const player = this.match.players.get(id);
        if (player) player.vehicleId = null;
      }
      vehicle.driverId = null;
      vehicle.passengerIds = [];
      this.respawn(vehicle);
    }
  }

  /** Authoritative state for the snapshot's `vehicles` list. */
  snapshot(): VehicleSnapshot[] {
    return this.all.map((v) => ({
      id: v.id,
      defId: v.defId,
      pos: [v.position.x, v.position.y, v.position.z] as [number, number, number],
      yaw: v.yaw,
      speed: v.speed,
      health: Math.max(0, Math.round(v.health)),
      driverId: v.driverId,
      passengerIds: v.passengerIds.slice(),
      destroyed: v.destroyed,
    }));
  }
}
