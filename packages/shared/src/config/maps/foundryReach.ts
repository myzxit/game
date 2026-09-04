/**
 * FOUNDRY REACH — original map, industrial smelting complex at late afternoon.
 *
 * Design intent
 * -------------
 *  - Three lanes with genuinely different engagement ranges:
 *      WEST  : open container yard, long sightlines (sniper lane)
 *      MID   : the foundry hall, two-storey, catwalks above (mid/close, verticality)
 *      EAST  : warehouse interior, tight corners (close range, SMG/shotgun lane)
 *  - An underground maintenance tunnel links the two spawns, giving a slow but
 *    safe flank that costs time — the counterplay to holding mid.
 *  - Rooftop parkour route above the east warehouse rewards movement skill with
 *    high ground over mid, but exposes you to the west lane.
 *  - Cover is placed so that no single position sees more than two lanes.
 *
 * Nothing here is derived from any existing game's layout; the lane structure is
 * a generic FPS design language (three lanes + flank), not a copied map.
 */

import { vec3 } from '../../core/math.js';
import { SurfaceMaterial, TeamId } from '../../types/domain.js';
import { MapBuilder } from './builder.js';
import {
  ZoneTag,
  type MapDefinition,
  type SpawnPoint,
  type LightDefinition,
} from './mapTypes.js';

const b = new MapBuilder();

// ---------------------------------------------------------------- Terrain --
// Main yard slab. The map runs -60..60 on X and -50..50 on Z.
b.ground(vec3(0, 0, 0), 124, 104, SurfaceMaterial.Asphalt, 2, 'asphalt');

// Grass verges along the west edge break up the asphalt and change footsteps.
b.ground(vec3(-52, 0.02, -20), 16, 40, SurfaceMaterial.Grass, 0.2, 'grass');
b.ground(vec3(-52, 0.02, 24), 16, 30, SurfaceMaterial.Grass, 0.2, 'grass');

// Perimeter walls — high enough that they can't be jumped or wall-jumped over.
const WALL_H = 14;
b.wall(vec3(-62, 0, -52), vec3(62, 0, -52), WALL_H, 1.2, SurfaceMaterial.Concrete, { style: 'perimeter' });
b.wall(vec3(-62, 0, 52), vec3(62, 0, 52), WALL_H, 1.2, SurfaceMaterial.Concrete, { style: 'perimeter' });
b.wall(vec3(-62, 0, -52), vec3(-62, 0, 52), WALL_H, 1.2, SurfaceMaterial.Concrete, { style: 'perimeter' });
b.wall(vec3(62, 0, -52), vec3(62, 0, 52), WALL_H, 1.2, SurfaceMaterial.Concrete, { style: 'perimeter' });

// ------------------------------------------------------- Spawn structures --
// Alpha spawn building (north, -Z). Open to the south so you deploy facing mid.
b.room(vec3(-14, 0, -50), 28, 12, 5, {
  material: SurfaceMaterial.Metal,
  floorMaterial: SurfaceMaterial.Concrete,
  doors: { s: 0.5 },
  windows: { n: [2.0, 3.6] },
  style: 'spawn_alpha',
});
b.dressRoom(vec3(-14, 0, -50), 28, 12, 1001, ['crate_small', 'locker', 'barrel', 'toolbench']);

// Bravo spawn building (south, +Z).
b.room(vec3(-14, 0, 38), 28, 12, 5, {
  material: SurfaceMaterial.Metal,
  floorMaterial: SurfaceMaterial.Concrete,
  doors: { n: 0.5 },
  windows: { s: [2.0, 3.6] },
  style: 'spawn_bravo',
});
b.dressRoom(vec3(-14, 0, 38), 28, 12, 1002, ['crate_small', 'locker', 'barrel', 'toolbench']);

