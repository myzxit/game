/**
 * Store: rotation and purchasing.
 *
 * The rotation is *derived*, not stored: it is a pure function of
 * (section, period index, server seed). That means every player sees the same
 * daily store without the server persisting anything, and a purchase can be
 * re-priced from scratch at validation time — the client's claimed price is
 * never used.
 */

import {
  createLogger,
  Currency,
  ErrorCode,
  fail,
  getAttachment,
  getCharacter,
  getItem,
  getWeapon,
  hashString,
  ItemCategory,
  ITEMS,
  ATTACHMENTS,
  WEAPONS,
  CHARACTERS,
  levelFromTotalXp,
  mixSeeds,
  ok,
  Rng,
  SHOP_SECTIONS,
  RARITY_BASE_PRICE,
  ShopSection,
  utcDayIndex,
  utcWeekIndex,
  type Result,
} from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { EconomyService } from './EconomyService.js';
import type { InventoryService } from './InventoryService.js';

const log = createLogger('Shop');

export interface ShopEntry {
  itemId: string;
  section: ShopSection;
  currency: Currency;
  /** Price after any section discount. */
  price: number;
  basePrice: number;
  discountPercent: number;
  unlockLevel: number;
  /** Filled in per-player when the store is rendered. */
  owned?: boolean;
  purchasable?: boolean;
}

export class ShopService {
  constructor(
    private readonly economy: EconomyService,
    private readonly inventory: InventoryService,
    /** Server-wide seed, so the rotation differs between deployments. */
    private readonly serverSeed = hashString('titan-shop'),
  ) {}

  /** Period index for a section's rotation cadence. */
  private periodIndex(rotation: 'none' | 'daily' | 'weekly', now: number): number {
    if (rotation === 'daily') return utcDayIndex(now);
    if (rotation === 'weekly') return utcWeekIndex(now);
    return 0;
  }

  /**
   * The full catalogue for a section, before rotation is applied.
   * Weapons/attachments/characters come from their own config files (they have
   * balance data); cosmetics come from the item catalogue.
   */
  private catalogue(section: ShopSection): ShopEntry[] {
    const config = SHOP_SECTIONS.find((s) => s.section === section);
    if (!config) return [];

    const entries: ShopEntry[] = [];

    if (config.categories.includes(ItemCategory.Weapon)) {
      for (const w of WEAPONS) {
        if (w.price <= 0) continue;
        entries.push(this.entry(w.id, section, Currency.Coins, w.price, w.unlockLevel, config.discount));
      }
    }
    if (config.categories.includes(ItemCategory.Attachment)) {
      for (const a of ATTACHMENTS) {
        if (a.price <= 0) continue;
        entries.push(this.entry(a.id, section, Currency.Coins, a.price, a.unlockLevel, config.discount));
      }
    }
    if (config.categories.includes(ItemCategory.Character)) {
      for (const c of CHARACTERS) {
        if (c.price <= 0) continue;
        entries.push(this.entry(c.id, section, Currency.Coins, c.price, c.unlockLevel, config.discount));
      }
    }

    for (const item of ITEMS) {
      if (!config.categories.includes(item.category)) continue;
      if (!item.price) continue;
      entries.push(
        this.entry(item.id, section, item.price.currency, item.price.amount, item.unlockLevel, config.discount),
      );
    }

    return entries;
  }

  private entry(
    itemId: string,
    section: ShopSection,
    currency: Currency,
    basePrice: number,
    unlockLevel: number,
    discount: number,
  ): ShopEntry {
    const discountPercent = Math.round(discount * 100);
    return {
      itemId,
      section,
      currency,
      basePrice,
      price: Math.max(1, Math.round(basePrice * (1 - discount))),
      discountPercent,
      unlockLevel,
    };
  }

  /**
   * What is on sale in a section right now.
   * Rotating sections deterministically sample the catalogue.
   */
  sectionEntries(section: ShopSection, now = Date.now()): ShopEntry[] {
    const config = SHOP_SECTIONS.find((s) => s.section === section);
    if (!config) return [];

    const all = this.catalogue(section);
    if (config.slots <= 0 || all.length <= config.slots) return all;

    const seed = mixSeeds(this.serverSeed, hashString(section), this.periodIndex(config.rotation, now));
    return new Rng(seed).sample(all, config.slots);
  }

