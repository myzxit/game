/**
 * Vehicles.
 *
 * Deliberately limited: a fast, fragile scout buggy that trades protection for
 * rotation speed. A vehicle that could win fights outright would break the
 * infantry game, so ramming damage is capped and the buggy has no weapon.
 */

import { Rarity } from '../types/domain.js';

export interface VehicleDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  rarity: Rarity;
  seats: number;

  maxSpeed: number;
  reverseSpeed: number;
  acceleration: number;
  brakeForce: number;
  /** Radians per second at full lock; scaled down at speed. */
  steerRate: number;
  /** How much steering authority is lost at max speed (0..1). */
  steerSpeedFalloff: number;
  grip: number;
  mass: number;

  health: number;
  /** Damage taken per m/s of impact speed above the threshold. */
  collisionDamageScale: number;
  collisionDamageThreshold: number;
  /** Damage dealt to a player struck at speed; capped so it can't be a free kill... */
  ramDamageScale: number;
  ramDamageMax: number;

  /** Seconds after destruction before it respawns at its pad. */
  respawnSec: number;
  /** Occupants take this fraction of incoming bullet damage. */
  occupantDamageScale: number;

  /** Collision box half-extents. */
  size: { x: number; y: number; z: number };
  modelKey: string;
  engineSfxKey: string;
  unlockLevel: number;
  price: number;
  balanceNote: string;
}

export const VEHICLES: readonly VehicleDefinition[] = [
  {
    id: 'scout_buggy',
    nameKey: 'vehicle.scout_buggy.name',
    descriptionKey: 'vehicle.scout_buggy.desc',
    rarity: Rarity.Common,
    seats: 2,

    maxSpeed: 24,
    reverseSpeed: 8,
    acceleration: 14,
    brakeForce: 22,
    steerRate: 2.3,
    steerSpeedFalloff: 0.55,
    grip: 8.5,
    mass: 900,

    health: 420,
    collisionDamageScale: 4.5,
    collisionDamageThreshold: 8,
    // ...ramming a player deals real damage but never one-shots a full-health target.
    ramDamageScale: 3.4,
    ramDamageMax: 70,

    respawnSec: 35,
    // Riding is a real risk: you are easier to hit and barely protected.
    occupantDamageScale: 0.85,

    size: { x: 1.1, y: 0.75, z: 2.1 },
    modelKey: 'model.vehicle.scout_buggy',
    engineSfxKey: 'sfx.vehicle.buggy_engine',
    unlockLevel: 1,
    price: 0,
    balanceNote:
      'Rotates the map fast; almost no protection and no weapon. Loud engine announces it long before it arrives.',
  },
];

const BY_ID = new Map(VEHICLES.map((v) => [v.id, v]));
export const getVehicle = (id: string): VehicleDefinition | undefined => BY_ID.get(id);
