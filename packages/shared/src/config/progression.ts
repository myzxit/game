/**
 * XP, levels, ranks and seasons.
 *
 * All curves are pure functions so the client can render progress bars without
 * asking the server, while the server remains the only thing that can *grant*
 * XP (see server/services/ProgressionService).
 */

import { MAX_LEVEL } from '../core/constants.js';
import { clamp } from '../core/math.js';

// --------------------------------------------------------------- XP curve --

/**
 * XP required to advance from `level` to `level + 1`.
 * Gentle early (fast first levels teach the loop), then near-linear so the
 * grind never becomes exponential — a deliberate anti-burnout choice.
 */
export function xpForLevel(level: number): number {
  const l = clamp(Math.floor(level), 1, MAX_LEVEL);
  if (l >= MAX_LEVEL) return Infinity;
  return Math.round(600 + 145 * (l - 1) + 9 * (l - 1) ** 1.55);
}

/** Cumulative XP needed to reach `level` from zero. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < clamp(level, 1, MAX_LEVEL); l++) total += xpForLevel(l);
  return total;
}

export interface LevelProgress {
  level: number;
  xpIntoLevel: number;
  xpForNext: number;
  progress: number;
  isMax: boolean;
}

/** Resolve a total XP value into a level and progress bar state. */
export function levelFromTotalXp(totalXp: number): LevelProgress {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (level < MAX_LEVEL) {
    const need = xpForLevel(level);
    if (remaining < need) break;
    remaining -= need;
    level++;
  }
  const isMax = level >= MAX_LEVEL;
  const xpForNext = isMax ? 0 : xpForLevel(level);
  return {
    level,
    xpIntoLevel: isMax ? 0 : remaining,
    xpForNext,
    progress: isMax ? 1 : xpForNext > 0 ? remaining / xpForNext : 0,
    isMax,
  };
}

// ------------------------------------------------------------ XP rewards --

export const XP_REWARDS = {
  kill: 100,
  assist: 45,
  headshotBonus: 25,
  longshotBonus: 20,
  multiKillBonus: 40, // per extra kill in the window
  killStreakBonus: 15, // per streak step above 2
  objectiveCapture: 150,
  objectiveDefend: 75,
  objectiveTick: 8,
  roundWin: 250,
  roundLoss: 100,
  matchWin: 800,
  matchLoss: 350,
  matchCompletionPerMinute: 40,
  firstBloodBonus: 120,
  revengeBonus: 30,
  savedTeammate: 60,
} as const;

export const COIN_REWARDS = {
  kill: 8,
  assist: 4,
  objectiveCapture: 25,
  roundWin: 30,
  matchWin: 150,
  matchLoss: 70,
  perMinute: 10,
} as const;

/** Rewards granted for reaching a level. Sparse: only milestone levels give items. */
export interface LevelReward {
  level: number;
  coins: number;
  cores: number;
  itemIds: string[];
  titleKey?: string;
}

export const LEVEL_REWARDS: readonly LevelReward[] = [
  { level: 2, coins: 250, cores: 0, itemIds: [] },
  { level: 3, coins: 0, cores: 0, itemIds: ['stock_heavy'] },
  { level: 5, coins: 500, cores: 5, itemIds: ['br12_fracture'] },
  { level: 8, coins: 0, cores: 0, itemIds: ['ak_ridgeline'] },
  { level: 10, coins: 900, cores: 10, itemIds: ['crate_standard'], titleKey: 'title.operative' },
  { level: 12, coins: 0, cores: 0, itemIds: ['mk7_nightfall'] },
  { level: 15, coins: 1200, cores: 10, itemIds: ['vx3_lattice'] },
  { level: 20, coins: 1500, cores: 15, itemIds: ['crate_premium'], titleKey: 'title.veteran' },
  { level: 25, coins: 2000, cores: 20, itemIds: ['arc9_tempest'] },
  { level: 30, coins: 2500, cores: 20, itemIds: ['skin_weapon_ashfall'] },
  { level: 40, coins: 3500, cores: 30, itemIds: ['crate_premium'], titleKey: 'title.specialist' },
  { level: 50, coins: 5000, cores: 50, itemIds: ['skin_char_obsidian'], titleKey: 'title.vanguard_elite' },
  { level: 75, coins: 8000, cores: 75, itemIds: ['crate_legendary'] },
  { level: 100, coins: 15000, cores: 150, itemIds: ['skin_char_titan'], titleKey: 'title.titan' },
];

export function rewardsForLevel(level: number): LevelReward | undefined {
  return LEVEL_REWARDS.find((r) => r.level === level);
}

// ------------------------------------------------------------------ Rank --

export interface RankTier {
  id: string;
  nameKey: string;
  /** Rank points at which this tier begins. */
  minPoints: number;
  divisions: number;
  color: number;
  /** Points awarded/deducted are scaled by this — higher tiers move slower. */
  volatility: number;
}

