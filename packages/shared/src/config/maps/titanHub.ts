/**
 * TITAN HUB — the social lobby.
 *
 * Not a combat map: this is where the player lands after logging in. It exists
 * as a real playable space (you can walk, jump and dash around it) so the
 * meta-game — shop, quests, tutorial, the firing range — is diegetic rather
 * than a stack of menus. NPCs stand at fixed anchors here.
 */

import { vec3 } from '../../core/math.js';
import { SurfaceMaterial, TeamId } from '../../types/domain.js';
import { MapBuilder } from './builder.js';
import { ZoneTag, type LightDefinition, type MapDefinition } from './mapTypes.js';

const b = new MapBuilder();

// Main deck.
b.ground(vec3(0, 0, 0), 70, 60, SurfaceMaterial.Metal, 1.5, 'hub_floor');
b.ground(vec3(0, 0.03, 0), 22, 22, SurfaceMaterial.Metal, 0.1, 'hub_emblem');

// Enclosure with a big window wall looking out over the backdrop city.
b.wall(vec3(-35, 0, -30), vec3(35, 0, -30), 12, 0.6, SurfaceMaterial.Metal, {
  windowBand: [3, 9],
  windowSpacing: 6,
  windowWidth: 4.4,
  style: 'hub_glass',
});
b.wall(vec3(-35, 0, 30), vec3(35, 0, 30), 12, 0.6, SurfaceMaterial.Metal, { style: 'hub_wall' });
b.wall(vec3(-35, 0, -30), vec3(-35, 0, 30), 12, 0.6, SurfaceMaterial.Metal, { style: 'hub_wall' });
b.wall(vec3(35, 0, -30), vec3(35, 0, 30), 12, 0.6, SurfaceMaterial.Metal, {
  windowBand: [3, 9],
  windowSpacing: 6,
  windowWidth: 4.4,
  style: 'hub_glass',
});
b.box(vec3(0, 12.3, 0), vec3(70, 0.6, 60), SurfaceMaterial.Metal, { style: 'hub_ceiling' });

// Mezzanine ring — somewhere to practise movement while queuing.
b.catwalk(vec3(-26, 5.0, -22), vec3(26, 5.0, -22), 4.0);
b.catwalk(vec3(-26, 5.0, 22), vec3(26, 5.0, 22), 4.0);
b.catwalk(vec3(-26, 5.0, -22), vec3(-26, 5.0, 22), 4.0);
b.catwalk(vec3(26, 5.0, -22), vec3(26, 5.0, 22), 4.0);
b.stairs(vec3(-26, 0, -26), 'z', 5.0, 6, 3.0);
b.stairs(vec3(26, 0, 26), '-z', 5.0, 6, 3.0);

// Service counters for the NPCs.
const counters: [number, number, number, string][] = [
  [-22, -18, 0, 'shop'],
  [22, -18, Math.PI, 'quartermaster'],
  [-22, 18, 0, 'quests'],
  [22, 18, Math.PI, 'archivist'],
];
for (const [x, z, rot, kind] of counters) {
  b.box(vec3(x, 0.55, z), vec3(6, 1.1, 1.6), SurfaceMaterial.Metal, { style: 'counter' });
  b.box(vec3(x, 3.2, z - 1.4), vec3(5.4, 2.2, 0.2), SurfaceMaterial.Plastic, {
    noCollision: true,
    emissive: 1.6,
    color: 0x3f8ce8,
    style: 'holo_board',
  });
  b.prop(`counter_${kind}`, vec3(x, 1.15, z), rot, 1, 0);
}

// Firing range: a lane with pop-up targets, used by the tutorial.
b.ground(vec3(0, 0.05, -26), 24, 6, SurfaceMaterial.Concrete, 0.2, 'range_floor');
for (let i = 0; i < 5; i++) {
  b.box(vec3(-8 + i * 4, 1.0, -28.5), vec3(0.9, 2.0, 0.3), SurfaceMaterial.Metal, {
    style: 'range_target',
    color: 0xf0a02a,
  });
}
b.barrier(vec3(0, 0, -23.5), 22, true);

// Parkour warm-up pillars in the centre.
for (let i = 0; i < 6; i++) {
  const ang = (i / 6) * Math.PI * 2;
  b.box(
    vec3(Math.cos(ang) * 9, 0.9 + (i % 3) * 0.7, Math.sin(ang) * 9),
    vec3(2.0, 1.8 + (i % 3) * 1.4, 2.0),
    SurfaceMaterial.Metal,
    { style: 'pillar' },
  );
}

