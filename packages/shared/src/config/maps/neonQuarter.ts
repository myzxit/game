/**
 * NEON QUARTER — original map, a rain-soaked market district at night.
 *
 * Design intent
 * -------------
 *  - Deliberately the tonal opposite of Foundry Reach: tighter, wetter, lit by
 *    signage rather than sun, so the two maps feel like different games.
 *  - A central plaza (mid, contested, exposed) ringed by shop interiors that
 *    give safe rotations — the risk/reward axis here is "cross the plaza or
 *    take the slow shop route".
 *  - An elevated walkway loops the plaza at 6m, giving high ground that is
 *    itself overlooked by two rooftop positions, so nothing is uncontestable.
 *  - A flooded service alley on the east side is the flank; the water makes
 *    footsteps loud, which is the intended counterplay.
 */

import { vec3 } from '../../core/math.js';
import { SurfaceMaterial, TeamId } from '../../types/domain.js';
import { MapBuilder } from './builder.js';
import { ZoneTag, type LightDefinition, type MapDefinition, type SpawnPoint } from './mapTypes.js';

const b = new MapBuilder();

// ---------------------------------------------------------------- Streets --
b.ground(vec3(0, 0, 0), 110, 96, SurfaceMaterial.Asphalt, 2, 'wet_asphalt');
// Raised pavements around the plaza — half a step of cover and a footstep change.
b.ground(vec3(0, 0.16, -30), 70, 5, SurfaceMaterial.Concrete, 0.32, 'pavement');
b.ground(vec3(0, 0.16, 30), 70, 5, SurfaceMaterial.Concrete, 0.32, 'pavement');
b.ground(vec3(-34, 0.16, 0), 5, 60, SurfaceMaterial.Concrete, 0.32, 'pavement');
b.ground(vec3(34, 0.16, 0), 5, 60, SurfaceMaterial.Concrete, 0.32, 'pavement');
// Puddles.
for (let i = 0; i < 14; i++) {
  const seed = i * 37;
  b.ground(
    vec3(-40 + ((seed * 13) % 80), 0.03, -38 + ((seed * 29) % 76)),
    2.5 + ((seed * 7) % 30) / 10,
    2.0 + ((seed * 11) % 25) / 10,
    SurfaceMaterial.Water,
    0.06,
    'puddle',
  );
}

const WALL_H = 18;
b.wall(vec3(-55, 0, -48), vec3(55, 0, -48), WALL_H, 1.5, SurfaceMaterial.Concrete, { style: 'block_wall' });
b.wall(vec3(-55, 0, 48), vec3(55, 0, 48), WALL_H, 1.5, SurfaceMaterial.Concrete, { style: 'block_wall' });
b.wall(vec3(-55, 0, -48), vec3(-55, 0, 48), WALL_H, 1.5, SurfaceMaterial.Concrete, { style: 'block_wall' });
b.wall(vec3(55, 0, -48), vec3(55, 0, 48), WALL_H, 1.5, SurfaceMaterial.Concrete, { style: 'block_wall' });

// ---------------------------------------------------- Shop blocks (ring) --
interface Shop {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  doors: Partial<Record<'n' | 's' | 'e' | 'w', number>>;
  windows: Partial<Record<'n' | 's' | 'e' | 'w', [number, number]>>;
  sign: number;
  kinds: string[];
}

const shops: Shop[] = [
  { x: -50, z: -44, w: 20, d: 18, h: 6, doors: { e: 0.5, s: 0.6 }, windows: { s: [1.2, 3.2] }, sign: 0xff3d7a, kinds: ['shelf_unit', 'counter', 'crate_small', 'sign_board'] },
  { x: -50, z: 26, w: 20, d: 18, h: 6, doors: { e: 0.5, n: 0.4 }, windows: { n: [1.2, 3.2] }, sign: 0x2ae0ff, kinds: ['shelf_unit', 'counter', 'barrel', 'sign_board'] },
  { x: 30, z: -44, w: 20, d: 18, h: 6, doors: { w: 0.5, s: 0.4 }, windows: { s: [1.2, 3.2] }, sign: 0xffd23d, kinds: ['table', 'stool', 'counter', 'crate_small'] },
  { x: 30, z: 26, w: 20, d: 18, h: 6, doors: { w: 0.5, n: 0.6 }, windows: { n: [1.2, 3.2] }, sign: 0x8a5cff, kinds: ['table', 'stool', 'shelf_unit', 'crate_small'] },
  { x: -14, z: -46, w: 28, d: 14, h: 7, doors: { s: 0.5 }, windows: { s: [1.4, 3.6] }, sign: 0x4ec97a, kinds: ['counter', 'shelf_unit', 'locker'] },
  { x: -14, z: 32, w: 28, d: 14, h: 7, doors: { n: 0.5 }, windows: { n: [1.4, 3.6] }, sign: 0xff8a3d, kinds: ['counter', 'shelf_unit', 'locker'] },
];

