/**
 * XP, levels, level rewards, season progress and rank.
 *
 * The client renders progress bars from the same pure curve functions in
 * `@titan/shared`, but only the server can *grant* XP. Every award routes
 * through `awardXp`, which handles level-up rewards and returns a summary the
 * connection layer turns into a ProgressionUpdate message.
 */

import {
  activeSeason,
  createLogger,
  Currency,
  ECONOMY,
  levelFromTotalXp,
  MAX_LEVEL,
  rankFromPoints,
  rankPointsDelta,
  rewardsForLevel,
  type SeasonDefinition,
} from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { EconomyService } from './EconomyService.js';
import type { InventoryService } from './InventoryService.js';
import type { ProfileService } from './ProfileService.js';

const log = createLogger('Progression');

export interface XpAward {
  amount: number;
  reason: string;
  /** Season XP, if this award also feeds the season track. */
  seasonXp?: number;
}

export interface ProgressionResult {
  totalXp: number;
  level: number;
  xpIntoLevel: number;
  xpForNext: number;
  /** Set when the award crossed at least one level boundary. */
  leveledUpTo: number | null;
  /** Levels crossed, in order — each may carry rewards. */
  levelsGained: number[];
  /** Items granted by level rewards. */
  itemsGranted: string[];
  coinsGranted: number;
  coresGranted: number;
  titlesGranted: string[];
  seasonLevel: number;
  seasonXp: number;
}

