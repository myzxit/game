/**
 * Daily login streak.
 *
 * The streak advances once per UTC day and resets if a day is missed. The day
 * boundary is a pure function of the timestamp, so this is fully testable
 * without waiting for midnight.
 */

import {
  createLogger,
  Currency,
  ErrorCode,
  fail,
  LOGIN_REWARDS,
  ok,
  utcDayIndex,
  type Result,
} from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { EconomyService } from './EconomyService.js';
import type { InventoryService } from './InventoryService.js';
import type { ProfileService } from './ProfileService.js';
import type { ProgressionService } from './ProgressionService.js';

const log = createLogger('LoginReward');

export interface LoginState {
  streak: number;
  /** Day of the 28-day cycle the player is on (1-based). */
  cycleDay: number;
  rewardAvailable: boolean;
}

export interface LoginClaim {
  day: number;
  streak: number;
  coins: number;
  cores: number;
  xp: number;
  itemsGranted: string[];
}

export class LoginRewardService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly economy: EconomyService,
    private readonly inventory: InventoryService,
    private readonly progression: ProgressionService,
  ) {}

  /**
   * Register a login. Advances or resets the streak; does not pay out — the
   * player claims explicitly so the reward screen has something to show.
   */
  registerLogin(profile: PlayerProfile, now = Date.now()): LoginState {
    const today = utcDayIndex(now);

    if (profile.lastLoginDayIndex !== today) {
      if (profile.lastLoginDayIndex === today - 1) {
        profile.loginStreak += 1;
      } else {
        if (profile.loginStreak > 1) {
          log.info('login streak reset', { playerId: profile.id, was: profile.loginStreak });
        }
        profile.loginStreak = 1;
      }
      profile.lastLoginDayIndex = today;
      this.profiles.markDirty(profile.id);
    }

    return this.state(profile, now);
  }

  state(profile: PlayerProfile, now = Date.now()): LoginState {
    const today = utcDayIndex(now);
    const cycleDay = ((Math.max(1, profile.loginStreak) - 1) % LOGIN_REWARDS.length) + 1;
    return {
      streak: profile.loginStreak,
      cycleDay,
      rewardAvailable: profile.claimedLoginDayIndex !== today && profile.lastLoginDayIndex === today,
    };
  }

  claim(profile: PlayerProfile, now = Date.now()): Result<LoginClaim> {
    const today = utcDayIndex(now);
    if (profile.lastLoginDayIndex !== today) {
      // registerLogin must run first; this only happens on a malformed flow.
      return fail(ErrorCode.Conflict, 'login not registered for today');
    }
    if (profile.claimedLoginDayIndex === today) {
      return fail(ErrorCode.AlreadyOwned, 'login reward already claimed today');
    }

    const { cycleDay } = this.state(profile, now);
    const reward = LOGIN_REWARDS[cycleDay - 1];
    if (!reward) return fail(ErrorCode.NotFound, `no login reward for day ${cycleDay}`);

    // Mark claimed first: a payout failure must not become a repeatable claim.
    profile.claimedLoginDayIndex = today;

    const coins = this.economy.grant(
      profile,
      Currency.Coins,
      reward.coins,
      { reason: `login_day:${cycleDay}` },
      now,
    );
    const cores = this.economy.grant(
      profile,
      Currency.Cores,
      reward.cores,
      { reason: `login_day:${cycleDay}` },
      now,
    );
    const itemsGranted = this.inventory.grantMany(profile, reward.itemIds);
    if (reward.xp > 0) {
      this.progression.awardXp(profile, { amount: reward.xp, reason: `login_day:${cycleDay}` }, now);
    }

    this.profiles.markDirty(profile.id);
    return ok({
      day: cycleDay,
      streak: profile.loginStreak,
      coins: coins.ok ? coins.value : 0,
      cores: cores.ok ? cores.value : 0,
      xp: reward.xp,
      itemsGranted,
    });
  }

  /** The whole 28-day table, for the reward calendar UI. */
  calendar() {
    return LOGIN_REWARDS.map((r) => ({ ...r }));
  }
}
