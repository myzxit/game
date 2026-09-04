/**
 * Map registry. Adding a map = writing one file and adding it to this list.
 */

import type { MapDefinition } from './mapTypes.js';
import { FOUNDRY_REACH } from './foundryReach.js';
import { NEON_QUARTER } from './neonQuarter.js';
import { TITAN_HUB } from './titanHub.js';

export * from './mapTypes.js';
export * from './builder.js';

export const MAPS: readonly MapDefinition[] = [FOUNDRY_REACH, NEON_QUARTER, TITAN_HUB];

const BY_ID = new Map(MAPS.map((m) => [m.id, m]));

export const getMap = (id: string): MapDefinition | undefined => BY_ID.get(id);

export function requireMap(id: string): MapDefinition {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`Unknown map id: ${id}`);
  return m;
}

/** Maps playable in a given game mode. */
export function mapsForMode(modeId: string): MapDefinition[] {
  return MAPS.filter((m) => m.supportedModes.includes(modeId));
}

export const HUB_MAP_ID = 'titan_hub';
export const COMBAT_MAP_IDS = MAPS.filter((m) => m.id !== HUB_MAP_ID).map((m) => m.id);

export { FOUNDRY_REACH, NEON_QUARTER, TITAN_HUB };