let shopSeed = 5000;
for (const s of shops) {
  b.room(vec3(s.x, 0, s.z), s.w, s.d, s.h, {
    material: SurfaceMaterial.Brick,
    floorMaterial: SurfaceMaterial.Concrete,
    doors: s.doors,
    windows: s.windows,
    style: 'shop',
  });
  b.dressRoom(vec3(s.x, 0, s.z), s.w, s.d, shopSeed++, s.kinds);
  // Storefront neon and an awning.
  b.sign(vec3(s.x + s.w / 2, s.h - 1.2, s.z + s.d + 0.3), vec3(s.w * 0.6, 1.1, 0.2), s.sign);
  b.box(vec3(s.x + s.w / 2, s.h - 2.6, s.z + s.d + 0.9), vec3(s.w * 0.8, 0.16, 1.8), SurfaceMaterial.Fabric, {
    style: 'awning',
    playerPassthrough: true,
    penetration: 0.15,
    detailOnly: true,
  });
  // Roof access clutter.
  b.box(vec3(s.x + s.w / 2, s.h + 0.3, s.z + s.d / 2), vec3(s.w, 0.5, s.d), SurfaceMaterial.Concrete, { style: 'roof' });
  b.prop('vent', vec3(s.x + 3, s.h + 0.6, s.z + 3), 0, 1, 1);
  b.prop('ac_unit', vec3(s.x + s.w - 4, s.h + 0.6, s.z + s.d - 4), 0, 1, 1);
}

// -------------------------------------------------- Central plaza (mid) --
// A sunken plaza: crossing it means giving up high ground, which is the point.
b.ground(vec3(0, -1.2, 0), 34, 30, SurfaceMaterial.Concrete, 1.0, 'plaza');
b.stairs(vec3(0, 0, -15), 'z', -1.2, 3, 12, SurfaceMaterial.Concrete);
b.stairs(vec3(0, 0, 15), '-z', -1.2, 3, 12, SurfaceMaterial.Concrete);
b.stairs(vec3(-17, 0, 0), 'x', -1.2, 3, 10, SurfaceMaterial.Concrete);
b.stairs(vec3(17, 0, 0), '-x', -1.2, 3, 10, SurfaceMaterial.Concrete);

// Market stalls: soft cover you can shoot through, so the plaza is survivable.
for (let i = 0; i < 8; i++) {
  const ang = (i / 8) * Math.PI * 2;
  const x = Math.cos(ang) * 10;
  const z = Math.sin(ang) * 8;
  b.box(vec3(x, -0.5, z), vec3(2.6, 1.4, 2.2), SurfaceMaterial.Wood, { style: 'stall' });
  b.box(vec3(x, 1.0, z), vec3(3.2, 0.14, 2.8), SurfaceMaterial.Fabric, {
    style: 'stall_canopy',
    penetration: 0.15,
    bulletPassthrough: false,
    detailOnly: true,
    color: [0xff3d7a, 0x2ae0ff, 0xffd23d, 0x4ec97a][i % 4],
  });
  b.prop('lantern', vec3(x, 1.4, z), ang, 1, 1, 0xffb45c);
}
// Central fountain — the map's landmark and hard cover in the middle.
b.box(vec3(0, -0.6, 0), vec3(6, 1.2, 6), SurfaceMaterial.Concrete, { style: 'fountain' });
b.box(vec3(0, 0.3, 0), vec3(2.2, 2.6, 2.2), SurfaceMaterial.Metal, { style: 'fountain_column' });
b.ground(vec3(0, 0.05, 0), 5.4, 5.4, SurfaceMaterial.Water, 0.08, 'water');