// ------------------------------------------------------ WEST — long lane --
// Shipping containers form staggered hard cover down a 90m sightline.
const containerColors = [0xb8452f, 0x2f6bb8, 0x3f8f5a, 0xc8a52f, 0x8a4fb0];
for (let i = 0; i < 9; i++) {
  const z = -42 + i * 10.5;
  const x = -46 + (i % 3) * 5.5;
  const stacked = i % 4 === 0;
  b.box(vec3(x, 1.35, z), vec3(6.1, 2.7, 2.6), SurfaceMaterial.Metal, {
    style: 'container',
    color: containerColors[i % containerColors.length],
  });
  if (stacked) {
    b.box(vec3(x + 1.2, 4.05, z), vec3(6.1, 2.7, 2.6), SurfaceMaterial.Metal, {
      style: 'container',
      color: containerColors[(i + 2) % containerColors.length],
    });
  }
}
// A gantry crane over the yard — visual anchor and a shadow caster.
b.box(vec3(-40, 12, 0), vec3(2.0, 1.6, 70), SurfaceMaterial.Metal, { style: 'gantry' });
b.box(vec3(-52, 6, -18), vec3(1.4, 12, 1.4), SurfaceMaterial.Metal, { style: 'gantry' });
b.box(vec3(-52, 6, 18), vec3(1.4, 12, 1.4), SurfaceMaterial.Metal, { style: 'gantry' });
b.box(vec3(-28, 6, -18), vec3(1.4, 12, 1.4), SurfaceMaterial.Metal, { style: 'gantry' });
b.box(vec3(-28, 6, 18), vec3(1.4, 12, 1.4), SurfaceMaterial.Metal, { style: 'gantry' });

// Low barriers give crouch cover so the lane isn't a pure sniper duel.
for (let i = 0; i < 6; i++) {
  b.barrier(vec3(-33, 0, -35 + i * 14), 6, false);
}

// ------------------------------------------------ MID — the foundry hall --
// Two-storey open hall, 34 x 40, with big window bands so fights are readable.
b.room(vec3(-17, 0, -20), 34, 40, 11, {
  material: SurfaceMaterial.Brick,
  floorMaterial: SurfaceMaterial.Concrete,
  wallThickness: 0.5,
  doors: { n: 0.5, s: 0.5, w: 0.35, e: 0.65 },
  windows: { w: [4.5, 7.5], e: [4.5, 7.5] },
  ceiling: true,
  style: 'foundry',
});

// The smelter itself: a large central obstacle that splits the hall in two.
b.box(vec3(0, 3.2, 0), vec3(7.5, 6.4, 7.5), SurfaceMaterial.Metal, { style: 'smelter' });
b.box(vec3(0, 8.0, 0), vec3(3.4, 3.2, 3.4), SurfaceMaterial.Metal, { style: 'smelter_stack' });
b.conduit(vec3(0, 8.5, 0), vec3(0, 11.2, 0), 0.6, 'pipe', 0x6a5a4a);

// Catwalks at 6.5m — the high ground inside mid, reachable from both sides.
b.catwalk(vec3(-14, 6.5, -14), vec3(14, 6.5, -14), 2.4);
b.catwalk(vec3(-14, 6.5, 14), vec3(14, 6.5, 14), 2.4);
b.catwalk(vec3(-14, 6.5, -14), vec3(-14, 6.5, 14), 2.4);
b.catwalk(vec3(14, 6.5, -14), vec3(14, 6.5, 14), 2.4);
b.stairs(vec3(-15.5, 0, -17), 'z', 6.5, 8, 2.2);
b.stairs(vec3(15.5, 0, 17), '-z', 6.5, 8, 2.2);

// Ground-floor cover inside the hall.
b.crateStack(vec3(-8, 0, -8), 2, 2001);
b.crateStack(vec3(8, 0, 8), 3, 2002);
b.crateStack(vec3(-9, 0, 9), 1, 2003);
b.barrier(vec3(9, 0, -9), 5, true);
b.dressRoom(vec3(-17, 0, -20), 34, 40, 2010, [
  'barrel',
  'crate_small',
  'pallet',
  'toolbench',
  'cable_spool',
]);

