/**
 * Game mode configuration.
 *
 * The *rules* live on the server (packages/server/src/gamemodes) behind a
 * `GameMode` interface; this file holds the data half so the client can render
 * the mode-select screen, scoreboards and objectives without importing server
 * code. Adding a mode means adding an entry here plus one server class.
 */

import { GameModeId } from '../types/domain.js';

export interface GameModeConfig {
  id: GameModeId;
  nameKey: string;
  descriptionKey: string;
  /** Team-based modes assign Alpha/Bravo; otherwise everyone is TeamId.None. */
  teamBased: boolean;
  minPlayers: number;
  maxPlayers: number;
  /** Players per team; ignored when `teamBased` is false. */
  teamSize: number;

  /** Score needed to win; 0 = time-limited only. */
  scoreLimit: number;
  /** Match duration in seconds; 0 = unlimited. */
  timeLimitSec: number;
  warmupSec: number;
  countdownSec: number;
  postMatchSec: number;

  /** Round-based modes (Elimination) use these. */
  roundBased: boolean;
  roundsToWin: number;
  roundTimeSec: number;
  roundResetSec: number;

  respawnEnabled: boolean;
  respawnDelayMs: number;
  friendlyFire: boolean;
  /** Damage multiplier applied to friendly fire when enabled. */
  friendlyFireScale: number;

  /** Contributes to rank points and is matched by skill. */
  ranked: boolean;
  /** XP multiplier for this mode. */
  xpMultiplier: number;
  coinMultiplier: number;

  /** Objective capture tuning; only read by the Objective mode. */
  captureTimeSec: number;
  captureTickPoints: number;

  /** Which maps this mode can roll. Empty = all combat maps. */
  mapPool: string[];
  unlockLevel: number;
}

export const GAME_MODES: readonly GameModeConfig[] = [
  {
    id: GameModeId.TeamDeathmatch,
    nameKey: 'mode.tdm.name',
    descriptionKey: 'mode.tdm.desc',
    teamBased: true,
    minPlayers: 2,
    maxPlayers: 12,
    teamSize: 6,
    scoreLimit: 50,
    timeLimitSec: 600,
    warmupSec: 15,
    countdownSec: 5,
    postMatchSec: 20,
    roundBased: false,
    roundsToWin: 0,
    roundTimeSec: 0,
    roundResetSec: 0,
    respawnEnabled: true,
    respawnDelayMs: 4000,
    friendlyFire: false,
    friendlyFireScale: 0,
    ranked: false,
    xpMultiplier: 1.0,
    coinMultiplier: 1.0,
    captureTimeSec: 0,
    captureTickPoints: 0,
    mapPool: [],
    unlockLevel: 1,
  },
  {
    id: GameModeId.FreeForAll,
    nameKey: 'mode.ffa.name',
    descriptionKey: 'mode.ffa.desc',
    teamBased: false,
    minPlayers: 2,
    maxPlayers: 10,
    teamSize: 1,
    scoreLimit: 25,
    timeLimitSec: 480,
    warmupSec: 10,
    countdownSec: 5,
    postMatchSec: 20,
    roundBased: false,
    roundsToWin: 0,
    roundTimeSec: 0,
    roundResetSec: 0,
    respawnEnabled: true,
    respawnDelayMs: 3000,
    friendlyFire: false,
    friendlyFireScale: 0,
    ranked: false,
    xpMultiplier: 1.0,
    coinMultiplier: 1.0,
    captureTimeSec: 0,
    captureTickPoints: 0,
    mapPool: [],
    unlockLevel: 1,
  },
  {
    id: GameModeId.Objective,
    nameKey: 'mode.objective.name',
    descriptionKey: 'mode.objective.desc',
    teamBased: true,
    minPlayers: 4,
    maxPlayers: 12,
    teamSize: 6,
    scoreLimit: 300,
    timeLimitSec: 720,
    warmupSec: 15,
    countdownSec: 5,
    postMatchSec: 20,
    roundBased: false,
    roundsToWin: 0,
    roundTimeSec: 0,
    roundResetSec: 0,
    respawnEnabled: true,
    respawnDelayMs: 5000,
    friendlyFire: false,
    friendlyFireScale: 0,
    ranked: false,
    xpMultiplier: 1.15,
    coinMultiplier: 1.1,
    captureTimeSec: 8,
    captureTickPoints: 1,
    mapPool: [],
    unlockLevel: 3,
  },
  {
    id: GameModeId.Elimination,
    nameKey: 'mode.elimination.name',
    descriptionKey: 'mode.elimination.desc',
    teamBased: true,
    minPlayers: 4,
    maxPlayers: 10,
    teamSize: 5,
    scoreLimit: 0,
    timeLimitSec: 0,
    warmupSec: 15,
    countdownSec: 5,
    postMatchSec: 20,
    roundBased: true,
    roundsToWin: 5,
    roundTimeSec: 120,
    roundResetSec: 6,
    respawnEnabled: false,
    respawnDelayMs: 0,
    friendlyFire: true,
    friendlyFireScale: 0.35,
    ranked: false,
    xpMultiplier: 1.25,
    coinMultiplier: 1.2,
    captureTimeSec: 0,
    captureTickPoints: 0,
    mapPool: [],
    unlockLevel: 6,
  },
  {
    id: GameModeId.Ranked,
    nameKey: 'mode.ranked.name',
    descriptionKey: 'mode.ranked.desc',
    teamBased: true,
    minPlayers: 4,
    maxPlayers: 10,
    teamSize: 5,
    scoreLimit: 0,
    timeLimitSec: 0,
    warmupSec: 20,
    countdownSec: 8,
    postMatchSec: 25,
    roundBased: true,
    roundsToWin: 7,
    roundTimeSec: 130,
    roundResetSec: 7,
    respawnEnabled: false,
    respawnDelayMs: 0,
    friendlyFire: true,
    friendlyFireScale: 0.35,
    ranked: true,
    xpMultiplier: 1.4,
    coinMultiplier: 1.3,
    captureTimeSec: 0,
    captureTickPoints: 0,
    mapPool: [],
    unlockLevel: 15,
  },
];

const BY_ID = new Map(GAME_MODES.map((m) => [m.id, m]));

export const getGameMode = (id: string): GameModeConfig | undefined =>
  BY_ID.get(id as GameModeId);

export function requireGameMode(id: string): GameModeConfig {
  const m = getGameMode(id);
  if (!m) throw new Error(`Unknown game mode: ${id}`);
  return m;
}

export const DEFAULT_MODE_ID = GameModeId.TeamDeathmatch;