export class ProgressionService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly economy: EconomyService,
    private readonly inventory: InventoryService,
  ) {}

  /** Grant XP and resolve any level-ups it causes. */
  awardXp(profile: PlayerProfile, award: XpAward, now = Date.now()): ProgressionResult {
    const before = levelFromTotalXp(profile.totalXp);

    const amount = Math.max(0, Math.round(award.amount * ECONOMY.xpEarnMultiplier));
    profile.totalXp += amount;

    const seasonXp = Math.max(0, Math.round(award.seasonXp ?? 0));
    if (seasonXp > 0) this.addSeasonXp(profile, seasonXp, now);

    const after = levelFromTotalXp(profile.totalXp);
    const levelsGained: number[] = [];
    for (let l = before.level + 1; l <= after.level; l++) levelsGained.push(l);

    const itemsGranted: string[] = [];
    const titlesGranted: string[] = [];
    let coinsGranted = 0;
    let coresGranted = 0;

    for (const level of levelsGained) {
      const reward = rewardsForLevel(level);
      if (!reward) continue;
      // Idempotent: a level reward is only ever paid once, even if XP were
      // somehow re-applied.
      if (profile.claimedLevelRewards.includes(level)) continue;
      profile.claimedLevelRewards.push(level);

      if (reward.coins > 0) {
        const r = this.economy.grant(
          profile,
          Currency.Coins,
          reward.coins,
          { reason: `level_reward:${level}` },
          now,
        );
        if (r.ok) coinsGranted += r.value;
      }
      if (reward.cores > 0) {
        const r = this.economy.grant(
          profile,
          Currency.Cores,
          reward.cores,
          { reason: `level_reward:${level}` },
          now,
        );
        if (r.ok) coresGranted += r.value;
      }
      itemsGranted.push(...this.inventory.grantMany(profile, reward.itemIds));
      if (reward.titleKey) {
        const granted = this.inventory.grant(profile, reward.titleKey);
        if (granted.ok && granted.value) titlesGranted.push(reward.titleKey);
      }
    }

    if (levelsGained.length > 0) {
      log.info('level up', { playerId: profile.id, to: after.level, from: before.level });
    }

    this.profiles.markDirty(profile.id);

    return {
      totalXp: profile.totalXp,
      level: after.level,
      xpIntoLevel: after.xpIntoLevel,
      xpForNext: after.xpForNext,
      leveledUpTo: levelsGained.length > 0 ? after.level : null,
      levelsGained,
      itemsGranted,
      coinsGranted,
      coresGranted,
      titlesGranted,
      seasonLevel: this.seasonLevel(profile),
      seasonXp: profile.seasonXp,
    };
  }

  // ---------------------------------------------------------------- season --

  /** Reset season progress when a new season starts. */
  syncSeason(profile: PlayerProfile, now = Date.now()): SeasonDefinition | null {
    const season = activeSeason(now);
    if (!season) return null;
    if (profile.seasonId !== season.id) {
      log.info('season rollover', { playerId: profile.id, from: profile.seasonId, to: season.id });
      profile.seasonId = season.id;
      profile.seasonXp = 0;
      profile.claimedSeasonLevels = [];
      this.profiles.markDirty(profile.id);
    }
    return season;
  }

  private addSeasonXp(profile: PlayerProfile, amount: number, now: number): void {
    const season = this.syncSeason(profile, now);
    if (!season) return;
    const cap = season.levelXp * season.maxSeasonLevel;
    profile.seasonXp = Math.min(cap, profile.seasonXp + amount);
  }

  seasonLevel(profile: PlayerProfile, now = Date.now()): number {
    const season = activeSeason(now);
    if (!season || profile.seasonId !== season.id) return 0;
    return Math.min(season.maxSeasonLevel, Math.floor(profile.seasonXp / season.levelXp) + 1);
  }

  /** Claim a season track reward the player has reached and not yet taken. */
  claimSeasonReward(
    profile: PlayerProfile,
    seasonId: string,
    level: number,
    now = Date.now(),
  ): { itemsGranted: string[]; coins: number; cores: number } | null {
    const season = activeSeason(now);
    if (!season || season.id !== seasonId || profile.seasonId !== seasonId) return null;
    if (profile.claimedSeasonLevels.includes(level)) return null;
    if (this.seasonLevel(profile, now) < level) return null;

    const reward = season.rewards.find((r) => r.level === level);
    if (!reward) return null;
    // Premium track rewards require an entitlement this build cannot grant.
    // See docs/MONETIZATION.md — there is no payment provider configured, so a
    // premium reward is never claimable rather than silently free.
    if (reward.premium) return null;

    profile.claimedSeasonLevels.push(level);
    const itemsGranted = this.inventory.grantMany(profile, reward.itemIds);
    let coins = 0;
    let cores = 0;
    if (reward.coins > 0) {
      const r = this.economy.grant(profile, Currency.Coins, reward.coins, { reason: `season:${level}` }, now);
      if (r.ok) coins = r.value;
    }
    if (reward.cores > 0) {
      const r = this.economy.grant(profile, Currency.Cores, reward.cores, { reason: `season:${level}` }, now);
      if (r.ok) cores = r.value;
    }
    this.profiles.markDirty(profile.id);
    return { itemsGranted, coins, cores };
  }

  // ------------------------------------------------------------------ rank --

  /**
   * Apply the result of a ranked match.
   * `performanceScore` is 0..2 with 1 as the lobby average; it scales the size
   * of the change but can never flip its sign.
   */
  applyRankedResult(
    profile: PlayerProfile,
    won: boolean,
    averageOpponentPoints: number,
    performanceScore: number,
  ): { delta: number; from: string; to: string; promoted: boolean; demoted: boolean } {
    const before = rankFromPoints(profile.rankPoints);
    const delta = rankPointsDelta(won, profile.rankPoints, averageOpponentPoints, performanceScore);

    profile.rankPoints = Math.max(0, profile.rankPoints + delta);
    if (profile.placementsRemaining > 0) profile.placementsRemaining--;

    const after = rankFromPoints(profile.rankPoints);
    this.profiles.markDirty(profile.id);

    const fromLabel = `${before.tier.id}:${before.division}`;
    const toLabel = `${after.tier.id}:${after.division}`;
    const tierIndexBefore = before.tier.minPoints;
    const tierIndexAfter = after.tier.minPoints;

    return {
      delta,
      from: fromLabel,
      to: toLabel,
      promoted: tierIndexAfter > tierIndexBefore,
      demoted: tierIndexAfter < tierIndexBefore,
    };
  }

  level(profile: PlayerProfile): number {
    return levelFromTotalXp(profile.totalXp).level;
  }

  isMaxLevel(profile: PlayerProfile): boolean {
    return this.level(profile) >= MAX_LEVEL;
  }

  /** Snapshot for the ProgressionUpdate message. */
  snapshot(profile: PlayerProfile, now = Date.now()) {
    const progress = levelFromTotalXp(profile.totalXp);
    return {
      totalXp: profile.totalXp,
      level: progress.level,
      xpIntoLevel: progress.xpIntoLevel,
      xpForNext: progress.xpForNext,
      rankPoints: profile.rankPoints,
      seasonId: profile.seasonId,
      seasonXp: profile.seasonXp,
      seasonLevel: this.seasonLevel(profile, now),
    };
  }
}