// Ladders of pipes and cabling along the hall walls.
for (let i = 0; i < 6; i++) {
  b.conduit(vec3(-16.6, 8.6, -18 + i * 7), vec3(-16.6, 8.6, -12 + i * 7), 0.18, 'pipe', 0x7a6a58);
  b.conduit(vec3(16.6, 9.2, -18 + i * 7), vec3(16.6, 9.2, -12 + i * 7), 0.12, 'cable', 0x2a2a2e);
}

// ------------------------------------------- EAST — warehouse (close range) --
b.room(vec3(24, 0, -30), 30, 26, 8, {
  material: SurfaceMaterial.Concrete,
  floorMaterial: SurfaceMaterial.Concrete,
  doors: { w: 0.5, s: 0.35 },
  windows: { e: [4.0, 6.2] },
  style: 'warehouse',
});
b.room(vec3(24, 0, 4), 30, 26, 8, {
  material: SurfaceMaterial.Concrete,
  floorMaterial: SurfaceMaterial.Concrete,
  doors: { w: 0.5, n: 0.35 },
  windows: { e: [4.0, 6.2] },
  style: 'warehouse',
});

// Internal shelving turns the warehouses into a maze of short corners.
for (let r = 0; r < 4; r++) {
  const z0 = -27 + r * 7;
  b.box(vec3(30, 1.6, z0), vec3(14, 3.2, 0.7), SurfaceMaterial.Metal, { style: 'shelf' });
  b.box(vec3(30, 4.0, z0), vec3(14, 0.35, 1.4), SurfaceMaterial.Metal, {
    style: 'shelf',
    bulletPassthrough: true,
    detailOnly: true,
  });
}
for (let r = 0; r < 3; r++) {
  const z0 = 8 + r * 7;
  b.box(vec3(30, 1.6, z0), vec3(14, 3.2, 0.7), SurfaceMaterial.Metal, { style: 'shelf' });
}
b.dressRoom(vec3(24, 0, -30), 30, 26, 3001, ['pallet', 'crate_small', 'barrel', 'forklift']);
b.dressRoom(vec3(24, 0, 4), 30, 26, 3002, ['pallet', 'crate_small', 'barrel', 'forklift']);

// ----------------------------------------------- ROOFTOP — parkour route --
// Warehouse roofs at 8m, linked by jumpable gaps and one wall-jump section.
b.box(vec3(39, 8.3, -17), vec3(30, 0.5, 26), SurfaceMaterial.Metal, { style: 'roof' });
b.box(vec3(39, 8.3, 17), vec3(30, 0.5, 26), SurfaceMaterial.Metal, { style: 'roof' });
b.stairs(vec3(52, 0, -40), 'z', 8.3, 10, 2.0); // external stair up from the east alley
// Parkour: three floating platforms bridging the roof gap; the middle one
// requires either a double jump or a dash.
b.box(vec3(39, 8.6, -2.5), vec3(3.2, 0.4, 3.2), SurfaceMaterial.Metal, { style: 'platform' });
b.box(vec3(39, 9.6, 0), vec3(2.6, 0.4, 2.6), SurfaceMaterial.Metal, { style: 'platform' });
b.box(vec3(39, 8.6, 2.5), vec3(3.2, 0.4, 3.2), SurfaceMaterial.Metal, { style: 'platform' });
// Rooftop clutter: AC units, vents, antennas.
for (let i = 0; i < 8; i++) {
  const z = -26 + i * 7;
  b.box(vec3(32 + (i % 3) * 5, 9.2, z), vec3(2.2, 1.4, 2.0), SurfaceMaterial.Metal, {
    style: 'ac_unit',
  });
  b.prop('vent', vec3(45, 8.6, z), 0, 1, 1);
}
b.prop('antenna', vec3(50, 8.6, -20), 0, 1.4, 1);
b.prop('antenna', vec3(50, 8.6, 22), 0, 1.1, 1);