// ------------------------------------------- Elevated walkway (high ground) --
const WALK_Y = 6.2;
b.catwalk(vec3(-24, WALK_Y, -20), vec3(24, WALK_Y, -20), 3.0, SurfaceMaterial.Metal);
b.catwalk(vec3(-24, WALK_Y, 20), vec3(24, WALK_Y, 20), 3.0, SurfaceMaterial.Metal);
b.catwalk(vec3(-24, WALK_Y, -20), vec3(-24, WALK_Y, 20), 3.0, SurfaceMaterial.Metal);
b.catwalk(vec3(24, WALK_Y, -20), vec3(24, WALK_Y, 20), 3.0, SurfaceMaterial.Metal);
b.stairs(vec3(-24, 0, -26), 'z', WALK_Y, 7, 2.6);
b.stairs(vec3(24, 0, 26), '-z', WALK_Y, 7, 2.6);
// Support columns double as cover on the walkway.
for (const [cx, cz] of [[-24, -20], [24, -20], [-24, 20], [24, 20], [0, -20], [0, 20]] as const) {
  b.box(vec3(cx, WALK_Y / 2, cz), vec3(0.8, WALK_Y, 0.8), SurfaceMaterial.Metal, { style: 'column' });
}

// ------------------------------------------- Flooded service alley (flank) --
b.ground(vec3(46, -0.4, 0), 12, 70, SurfaceMaterial.Water, 0.5, 'flood');
b.wall(vec3(40, 0, -36), vec3(40, 0, 36), 9, 0.6, SurfaceMaterial.Brick, { style: 'alley' });
b.wall(vec3(52, 0, -36), vec3(52, 0, 36), 9, 0.6, SurfaceMaterial.Brick, { style: 'alley' });
for (let i = 0; i < 8; i++) {
  b.box(vec3(46, 0.6, -30 + i * 9), vec3(2.0, 1.2, 1.6), SurfaceMaterial.Metal, { style: 'dumpster' });
  b.conduit(vec3(40.4, 5.5, -32 + i * 9), vec3(40.4, 5.5, -26 + i * 9), 0.18, 'pipe', 0x4a5560);
  b.conduit(vec3(40, 7.4, -32 + i * 9), vec3(52, 7.4, -26 + i * 9), 0.1, 'cable', 0x1c1c20);
}
// Fire escapes let you leave the alley upward instead of only at the ends.
b.stairs(vec3(41, 0, -20), 'z', 6.5, 8, 1.6);
b.stairs(vec3(51, 0, 12), '-z', 6.5, 8, 1.6);

// ----------------------------------------------------------- Secret room --
// Behind a breakable shutter at the back of the flooded alley.
b.room(vec3(56, 0, -8), 8, 10, 3.2, {
  material: SurfaceMaterial.Concrete,
  doors: { w: 0.5 },
  style: 'secret',
});
b.box(vec3(52, 1.6, -3), vec3(0.25, 3.2, 2.6), SurfaceMaterial.Glass, {
  breakable: true,
  penetration: 0.12,
  style: 'shutter',
});
b.prop('cache_terminal', vec3(59, 0, -4), -Math.PI / 2, 1.2, 0);

// ----------------------------------------------------- Objective markers --
b.box(vec3(0, -1.14, 0), vec3(9, 0.12, 9), SurfaceMaterial.Metal, { noCollision: true, style: 'objective_pad', color: 0xf0a02a });
b.box(vec3(-40, 0.1, -8), vec3(8, 0.12, 8), SurfaceMaterial.Metal, { noCollision: true, style: 'objective_pad', color: 0x3f8ce8 });
b.box(vec3(40, 0.1, 8), vec3(8, 0.12, 8), SurfaceMaterial.Metal, { noCollision: true, style: 'objective_pad', color: 0xf0426e });