  /** The whole store, with per-player ownership and affordability filled in. */
  storefront(profile: PlayerProfile, now = Date.now()): Record<string, ShopEntry[]> {
    const level = levelFromTotalXp(profile.totalXp).level;
    const out: Record<string, ShopEntry[]> = {};

    for (const config of SHOP_SECTIONS) {
      out[config.section] = this.sectionEntries(config.section, now).map((e) => {
        const owned = this.inventory.owns(profile, e.itemId);
        return {
          ...e,
          owned,
          purchasable:
            !owned && level >= e.unlockLevel && this.economy.canAfford(profile, e.currency, e.price),
        };
      });
    }
    return out;
  }

  /** When the rotating sections next change. */
  nextRotationAt(now = Date.now()): { daily: number; weekly: number } {
    const day = utcDayIndex(now);
    const week = utcWeekIndex(now);
    return {
      daily: (day + 1) * 86_400_000,
      // Week index is offset by 4 days from the epoch (epoch was a Thursday).
      weekly: ((week + 1) * 7 - 4) * 86_400_000,
    };
  }

  /**
   * Purchase.
   *
   * The client tells us *what* it wants and which section it thinks the price
   * came from; we re-derive the price from the live rotation. A client claiming
   * a discounted section that isn't currently offering the item simply pays the
   * undiscounted price rather than being rejected.
   */
  purchase(
    profile: PlayerProfile,
    itemId: string,
    claimedSection: string,
    now = Date.now(),
  ): Result<ShopEntry> {
    if (this.inventory.owns(profile, itemId)) {
      return fail(ErrorCode.AlreadyOwned, `${profile.id} already owns ${itemId}`);
    }

    // Find the item in the live storefront. Search the claimed section first,
    // then every other section, so the best legitimate price wins.
    const sections = [
      claimedSection as ShopSection,
      ...SHOP_SECTIONS.map((s) => s.section).filter((s) => s !== claimedSection),
    ];

    let best: ShopEntry | null = null;
    for (const section of sections) {
      const entry = this.sectionEntries(section, now).find((e) => e.itemId === itemId);
      if (entry && (!best || entry.price < best.price)) best = entry;
    }

    if (!best) {
      return fail(ErrorCode.Unavailable, `${itemId} is not currently for sale`);
    }

    const level = levelFromTotalXp(profile.totalXp).level;
    if (level < best.unlockLevel) {
      return fail(ErrorCode.LevelRequirement, `${itemId} needs level ${best.unlockLevel}`, {
        level: best.unlockLevel,
      });
    }

    const spent = this.economy.spend(profile, best.currency, best.price, `shop:${itemId}`, now);
    if (!spent.ok) return spent;

    const granted = this.inventory.grant(profile, itemId);
    if (!granted.ok) {
      // Refund rather than take the money for nothing. This should be
      // unreachable — the item came from the catalogue — but a silent loss of
      // currency is the worst possible failure mode here.
      this.economy.grant(profile, best.currency, best.price, { reason: `refund:${itemId}` }, now);
      log.error('purchase granted nothing — refunded', { playerId: profile.id, itemId });
      return granted as Result<never>;
    }

    log.info('purchase', {
      playerId: profile.id,
      itemId,
      price: best.price,
      currency: best.currency,
    });
    return ok(best);
  }

  /**
   * Price sanity check, surfaced by the dev economy tool: every purchasable
   * thing should be within a reasonable band of its rarity's baseline.
   */
  auditPricing(): { itemId: string; price: number; expected: number; ratio: number }[] {
    const issues: { itemId: string; price: number; expected: number; ratio: number }[] = [];
    for (const item of ITEMS) {
      if (!item.price || item.price.currency !== Currency.Coins) continue;
      const expected = RARITY_BASE_PRICE[item.rarity] ?? 0;
      if (expected <= 0) continue;
      const ratio = item.price.amount / expected;
      if (ratio < 0.5 || ratio > 2) {
        issues.push({ itemId: item.id, price: item.price.amount, expected, ratio });
      }
    }
    return issues;
  }
}

/** Re-exported so the dev tools can list sections without importing config. */
export const SHOP_SECTION_IDS = SHOP_SECTIONS.map((s) => s.section);
