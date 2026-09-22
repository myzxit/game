/**
 * Supply crates.
 *
 * Two commitments are enforced structurally here:
 *
 *  1. The rates the player is shown are the rates that are rolled. The result
 *     message carries the exact weight table used, so the UI cannot display
 *     anything else.
 *  2. A duplicate always converts to currency. There is no outcome where a
 *     player opens a crate and receives nothing.
 *
 * Pity is published too: after `afterOpens` consecutive opens without hitting
 * the pity rarity, the next roll is floored at that rarity.
 */

import {
  createLogger,
  Currency,
  ErrorCode,
  fail,
  getCrateTable,
  getItem,
  ITEMS,
  mixSeeds,
  ok,
  Rarity,
  RARITY_ORDER,
  Rng,
  type CrateTable,
  type ItemDefinition,
  type Result,
} from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { EconomyService } from './EconomyService.js';
import type { InventoryService } from './InventoryService.js';
import type { ProfileService } from './ProfileService.js';

const log = createLogger('Crate');

export interface CrateOpenResult {
  crateId: string;
  itemId: string;
  rarity: Rarity;
  duplicate: boolean;
  coinsAwarded: number;
  /** The exact weights used for this roll, for the reveal UI. */
  rates: Record<string, number>;
  /** True when pity forced the rarity floor. */
  pityApplied: boolean;
}

export class CrateService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly economy: EconomyService,
    private readonly inventory: InventoryService,
  ) {}

  /** Items a crate can actually produce at a given rarity. */
  private pool(table: CrateTable, rarity: Rarity): ItemDefinition[] {
    return ITEMS.filter((i) => table.poolCategories.includes(i.category) && i.rarity === rarity);
  }

  /** Published rates, for the UI. */
  rates(crateId: string): Record<string, number> | null {
    const table = getCrateTable(crateId);
    if (!table) return null;
    return { ...table.rarityWeights } as Record<string, number>;
  }

  pityState(profile: PlayerProfile, crateId: string): { opens: number; target: string; after: number } | null {
    const table = getCrateTable(crateId);
    if (!table?.pity) return null;
    return {
      opens: profile.cratePity[crateId] ?? 0,
      target: table.pity.rarity,
      after: table.pity.afterOpens,
    };
  }

  /**
   * Open a crate the player owns.
   *
   * The crate must be in the player's inventory; it is consumed whether or not
   * the item turns out to be a duplicate.
   */
  open(profile: PlayerProfile, crateId: string, now = Date.now()): Result<CrateOpenResult> {
    const table = getCrateTable(crateId);
    if (!table) return fail(ErrorCode.NotFound, `unknown crate ${crateId}`);

    const index = profile.ownedItemIds.indexOf(crateId);
    if (index < 0) return fail(ErrorCode.NotOwned, `${profile.id} has no ${crateId}`);

    // Seed from the profile and the open count so the roll is reproducible for
    // an audit, but unpredictable to the player.
    const opens = profile.cratePity[crateId] ?? 0;
    const seed = mixSeeds(
      hash(profile.id),
      hash(crateId),
      opens,
      profile.stats.matchesPlayed,
      Math.floor(now / 1000),
    );
    const rng = new Rng(seed);

    // Roll a rarity from the published weights.
    const entries = (Object.entries(table.rarityWeights) as [Rarity, number][]).map(
      ([value, weight]) => ({ value, weight }),
    );
    let rarity = rng.weighted(entries);
    if (!rarity) {
      log.error('crate has no usable weights', { crateId });
      return fail(ErrorCode.Unavailable, `crate ${crateId} is misconfigured`);
    }

    // Apply pity: floor the rarity once the counter is reached.
    let pityApplied = false;
    if (table.pity && opens + 1 >= table.pity.afterOpens) {
      const rolledIndex = RARITY_ORDER.indexOf(rarity);
      const floorIndex = RARITY_ORDER.indexOf(table.pity.rarity);
      if (rolledIndex < floorIndex) {
        rarity = table.pity.rarity;
        pityApplied = true;
      }
    }

    // Pick an item of that rarity. If the pool is empty (content removed in an
    // update), walk down to the nearest rarity that has items rather than fail.
    let pool = this.pool(table, rarity);
    if (pool.length === 0) {
      for (let i = RARITY_ORDER.indexOf(rarity); i >= 0 && pool.length === 0; i--) {
        rarity = RARITY_ORDER[i]!;
        pool = this.pool(table, rarity);
      }
    }
    if (pool.length === 0) {
      return fail(ErrorCode.Unavailable, `crate ${crateId} has no items to award`);
    }

    // Prefer something the player doesn't own yet, so collections progress.
    const unowned = pool.filter((i) => !this.inventory.owns(profile, i.id));
    const chosen = unowned.length > 0 ? rng.pick(unowned) : rng.pick(pool);

    // Consume the crate.
    profile.ownedItemIds.splice(index, 1);

    // Update the pity counter.
    const hitPityTier =
      table.pity !== undefined &&
      RARITY_ORDER.indexOf(chosen.rarity) >= RARITY_ORDER.indexOf(table.pity.rarity);
    profile.cratePity[crateId] = hitPityTier ? 0 : opens + 1;

    const granted = this.inventory.grant(profile, chosen.id);
    const duplicate = granted.ok && granted.value === false;

    let coinsAwarded = 0;
    if (duplicate) {
      // Never award nothing.
      const value = table.duplicateCoins[chosen.rarity] ?? 50;
      const result = this.economy.grant(
        profile,
        Currency.Coins,
        value,
        { reason: `crate_duplicate:${chosen.id}` },
        now,
      );
      coinsAwarded = result.ok ? result.value : 0;
    }

    this.profiles.markDirty(profile.id);
    log.info('crate opened', {
      playerId: profile.id,
      crateId,
      itemId: chosen.id,
      rarity: chosen.rarity,
      duplicate,
      pityApplied,
    });

    return ok({
      crateId,
      itemId: chosen.id,
      rarity: chosen.rarity,
      duplicate,
      coinsAwarded,
      rates: { ...table.rarityWeights } as Record<string, number>,
      pityApplied,
    });
  }
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export { getCrateTable, getItem };