// ------------------------------------- UNDERGROUND — maintenance tunnel --
// A -6m corridor from behind Alpha spawn to behind Bravo spawn.
const TUNNEL_Y = -6;
b.ground(vec3(-24, TUNNEL_Y, 0), 8, 92, SurfaceMaterial.Concrete, 0.6, 'tunnel');
b.box(vec3(-24, TUNNEL_Y + 3.2, 0), vec3(8, 0.5, 92), SurfaceMaterial.Concrete, { style: 'tunnel' });
b.wall(vec3(-28, TUNNEL_Y, -46), vec3(-28, TUNNEL_Y, 46), 3.2, 0.5, SurfaceMaterial.Concrete, {
  style: 'tunnel',
});
b.wall(vec3(-20, TUNNEL_Y, -46), vec3(-20, TUNNEL_Y, 46), 3.2, 0.5, SurfaceMaterial.Concrete, {
  style: 'tunnel',
});
// Stair shafts down at each end, plus one mid-map access so it isn't a dead end.
b.stairs(vec3(-24, 0, -44), 'z', -6, 7, 3.2, SurfaceMaterial.Concrete);
b.stairs(vec3(-24, 0, 44), '-z', -6, 7, 3.2, SurfaceMaterial.Concrete);
b.stairs(vec3(-24, 0, 2), 'z', -6, 7, 3.2, SurfaceMaterial.Concrete);
// Standing water changes footstep sound and reflects the tunnel lights.
b.ground(vec3(-24, TUNNEL_Y + 0.05, -14), 7.4, 12, SurfaceMaterial.Water, 0.1, 'water');
for (let i = 0; i < 10; i++) {
  b.conduit(
    vec3(-27.4, TUNNEL_Y + 2.6, -45 + i * 9),
    vec3(-27.4, TUNNEL_Y + 2.6, -37 + i * 9),
    0.2,
    'pipe',
    0x4a5560,
  );
}

// ------------------------------------------------- SECRET — sealed vault --
// Behind a breakable panel halfway down the tunnel. Feeds a secret quest.
b.room(vec3(-40, TUNNEL_Y, -6), 10, 12, 3, {
  material: SurfaceMaterial.Concrete,
  doors: { e: 0.5 },
  ceiling: true,
  style: 'vault',
});
b.box(vec3(-30, TUNNEL_Y + 1.5, 0), vec3(0.3, 3, 3.2), SurfaceMaterial.Glass, {
  breakable: true,
  penetration: 0.12,
  style: 'vault_panel',
});
b.prop('cache_terminal', vec3(-38, TUNNEL_Y, -2), Math.PI / 2, 1.2, 0);

// ------------------------------------------------------------ Objectives --
// Three capture points: one per lane, so Objective mode uses the whole map.
b.box(vec3(-40, 0.06, 0), vec3(8, 0.12, 8), SurfaceMaterial.Metal, {
  noCollision: true,
  style: 'objective_pad',
  color: 0x3f8ce8,
});
b.box(vec3(0, 0.06, 0), vec3(8, 0.12, 8), SurfaceMaterial.Metal, {
  noCollision: true,
  style: 'objective_pad',
  color: 0xf0a02a,
});
b.box(vec3(30, 0.06, -12), vec3(8, 0.12, 8), SurfaceMaterial.Metal, {
  noCollision: true,
  style: 'objective_pad',
  color: 0xf0426e,
});