export const RANK_TIERS: readonly RankTier[] = [
  { id: 'unranked', nameKey: 'rank.unranked', minPoints: 0, divisions: 1, color: 0x6b7280, volatility: 1.4 },
  { id: 'iron', nameKey: 'rank.iron', minPoints: 100, divisions: 3, color: 0x8a7f74, volatility: 1.3 },
  { id: 'bronze', nameKey: 'rank.bronze', minPoints: 700, divisions: 3, color: 0xb1794a, volatility: 1.2 },
  { id: 'silver', nameKey: 'rank.silver', minPoints: 1300, divisions: 3, color: 0xa8b4c0, volatility: 1.1 },
  { id: 'gold', nameKey: 'rank.gold', minPoints: 1900, divisions: 3, color: 0xe0aa3e, volatility: 1.0 },
  { id: 'platinum', nameKey: 'rank.platinum', minPoints: 2500, divisions: 3, color: 0x53c3c8, volatility: 0.9 },
  { id: 'diamond', nameKey: 'rank.diamond', minPoints: 3200, divisions: 3, color: 0x6f8cf0, volatility: 0.8 },
  { id: 'ascendant', nameKey: 'rank.ascendant', minPoints: 4000, divisions: 3, color: 0x4ec97a, volatility: 0.7 },
  { id: 'titan', nameKey: 'rank.titan', minPoints: 4900, divisions: 1, color: 0xf0426e, volatility: 0.6 },
];

export interface RankInfo {
  tier: RankTier;
  division: number;
  points: number;
  pointsIntoDivision: number;
  pointsForNextDivision: number;
  progress: number;
  isMaxTier: boolean;
}

export function rankFromPoints(points: number): RankInfo {
  const p = Math.max(0, Math.floor(points));
  let tierIndex = 0;
  for (let i = RANK_TIERS.length - 1; i >= 0; i--) {
    if (p >= RANK_TIERS[i]!.minPoints) {
      tierIndex = i;
      break;
    }
  }
  const tier = RANK_TIERS[tierIndex]!;
  const next = RANK_TIERS[tierIndex + 1];
  const tierSpan = (next ? next.minPoints : tier.minPoints + 900) - tier.minPoints;
  const divisionSpan = tierSpan / tier.divisions;
  const into = p - tier.minPoints;
  const division = Math.min(tier.divisions, Math.floor(into / divisionSpan) + 1);
  const pointsIntoDivision = into - (division - 1) * divisionSpan;

  return {
    tier,
    division,
    points: p,
    pointsIntoDivision,
    pointsForNextDivision: divisionSpan,
    progress: divisionSpan > 0 ? pointsIntoDivision / divisionSpan : 1,
    isMaxTier: !next,
  };
}

/**
 * Rank points gained or lost from a ranked match.
 *
 * Uses an Elo-style expectation so beating a stronger lobby is worth more.
 * Individual performance nudges the result but can never turn a loss into a
 * gain — the mode is about winning, not padding stats.
 */
export function rankPointsDelta(
  won: boolean,
  playerPoints: number,
  averageOpponentPoints: number,
  performanceScore: number, // 0..2, 1 = average for the lobby
): number {
  const info = rankFromPoints(playerPoints);
  const expected = 1 / (1 + 10 ** ((averageOpponentPoints - playerPoints) / 600));
  const actual = won ? 1 : 0;
  const base = 32 * info.tier.volatility * (actual - expected);
  const perf = clamp(performanceScore, 0, 2);
  // Performance scales the magnitude, never the sign.
  const scaled = base * (0.7 + 0.3 * perf);
  const delta = Math.round(scaled);
  if (won) return Math.max(5, delta);
  return Math.min(-3, delta);
}

// ---------------------------------------------------------------- Season --

export interface SeasonDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  startsAt: number;
  endsAt: number;
  /** Season XP required per season level. */
  levelXp: number;
  maxSeasonLevel: number;
  /** Rewards keyed by season level. */
  rewards: { level: number; itemIds: string[]; coins: number; cores: number; premium: boolean }[];
  themeColor: number;
}

/**
 * Season 1. Dates are illustrative and configured by the operator at deploy
 * time via config/season.json — see docs/OPERATIONS.md.
 */
export const SEASONS: readonly SeasonDefinition[] = [
  {
    id: 'season_1',
    nameKey: 'season.s1.name',
    descriptionKey: 'season.s1.desc',
    startsAt: Date.UTC(2026, 0, 1),
    endsAt: Date.UTC(2026, 2, 31),
    levelXp: 1200,
    maxSeasonLevel: 50,
    themeColor: 0xf0a02a,
    rewards: [
      { level: 1, itemIds: [], coins: 200, cores: 0, premium: false },
      { level: 5, itemIds: ['skin_weapon_ember_line'], coins: 0, cores: 0, premium: false },
      { level: 10, itemIds: ['crate_standard'], coins: 400, cores: 5, premium: false },
      { level: 15, itemIds: ['emote_salute'], coins: 0, cores: 0, premium: false },
      { level: 20, itemIds: ['skin_char_ashline'], coins: 0, cores: 10, premium: true },
      { level: 30, itemIds: ['crate_premium'], coins: 800, cores: 10, premium: false },
      { level: 40, itemIds: ['charm_foundry'], coins: 0, cores: 0, premium: true },
      { level: 50, itemIds: ['skin_weapon_aurum'], coins: 2000, cores: 25, premium: false },
    ],
  },
];

export function activeSeason(now: number): SeasonDefinition | null {
  return SEASONS.find((s) => now >= s.startsAt && now <= s.endsAt) ?? SEASONS[SEASONS.length - 1] ?? null;
}