// --------------------------------------------------------- Street dressing --
for (let i = 0; i < 12; i++) {
  const z = -42 + i * 7.6;
  b.box(vec3(-36, 3.2, z), vec3(0.22, 6.4, 0.22), SurfaceMaterial.Metal, { style: 'lamppost', detailOnly: true });
  b.prop('lamp_head', vec3(-36, 6.6, z), 0, 1, 1, 0xffc98a);
  b.box(vec3(36, 3.2, z), vec3(0.22, 6.4, 0.22), SurfaceMaterial.Metal, { style: 'lamppost', detailOnly: true });
  b.prop('lamp_head', vec3(36, 6.6, z), 0, 1, 1, 0xffc98a);
}
for (let i = 0; i < 10; i++) {
  b.prop('planter', vec3(-30 + i * 6.5, 0.2, -28), 0, 1, 1);
  b.prop('planter', vec3(-30 + i * 6.5, 0.2, 28), 0, 1, 1);
}
b.sign(vec3(-20, 12, -46), vec3(14, 3.2, 0.3), 0xff3d7a);
b.sign(vec3(22, 14, 46), vec3(11, 4.0, 0.3), 0x2ae0ff);
b.sign(vec3(-46, 10, 10), vec3(0.3, 6.0, 9), 0x8a5cff);

// ----------------------------------------------------------------- Lights --
const lights: LightDefinition[] = [
  { kind: 'point', at: vec3(0, 4.5, 0), color: 0xffc98a, intensity: 2.0, distance: 30, shadows: true },
  { kind: 'point', at: vec3(-20, 9, -44), color: 0xff3d7a, intensity: 2.4, distance: 28, shadows: false },
  { kind: 'point', at: vec3(22, 10, 44), color: 0x2ae0ff, intensity: 2.4, distance: 28, shadows: false },
  { kind: 'point', at: vec3(-44, 8, 10), color: 0x8a5cff, intensity: 1.8, distance: 24, shadows: false },
  { kind: 'point', at: vec3(46, 3, 0), color: 0x6ad0c0, intensity: 1.2, distance: 26, shadows: false },
  { kind: 'point', at: vec3(58, 2, -4), color: 0x4ec97a, intensity: 0.7, distance: 9, shadows: false, detailOnly: true },
  ...shops.map((s, i): LightDefinition => ({
    kind: 'point',
    at: vec3(s.x + s.w / 2, s.h - 1.4, s.z + s.d + 0.6),
    color: s.sign,
    intensity: 1.7,
    distance: 18,
    shadows: false,
    detailOnly: i % 2 === 1,
  })),
  ...shops.map((s): LightDefinition => ({
    kind: 'point',
    at: vec3(s.x + s.w / 2, s.h - 1.6, s.z + s.d / 2),
    color: 0xdfe4ee,
    intensity: 1.0,
    distance: 15,
    shadows: false,
  })),
];

const spawns: SpawnPoint[] = [
  ...[-8, -4, 0, 4, 8].map((x, i): SpawnPoint => ({
    at: vec3(x, 0.3, -40),
    yaw: 0,
    team: TeamId.Alpha,
    priority: i === 2 ? 2 : 1,
    tags: [ZoneTag.Spawn, ZoneTag.Interior],
  })),
  ...[-8, -4, 0, 4, 8].map((x, i): SpawnPoint => ({
    at: vec3(x, 0.3, 40),
    yaw: Math.PI,
    team: TeamId.Bravo,
    priority: i === 2 ? 2 : 1,
    tags: [ZoneTag.Spawn, ZoneTag.Interior],
  })),
  { at: vec3(-42, 0.3, -36), yaw: Math.PI / 4, team: TeamId.None, priority: 1, tags: [ZoneTag.Interior, ZoneTag.CloseRange] },
  { at: vec3(-42, 0.3, 34), yaw: -Math.PI / 4, team: TeamId.None, priority: 1, tags: [ZoneTag.Interior, ZoneTag.CloseRange] },
  { at: vec3(38, 0.3, -36), yaw: -Math.PI / 4, team: TeamId.None, priority: 1, tags: [ZoneTag.Interior, ZoneTag.CloseRange] },
  { at: vec3(38, 0.3, 34), yaw: Math.PI / 4, team: TeamId.None, priority: 1, tags: [ZoneTag.Interior, ZoneTag.CloseRange] },
  { at: vec3(-24, 6.9, 0), yaw: Math.PI / 2, team: TeamId.None, priority: 0, tags: [ZoneTag.HighGround, ZoneTag.Strategic] },
  { at: vec3(46, 0.3, -28), yaw: Math.PI, team: TeamId.None, priority: 0, tags: [ZoneTag.FlankRoute] },
];