b.dressRoom(vec3(-34, 0, -29), 68, 58, 9001, ['crate_small', 'locker', 'bench', 'planter', 'terminal']);

const lights: LightDefinition[] = [
  { kind: 'directional', at: vec3(30, 40, -30), target: vec3(0, 0, 0), color: 0xdfe8ff, intensity: 1.1, shadows: true, distance: 0 },
  { kind: 'point', at: vec3(0, 9, 0), color: 0xcfe0ff, intensity: 2.0, distance: 40, shadows: false },
  ...counters.map(([x, , , ]): LightDefinition => ({
    kind: 'point',
    at: vec3(x, 4.2, 0),
    color: 0x3f8ce8,
    intensity: 1.1,
    distance: 18,
    shadows: false,
  })),
  { kind: 'point', at: vec3(0, 4, -26), color: 0xffd8a0, intensity: 1.4, distance: 22, shadows: false },
];

export const TITAN_HUB: MapDefinition = {
  id: 'titan_hub',
  nameKey: 'map.titan_hub.name',
  descriptionKey: 'map.titan_hub.desc',
  bounds: { min: vec3(-35, -4, -30), max: vec3(35, 20, 30) },
  supportedModes: ['hub'],
  recommendedPlayers: [1, 12],
  themeColor: 0x3f8ce8,

  volumes: b.volumes,
  props: b.props,
  lights,

  spawns: [
    { at: vec3(0, 0.2, 12), yaw: Math.PI, team: TeamId.None, priority: 3, tags: [ZoneTag.Spawn] },
    { at: vec3(-4, 0.2, 14), yaw: Math.PI, team: TeamId.None, priority: 2, tags: [ZoneTag.Spawn] },
    { at: vec3(4, 0.2, 14), yaw: Math.PI, team: TeamId.None, priority: 2, tags: [ZoneTag.Spawn] },
  ],

  objectives: [],
  zones: [
    { id: 'concourse', min: vec3(-35, -1, -30), max: vec3(35, 5, 30), tags: [ZoneTag.Interior], nameKey: 'map.zone.concourse' },
    { id: 'range', min: vec3(-13, -1, -30), max: vec3(13, 4, -22), tags: [ZoneTag.Interior, ZoneTag.Strategic], nameKey: 'map.zone.range' },
    { id: 'mezzanine', min: vec3(-28, 4, -24), max: vec3(28, 9, 24), tags: [ZoneTag.HighGround, ZoneTag.Parkour], nameKey: 'map.zone.mezzanine' },
  ],

  backdrop: [
    { kind: 'city', distance: 420, count: 40, minHeight: 40, maxHeight: 160, color: 0x4a5b78, seed: 9101 },
    { kind: 'mountains', distance: 700, count: 18, minHeight: 80, maxHeight: 200, color: 0x5d6b85, seed: 9102 },
    { kind: 'towers', distance: 300, count: 10, minHeight: 60, maxHeight: 120, color: 0x54638a, seed: 9103 },
  ],

  environment: {
    timeOfDay: 9,
    sunColor: 0xfff0dc,
    sunIntensity: 1.2,
    ambientColor: 0xa8bcd8,
    ambientIntensity: 0.7,
    skyTopColor: 0x3a6aa8,
    skyBottomColor: 0xc8dcf0,
    fogColor: 0xbdd0e4,
    fogNear: 80,
    fogFar: 400,
    rain: 0,
    haze: 0.1,
    windDirection: 0,
    windStrength: 0,
    ambienceKeys: ['amb.hub_hum', 'amb.crowd_low'],
  },

  secrets: [
    // A hidden panel behind the archivist's counter, opening the first secret quest.
    { id: 'hub_panel', kind: 'button', at: vec3(24, 0, 19), radius: 1.4, unlocksId: 'secret_hub_signal' },
  ],

  npcSpawns: [
    { npcId: 'npc_quartermaster', at: vec3(-22, 0.2, -19.4), yaw: 0 },
    { npcId: 'npc_armorer', at: vec3(22, 0.2, -19.4), yaw: Math.PI },
    { npcId: 'npc_dispatcher', at: vec3(-22, 0.2, 16.6), yaw: 0 },
    { npcId: 'npc_archivist', at: vec3(22, 0.2, 16.6), yaw: Math.PI },
    { npcId: 'npc_instructor', at: vec3(0, 0.2, -21), yaw: Math.PI },
  ],
  vehicleSpawns: [],
};
