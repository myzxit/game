/**
 * Map data model.
 *
 * A map is authored as data, not code: a list of *volumes* (which produce both
 * collision brushes and renderable geometry), *props* (visual only), spawn
 * points, objective points and an environment profile. The server only ever
 * loads the collision half; the client loads everything.
 *
 * This split is what makes maps cheap to add — see docs/CONTENT.md.
 */

import type { Vec3 } from '../../core/math.js';
import { SurfaceMaterial, TeamId } from '../../types/domain.js';

/** Semantic tag for a region — used by bots, spawn scoring and the minimap. */
export enum ZoneTag {
  Spawn = 'spawn',
  MainRoute = 'main_route',
  SideRoute = 'side_route',
  FlankRoute = 'flank_route',
  LongRange = 'long_range',
  MidRange = 'mid_range',
  CloseRange = 'close_range',
  HighGround = 'high_ground',
  LowGround = 'low_ground',
  Interior = 'interior',
  Exterior = 'exterior',
  Rooftop = 'rooftop',
  Underground = 'underground',
  Secret = 'secret',
  Parkour = 'parkour',
  Strategic = 'strategic',
  Objective = 'objective',
}

/** A solid box that becomes both collision and rendered geometry. */
export interface MapVolume {
  /** Centre position. */
  at: Vec3;
  /** Full size (not half-extents). */
  size: Vec3;
  material: SurfaceMaterial;
  /** Visual style key — maps to a client material preset. */
  style?: string;
  /** Bullets pass through (railings, grates). */
  bulletPassthrough?: boolean;
  /** Players pass through (decorative overhangs). */
  playerPassthrough?: boolean;
  /** 0 = stops bullets; >0 = penetrable with this damage loss. */
  penetration?: number;
  breakable?: boolean;
  climbable?: boolean;
  /** Skip collision entirely — pure decoration. */
  noCollision?: boolean;
  /** Emissive intensity for neon/signage. */
  emissive?: number;
  /** Override colour (hex). */
  color?: number;
  /** Excluded on the Low graphics preset. */
  detailOnly?: boolean;
}

/** Visual-only instanced decoration (pipes, cables, vents, furniture, foliage). */
export interface MapProp {
  kind: string;
  at: Vec3;
  rotationY: number;
  scale: number;
  color?: number;
  /** Culled first on low-end presets. */
  lod: 0 | 1 | 2;
}

export interface SpawnPoint {
  at: Vec3;
  yaw: number;
  team: TeamId;
  /** Higher priority points are preferred when safe. */
  priority: number;
  tags: ZoneTag[];
}

export interface ObjectivePoint {
  id: string;
  nameKey: string;
  at: Vec3;
  /** Capture radius in metres. */
  radius: number;
  height: number;
}

export interface MapZone {
  id: string;
  min: Vec3;
  max: Vec3;
  tags: ZoneTag[];
  nameKey: string;
}

/** Distant, non-interactive scenery that fills the horizon. */
export interface BackdropLayer {
  kind: 'city' | 'mountains' | 'road' | 'towers' | 'trees' | 'antennas';
  /** Distance from map centre. */
  distance: number;
  /** How many instances to scatter along the ring. */
  count: number;
  minHeight: number;
  maxHeight: number;
  color: number;
  /** Deterministic scatter seed. */
  seed: number;
}

export interface LightDefinition {
  kind: 'point' | 'spot' | 'directional';
  at: Vec3;
  target?: Vec3;
  color: number;
  intensity: number;
  distance: number;
  /** Casts shadows only on High preset. */
  shadows: boolean;
  /** Culled on Low preset. */
  detailOnly?: boolean;
}

export interface EnvironmentProfile {
  /** Time of day 0..24. Affects sun angle and colour. */
  timeOfDay: number;
  sunColor: number;
  sunIntensity: number;
  ambientColor: number;
  ambientIntensity: number;
  skyTopColor: number;
  skyBottomColor: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  /** 0..1 — drives rain particles and puddle reflections. */
  rain: number;
  /** 0..1 — drives volumetric fog density. */
  haze: number;
  windDirection: number;
  windStrength: number;
  /** Ambient loop keys, layered by the audio system. */
  ambienceKeys: string[];
}

export interface MapDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  /** Playable bounds; anything outside is out of bounds. */
  bounds: { min: Vec3; max: Vec3 };
  /** Which modes this map supports. */
  supportedModes: string[];
  recommendedPlayers: [number, number];

  volumes: MapVolume[];
  props: MapProp[];
  spawns: SpawnPoint[];
  objectives: ObjectivePoint[];
  zones: MapZone[];
  lights: LightDefinition[];
  backdrop: BackdropLayer[];
  environment: EnvironmentProfile;

  /** Hidden-content anchors: secret rooms, buttons, caches. */
  secrets: SecretAnchor[];
  /** NPC placement in social/lobby maps. */
  npcSpawns: { npcId: string; at: Vec3; yaw: number }[];
  /** Vehicle spawn pads. */
  vehicleSpawns: { vehicleId: string; at: Vec3; yaw: number }[];

  /** Preview colour used by the map-select UI. */
  themeColor: number;
}

export interface SecretAnchor {
  id: string;
  /** What the player must do here. */
  kind: 'button' | 'zone' | 'item' | 'sequence';
  at: Vec3;
  radius: number;
  /** Secret quest / achievement this feeds. */
  unlocksId: string;
  /** Order index for `sequence` secrets. */
  order?: number;
}

export const DEFAULT_ENVIRONMENT: EnvironmentProfile = {
  timeOfDay: 14,
  sunColor: 0xfff2df,
  sunIntensity: 1.5,
  ambientColor: 0x8fa8c8,
  ambientIntensity: 0.55,
  skyTopColor: 0x2d5a94,
  skyBottomColor: 0xbcd2e8,
  fogColor: 0xa8bdd4,
  fogNear: 45,
  fogFar: 260,
  rain: 0,
  haze: 0.15,
  windDirection: 0.6,
  windStrength: 0.3,
  ambienceKeys: ['amb.wind_open'],
};
