/**
 * Game mode registry.
 *
 * Adding a mode: write the class, add a config entry in
 * `@titan/shared/config/gameModes.ts`, and register it here. Nothing else in
 * the server needs to change.
 */

import { GameModeId, requireGameMode, type GameModeConfig } from '@titan/shared';
import type { GameMode } from './GameMode.js';
import { TeamDeathmatch } from './TeamDeathmatch.js';
import { FreeForAll } from './FreeForAll.js';
import { ObjectiveMode } from './Objective.js';
import { Elimination, Ranked } from './Elimination.js';

type ModeFactory = (config: GameModeConfig) => GameMode;

const FACTORIES: Record<string, ModeFactory> = {
  [GameModeId.TeamDeathmatch]: (c) => new TeamDeathmatch(c),
  [GameModeId.FreeForAll]: (c) => new FreeForAll(c),
  [GameModeId.Objective]: (c) => new ObjectiveMode(c),
  [GameModeId.Elimination]: (c) => new Elimination(c),
  [GameModeId.Ranked]: (c) => new Ranked(c),
};

export function createGameMode(modeId: string): GameMode {
  const config = requireGameMode(modeId);
  const factory = FACTORIES[modeId];
  if (!factory) throw new Error(`No game mode implementation registered for ${modeId}`);
  return factory(config);
}

export function isModeRegistered(modeId: string): boolean {
  return modeId in FACTORIES;
}

export const REGISTERED_MODE_IDS = Object.keys(FACTORIES);

export * from './GameMode.js';
export { TeamDeathmatch, FreeForAll, ObjectiveMode, Elimination, Ranked };