// ----------------------------------------------------------------- Lights --
const lights: LightDefinition[] = [
  // Hall interior — warm smelter glow, the map's signature light.
  { kind: 'point', at: vec3(0, 5.5, 0), color: 0xff7a2a, intensity: 3.2, distance: 26, shadows: true },
  { kind: 'point', at: vec3(-10, 8, -12), color: 0xffe6c0, intensity: 1.1, distance: 20, shadows: false },
  { kind: 'point', at: vec3(10, 8, 12), color: 0xffe6c0, intensity: 1.1, distance: 20, shadows: false },
  // Warehouses.
  { kind: 'point', at: vec3(30, 6.5, -20), color: 0xdfe8f0, intensity: 1.3, distance: 22, shadows: false },
  { kind: 'point', at: vec3(30, 6.5, 14), color: 0xdfe8f0, intensity: 1.3, distance: 22, shadows: false },
  // Tunnel strip lights.
  ...Array.from({ length: 7 }, (_, i): LightDefinition => ({
    kind: 'point',
    at: vec3(-24, TUNNEL_Y + 2.6, -42 + i * 14),
    color: 0x9fd0c0,
    intensity: 0.9,
    distance: 14,
    shadows: false,
    detailOnly: i % 2 === 1,
  })),
  // Yard floodlights on the gantry.
  { kind: 'spot', at: vec3(-40, 11.5, -20), target: vec3(-40, 0, -10), color: 0xfff4e0, intensity: 2.2, distance: 45, shadows: false },
  { kind: 'spot', at: vec3(-40, 11.5, 20), target: vec3(-40, 0, 10), color: 0xfff4e0, intensity: 2.2, distance: 45, shadows: false },
  // Secret vault — dim, so it reads as "not meant to be found".
  { kind: 'point', at: vec3(-35, TUNNEL_Y + 2, 0), color: 0x4ec97a, intensity: 0.6, distance: 10, shadows: false, detailOnly: true },
];

// ------------------------------------------------------------- Spawns -----
function spawnRow(z: number, team: TeamId, yaw: number): SpawnPoint[] {
  const xs = [-10, -5, 0, 5, 10];
  return xs.map((x, i) => ({
    at: vec3(x, 0.2, z),
    yaw,
    team,
    priority: i === 2 ? 2 : 1,
    tags: [ZoneTag.Spawn, ZoneTag.Interior],
  }));
}

const spawns: SpawnPoint[] = [
  ...spawnRow(-45, TeamId.Alpha, 0),
  ...spawnRow(44, TeamId.Bravo, Math.PI),
  // Neutral spawns used by FFA and by team modes when a base spawn is contested.
  { at: vec3(-45, 0.2, -30), yaw: Math.PI / 2, team: TeamId.None, priority: 1, tags: [ZoneTag.Exterior, ZoneTag.LongRange] },
  { at: vec3(-45, 0.2, 30), yaw: Math.PI / 2, team: TeamId.None, priority: 1, tags: [ZoneTag.Exterior, ZoneTag.LongRange] },
  { at: vec3(34, 0.2, -34), yaw: Math.PI, team: TeamId.None, priority: 1, tags: [ZoneTag.Interior, ZoneTag.CloseRange] },
  { at: vec3(34, 0.2, 14), yaw: 0, team: TeamId.None, priority: 1, tags: [ZoneTag.Interior, ZoneTag.CloseRange] },
  { at: vec3(39, 9.0, -20), yaw: Math.PI, team: TeamId.None, priority: 0, tags: [ZoneTag.Rooftop, ZoneTag.HighGround] },
  { at: vec3(0, 0.2, -22), yaw: Math.PI, team: TeamId.None, priority: 1, tags: [ZoneTag.MidRange, ZoneTag.Interior] },
  { at: vec3(0, 0.2, 22), yaw: 0, team: TeamId.None, priority: 1, tags: [ZoneTag.MidRange, ZoneTag.Interior] },
];

