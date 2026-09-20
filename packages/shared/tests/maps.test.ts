/**
 * Map data sanity.
 *
 * These exist because two of the three vehicle pads shipped inside solid
 * geometry — one in a crate stack, one in a building wall — and nothing said
 * so. The vehicle "worked" (it spawned, it could be boarded) but crawled at
 * 0.07 m/s because every tick it was colliding with the brush it spawned in.
 *
 * A map is data, and data gets edited. So the rules a map must satisfy are
 * tests, not a checklist in a design doc.
 */

import { describe, expect, it } from 'vitest';
import {
  CollisionWorld,
  MAPS,
  PLAYER_HEIGHT_STAND,
  PLAYER_RADIUS,
  getVehicle,
  vec3,
  volumesToBrushes,
  yawToForward,
  type MapDefinition,
} from '../src/index.js';

/** Same footprint rule the server drives with; see VehicleSystem. */
const vehicleRadius = (sizeX: number, sizeZ: number): number => (sizeX + sizeZ) / 2;

function worldFor(map: MapDefinition): CollisionWorld {
  return new CollisionWorld(volumesToBrushes(map.volumes));
}

describe.each(MAPS.map((m) => [m.id, m] as const))('map %s', (_id, map) => {
  const world = worldFor(map);

  it('places every vehicle pad on clear ground with room to dismount', () => {
    for (const spawn of map.vehicleSpawns) {
      const def = getVehicle(spawn.vehicleId);
      expect(def, `unknown vehicle ${spawn.vehicleId}`).toBeDefined();
      const r = vehicleRadius(def!.size.x, def!.size.z);
      const h = def!.size.y * 2;
      // A little above the pad, so the ground itself does not count as a hit.
      const y = spawn.at.y + 0.05;
      // 0.6m margin: a player has to be able to stand beside it to board.
      const margin = 0.6;

      const blocked = world.overlapsAny(
        vec3(spawn.at.x - r - margin, y, spawn.at.z - r - margin),
        vec3(spawn.at.x + r + margin, y + h, spawn.at.z + r + margin),
      );
      expect(
        blocked,
        `${spawn.vehicleId} pad at (${spawn.at.x}, ${spawn.at.z}) intersects solid geometry`,
      ).toBe(false);

      // And there is something to stand on — a pad over a pit is just a slower
      // way of losing the vehicle.
      expect(
        world.materialUnder(vec3(spawn.at.x, y, spawn.at.z)),
        `${spawn.vehicleId} pad at (${spawn.at.x}, ${spawn.at.z}) has no ground beneath it`,
      ).toBeTruthy();
    }
  });

  it('gives every vehicle pad a clear run-up in the direction it faces', () => {
    // The pads were clear but faced a wall two metres ahead, so a driver
    // accelerated for a moment and then ground to a crawl against it. A pad
    // must face at least this much open road, checked by sweeping the
    // vehicle's own footprint forward.
    const MIN_RUN_UP = 12;
    for (const spawn of map.vehicleSpawns) {
      const def = getVehicle(spawn.vehicleId)!;
      const r = vehicleRadius(def.size.x, def.size.z);
      const h = def.size.y * 2;
      const forward = yawToForward(spawn.yaw);
      let clear = 0;
      for (let d = 0; d <= MIN_RUN_UP; d += 0.5) {
        const x = spawn.at.x + forward.x * d;
        const z = spawn.at.z + forward.z * d;
        const y = spawn.at.y + 0.1;
        if (world.overlapsAny(vec3(x - r, y, z - r), vec3(x + r, y + h, z + r))) break;
        if (!world.materialUnder(vec3(x, y, z))) break;
        clear = d;
      }
      expect(
        clear,
        `${spawn.vehicleId} pad at (${spawn.at.x}, ${spawn.at.z}) faces only ${clear}m of open road`,
      ).toBeGreaterThanOrEqual(MIN_RUN_UP);
    }
  });

  it('places every player spawn in open space', () => {
    for (const spawn of map.spawns) {
      const y = spawn.at.y + 0.05;
      const blocked = world.overlapsAny(
        vec3(spawn.at.x - PLAYER_RADIUS, y, spawn.at.z - PLAYER_RADIUS),
        vec3(spawn.at.x + PLAYER_RADIUS, y + PLAYER_HEIGHT_STAND, spawn.at.z + PLAYER_RADIUS),
      );
      expect(blocked, `spawn at (${spawn.at.x}, ${spawn.at.z}) is inside geometry`).toBe(false);
      expect(
        world.materialUnder(vec3(spawn.at.x, y, spawn.at.z)),
        `spawn at (${spawn.at.x}, ${spawn.at.z}) has no ground beneath it`,
      ).toBeTruthy();
    }
  });

  it('keeps every spawn and pad inside the map bounds', () => {
    const inside = (p: { x: number; y: number; z: number }): boolean =>
      p.x >= map.bounds.min.x && p.x <= map.bounds.max.x &&
      p.y >= map.bounds.min.y && p.y <= map.bounds.max.y &&
      p.z >= map.bounds.min.z && p.z <= map.bounds.max.z;
    for (const s of map.spawns) expect(inside(s.at), `spawn ${JSON.stringify(s.at)}`).toBe(true);
    for (const v of map.vehicleSpawns) expect(inside(v.at), `pad ${JSON.stringify(v.at)}`).toBe(true);
  });
});