export const NEON_QUARTER: MapDefinition = {
  id: 'neon_quarter',
  nameKey: 'map.neon_quarter.name',
  descriptionKey: 'map.neon_quarter.desc',
  bounds: { min: vec3(-55, -6, -48), max: vec3(62, 34, 48) },
  supportedModes: ['tdm', 'ffa', 'objective', 'elimination', 'ranked'],
  recommendedPlayers: [4, 10],
  themeColor: 0xff3d7a,

  volumes: b.volumes,
  props: b.props,
  spawns,
  lights,

  objectives: [
    { id: 'plaza', nameKey: 'map.neon_quarter.obj.plaza', at: vec3(0, -1.2, 0), radius: 6.0, height: 5 },
    { id: 'west_row', nameKey: 'map.neon_quarter.obj.west_row', at: vec3(-40, 0, -8), radius: 5.0, height: 4 },
    { id: 'east_row', nameKey: 'map.neon_quarter.obj.east_row', at: vec3(40, 0, 8), radius: 5.0, height: 4 },
  ],

  zones: [
    { id: 'plaza', min: vec3(-18, -3, -16), max: vec3(18, 5, 16), tags: [ZoneTag.MidRange, ZoneTag.Exterior, ZoneTag.LowGround, ZoneTag.Objective], nameKey: 'map.zone.plaza' },
    { id: 'walkway', min: vec3(-27, 5, -23), max: vec3(27, 10, 23), tags: [ZoneTag.HighGround, ZoneTag.Strategic, ZoneTag.MainRoute], nameKey: 'map.zone.walkway' },
    { id: 'shops_west', min: vec3(-55, -1, -48), max: vec3(-28, 8, 48), tags: [ZoneTag.CloseRange, ZoneTag.Interior, ZoneTag.SideRoute], nameKey: 'map.zone.shops_west' },
    { id: 'shops_east', min: vec3(28, -1, -48), max: vec3(40, 8, 48), tags: [ZoneTag.CloseRange, ZoneTag.Interior, ZoneTag.SideRoute], nameKey: 'map.zone.shops_east' },
    { id: 'alley', min: vec3(40, -2, -38), max: vec3(53, 9, 38), tags: [ZoneTag.FlankRoute, ZoneTag.CloseRange, ZoneTag.Exterior], nameKey: 'map.zone.alley' },
    { id: 'rooftops', min: vec3(-55, 6, -48), max: vec3(55, 14, 48), tags: [ZoneTag.Rooftop, ZoneTag.HighGround, ZoneTag.Parkour], nameKey: 'map.zone.rooftops' },
    { id: 'backroom', min: vec3(52, -1, -14), max: vec3(64, 4, -2), tags: [ZoneTag.Secret, ZoneTag.Interior], nameKey: 'map.zone.backroom' },
  ],

  backdrop: [
    { kind: 'city', distance: 300, count: 46, minHeight: 40, maxHeight: 180, color: 0x1c2436, seed: 8001 },
    { kind: 'towers', distance: 190, count: 16, minHeight: 50, maxHeight: 130, color: 0x232c40, seed: 8002 },
    { kind: 'antennas', distance: 165, count: 22, minHeight: 10, maxHeight: 26, color: 0x161c28, seed: 8003 },
    { kind: 'road', distance: 140, count: 1, minHeight: 0, maxHeight: 0, color: 0x14171c, seed: 8004 },
  ],

  environment: {
    timeOfDay: 22.5,
    sunColor: 0x36507a,
    sunIntensity: 0.28, // moonlight
    ambientColor: 0x2a3550,
    ambientIntensity: 0.42,
    skyTopColor: 0x080b16,
    skyBottomColor: 0x2a2140,
    fogColor: 0x1b2136,
    fogNear: 30,
    fogFar: 190,
    rain: 0.65,
    haze: 0.55,
    windDirection: 2.2,
    windStrength: 0.5,
    ambienceKeys: ['amb.rain_medium', 'amb.city_night', 'amb.neon_hum', 'amb.distant_traffic'],
  },

  secrets: [
    { id: 'shutter', kind: 'zone', at: vec3(52, 1.6, -3), radius: 2.2, unlocksId: 'secret_quarter_backroom' },
    { id: 'backroom_terminal', kind: 'button', at: vec3(59, 0, -4), radius: 1.8, unlocksId: 'secret_quarter_backroom' },
  ],

  npcSpawns: [],
  vehicleSpawns: [{ vehicleId: 'scout_buggy', at: vec3(-44, 0.4, 44), yaw: Math.PI }],
};
