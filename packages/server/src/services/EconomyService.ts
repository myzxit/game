/**
 * Currency. Every grant and spend goes through here.
 *
 * The client never sends a balance — it sends an *intent* ("buy this item"),
 * and this service decides what that costs and whether it is affordable. Grants
 * are bounded by `ECONOMY.maxSingleGrant*`, so even a bug elsewhere cannot mint
 * an unbounded amount; an over-large grant is clamped and logged as suspicious.
 */

import {
  createLogger,
  Currency,
  ECONOMY,
  ErrorCode,
  fail,
  ok,
  utcDayIndex,
  type Result,
} from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { ProfileService } from './ProfileService.js';

const log = createLogger('Economy');

export interface GrantOptions {
  /** Match earnings count toward the daily anti-farming cap; rewards do not. */
  countsTowardDailyCap?: boolean;
  /** Free-text reason, recorded in the audit log. */
  reason: string;
}

export interface LedgerEntry {
  playerId: string;
  currency: Currency;
  delta: number;
  balanceAfter: number;
  reason: string;
  at: number;
}

export class EconomyService {
  /** Recent transactions, for operator inspection and abuse investigation. */
  private readonly ledger: LedgerEntry[] = [];
  private readonly ledgerLimit = 5000;

  constructor(private readonly profiles: ProfileService) {}

  balance(profile: PlayerProfile, currency: Currency): number {
    return profile.currencies[currency] ?? 0;
  }

  canAfford(profile: PlayerProfile, currency: Currency, amount: number): boolean {
    return this.balance(profile, currency) >= amount;
  }

  /**
   * Add currency. Returns the amount actually granted, which may be less than
   * requested if it would breach the balance cap or the daily cap.
   */
  grant(
    profile: PlayerProfile,
    currency: Currency,
    amount: number,
    options: GrantOptions,
    now = Date.now(),
  ): Result<number> {
    if (!Number.isFinite(amount) || amount < 0) {
      return fail(ErrorCode.Validation, `invalid grant amount ${amount}`);
    }
    if (amount === 0) return ok(0);

    const singleCap =
      currency === Currency.Coins ? ECONOMY.maxSingleGrantCoins : ECONOMY.maxSingleGrantCores;

    let granted = Math.floor(amount);
    if (granted > singleCap) {
      // A grant this large is either a bug or an exploit. Clamp and shout.
      log.error('grant exceeded the single-transaction cap — clamped', {
        playerId: profile.id,
        currency,
        requested: granted,
        cap: singleCap,
        reason: options.reason,
      });
      granted = singleCap;
    }

    // Daily cap applies only to coins earned from playing.
    if (options.countsTowardDailyCap && currency === Currency.Coins) {
      const day = utcDayIndex(now);
      if (profile.dailyCoinsDayIndex !== day) {
        profile.dailyCoinsDayIndex = day;
        profile.dailyCoinsEarned = 0;
      }
      const remaining = Math.max(0, ECONOMY.dailyCoinCap - profile.dailyCoinsEarned);
      granted = Math.min(granted, remaining);
      profile.dailyCoinsEarned += granted;
    }

    const balanceCap = currency === Currency.Coins ? ECONOMY.maxCoins : ECONOMY.maxCores;
    const before = this.balance(profile, currency);
    const after = Math.min(balanceCap, before + granted);
    const actual = after - before;

    profile.currencies[currency] = after;
    this.profiles.markDirty(profile.id);
    this.record({
      playerId: profile.id,
      currency,
      delta: actual,
      balanceAfter: after,
      reason: options.reason,
      at: now,
    });

    return ok(actual);
  }

  /** Deduct currency. Fails without mutating anything if unaffordable. */
  spend(
    profile: PlayerProfile,
    currency: Currency,
    amount: number,
    reason: string,
    now = Date.now(),
  ): Result<number> {
    if (!Number.isFinite(amount) || amount < 0) {
      return fail(ErrorCode.Validation, `invalid spend amount ${amount}`);
    }
    const cost = Math.floor(amount);
    const before = this.balance(profile, currency);
    if (before < cost) {
      return fail(ErrorCode.InsufficientFunds, `needs ${cost} ${currency}, has ${before}`);
    }

    const after = before - cost;
    profile.currencies[currency] = after;
    this.profiles.markDirty(profile.id);
    this.record({
      playerId: profile.id,
      currency,
      delta: -cost,
      balanceAfter: after,
      reason,
      at: now,
    });
    return ok(after);
  }

  /**
   * Spend several currencies at once, all-or-nothing.
   * Used by shop items priced in more than one currency.
   */
  spendMany(
    profile: PlayerProfile,
    costs: { currency: Currency; amount: number }[],
    reason: string,
    now = Date.now(),
  ): Result<void> {
    for (const c of costs) {
      if (!this.canAfford(profile, c.currency, c.amount)) {
        return fail(
          ErrorCode.InsufficientFunds,
          `needs ${c.amount} ${c.currency}, has ${this.balance(profile, c.currency)}`,
        );
      }
    }
    for (const c of costs) {
      const r = this.spend(profile, c.currency, c.amount, reason, now);
      // Affordability was checked for every cost above, so this cannot fail;
      // if it somehow does, surface it rather than half-charging the player.
      if (!r.ok) return r;
    }
    return ok(undefined);
  }

  private record(entry: LedgerEntry): void {
    this.ledger.push(entry);
    if (this.ledger.length > this.ledgerLimit) this.ledger.shift();
  }

  /** Recent transactions for a player, newest last. */
  history(playerId: string, limit = 50): LedgerEntry[] {
    return this.ledger.filter((e) => e.playerId === playerId).slice(-limit);
  }

  balances(profile: PlayerProfile): Record<Currency, number> {
    return {
      [Currency.Coins]: this.balance(profile, Currency.Coins),
      [Currency.Cores]: this.balance(profile, Currency.Cores),
    };
  }
}