export const FOUNDRY_REACH: MapDefinition = {
  id: 'foundry_reach',
  nameKey: 'map.foundry_reach.name',
  descriptionKey: 'map.foundry_reach.desc',
  bounds: { min: vec3(-62, -12, -52), max: vec3(62, 30, 52) },
  supportedModes: ['tdm', 'ffa', 'objective', 'elimination', 'ranked'],
  recommendedPlayers: [6, 12],
  themeColor: 0xd88a3a,

  volumes: b.volumes,
  props: b.props,
  spawns,
  lights,

  objectives: [
    { id: 'yard', nameKey: 'map.foundry_reach.obj.yard', at: vec3(-40, 0, 0), radius: 5.5, height: 4 },
    { id: 'foundry', nameKey: 'map.foundry_reach.obj.foundry', at: vec3(0, 0, 0), radius: 5.5, height: 6 },
    { id: 'depot', nameKey: 'map.foundry_reach.obj.depot', at: vec3(30, 0, -12), radius: 5.5, height: 4 },
  ],

  zones: [
    { id: 'west_yard', min: vec3(-62, -1, -52), max: vec3(-18, 16, 52), tags: [ZoneTag.LongRange, ZoneTag.Exterior, ZoneTag.MainRoute], nameKey: 'map.zone.west_yard' },
    { id: 'foundry_hall', min: vec3(-18, -1, -22), max: vec3(18, 12, 22), tags: [ZoneTag.MidRange, ZoneTag.Interior, ZoneTag.Strategic, ZoneTag.HighGround], nameKey: 'map.zone.foundry_hall' },
    { id: 'east_warehouse', min: vec3(8, -1, -44), max: vec3(56, 9, 32), tags: [ZoneTag.CloseRange, ZoneTag.Interior, ZoneTag.SideRoute], nameKey: 'map.zone.east_warehouse' },
    { id: 'rooftops', min: vec3(22, 8, -32), max: vec3(56, 16, 32), tags: [ZoneTag.Rooftop, ZoneTag.HighGround, ZoneTag.Parkour], nameKey: 'map.zone.rooftops' },
    { id: 'tunnel', min: vec3(-30, -8, -48), max: vec3(-18, -2, 48), tags: [ZoneTag.Underground, ZoneTag.FlankRoute, ZoneTag.CloseRange], nameKey: 'map.zone.tunnel' },
    { id: 'vault', min: vec3(-46, -8, -14), max: vec3(-30, -2, 2), tags: [ZoneTag.Secret, ZoneTag.Underground], nameKey: 'map.zone.vault' },
  ],

  backdrop: [
    { kind: 'mountains', distance: 620, count: 22, minHeight: 60, maxHeight: 190, color: 0x63758c, seed: 7001 },
    { kind: 'city', distance: 380, count: 34, minHeight: 24, maxHeight: 95, color: 0x77869b, seed: 7002 },
    { kind: 'towers', distance: 240, count: 12, minHeight: 30, maxHeight: 70, color: 0x6b7788, seed: 7003 },
    { kind: 'antennas', distance: 200, count: 16, minHeight: 12, maxHeight: 30, color: 0x55606d, seed: 7004 },
    { kind: 'trees', distance: 150, count: 60, minHeight: 6, maxHeight: 14, color: 0x35502f, seed: 7005 },
    { kind: 'road', distance: 170, count: 1, minHeight: 0, maxHeight: 0, color: 0x2b2f33, seed: 7006 },
  ],

  environment: {
    timeOfDay: 16.5,
    sunColor: 0xffd9a8,
    sunIntensity: 1.85,
    ambientColor: 0x9fb0c8,
    ambientIntensity: 0.5,
    skyTopColor: 0x2f5f95,
    skyBottomColor: 0xe0c49a,
    fogColor: 0xc3b49c,
    fogNear: 70,
    fogFar: 320,
    rain: 0,
    haze: 0.28,
    windDirection: 0.9,
    windStrength: 0.35,
    ambienceKeys: ['amb.wind_open', 'amb.machinery_low', 'amb.distant_traffic'],
  },

  secrets: [
    { id: 'vault_panel', kind: 'zone', at: vec3(-30, -5, 0), radius: 2.5, unlocksId: 'secret_foundry_vault' },
    { id: 'vault_terminal', kind: 'button', at: vec3(-38, -6, -2), radius: 1.8, unlocksId: 'secret_foundry_vault' },
  ],

  npcSpawns: [],
  vehicleSpawns: [
    { vehicleId: 'scout_buggy', at: vec3(-48, 0.4, -40), yaw: 0 },
    { vehicleId: 'scout_buggy', at: vec3(-48, 0.4, 40), yaw: Math.PI },
  ],
};
