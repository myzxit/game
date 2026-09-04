/**
 * Economy tuning.
 *
 * Kept in one place so the whole earn/spend balance can be reasoned about (and
 * simulated — see `tests/economy.test.ts`, which checks that a typical player
 * can afford a mid-tier weapon in a reasonable number of matches).
 */

import { Currency, ItemCategory, Rarity } from '../types/domain.js';

export interface EconomyConfig {
  /** Starting balance for a brand-new profile. */
  startingCoins: number;
  startingCores: number;

  /** Hard caps to bound the effect of any future exploit. */
  maxCoins: number;
  maxCores: number;
  /** A single grant larger than this is rejected and logged as suspicious. */
  maxSingleGrantCoins: number;
  maxSingleGrantCores: number;

  /** Multiplier applied to all coin earnings — the global economy dial. */
  coinEarnMultiplier: number;
  xpEarnMultiplier: number;

  /** Daily cap on coins from matches, to blunt bot farming. */
  dailyCoinCap: number;

  /** Refund fraction when selling back an owned cosmetic (0 = no selling). */
  sellbackRate: number;
}

export const ECONOMY: EconomyConfig = {
  startingCoins: 1000,
  startingCores: 0,
  maxCoins: 9_999_999,
  maxCores: 999_999,
  maxSingleGrantCoins: 50_000,
  maxSingleGrantCores: 500,
  coinEarnMultiplier: 1.0,
  xpEarnMultiplier: 1.0,
  dailyCoinCap: 25_000,
  sellbackRate: 0,
};

/** Baseline price by rarity, used to sanity-check the catalogue. */
export const RARITY_BASE_PRICE: Record<Rarity, number> = {
  [Rarity.Common]: 400,
  [Rarity.Uncommon]: 900,
  [Rarity.Rare]: 1800,
  [Rarity.Epic]: 3200,
  [Rarity.Legendary]: 6000,
  [Rarity.Mythic]: 12000,
};

// ------------------------------------------------------------------ Shop --

export enum ShopSection {
  Featured = 'featured',
  Daily = 'daily',
  Weapons = 'weapons',
  Attachments = 'attachments',
  Characters = 'characters',
  Cosmetics = 'cosmetics',
  Crates = 'crates',
  Event = 'event',
}

export interface ShopSectionConfig {
  section: ShopSection;
  nameKey: string;
  /** How many slots this section shows. 0 = show everything eligible. */
  slots: number;
  /** Rotates on this cadence. */
  rotation: 'none' | 'daily' | 'weekly';
  /** Categories eligible for this section. */
  categories: ItemCategory[];
  /** Discount applied to this section, 0..1. */
  discount: number;
}

export const SHOP_SECTIONS: readonly ShopSectionConfig[] = [
  {
    section: ShopSection.Featured,
    nameKey: 'shop.section.featured',
    slots: 4,
    rotation: 'weekly',
    categories: [ItemCategory.WeaponSkin, ItemCategory.CharacterSkin, ItemCategory.VehicleSkin],
    discount: 0.1,
  },
  {
    section: ShopSection.Daily,
    nameKey: 'shop.section.daily',
    slots: 6,
    rotation: 'daily',
    categories: [ItemCategory.WeaponSkin, ItemCategory.Charm, ItemCategory.Emote, ItemCategory.CharacterSkin],
    discount: 0,
  },
  {
    section: ShopSection.Weapons,
    nameKey: 'shop.section.weapons',
    slots: 0,
    rotation: 'none',
    categories: [ItemCategory.Weapon],
    discount: 0,
  },
  {
    section: ShopSection.Attachments,
    nameKey: 'shop.section.attachments',
    slots: 0,
    rotation: 'none',
    categories: [ItemCategory.Attachment],
    discount: 0,
  },
  {
    section: ShopSection.Characters,
    nameKey: 'shop.section.characters',
    slots: 0,
    rotation: 'none',
    categories: [ItemCategory.Character],
    discount: 0,
  },
  {
    section: ShopSection.Cosmetics,
    nameKey: 'shop.section.cosmetics',
    slots: 0,
    rotation: 'none',
    categories: [ItemCategory.WeaponSkin, ItemCategory.CharacterSkin, ItemCategory.Charm, ItemCategory.Emote],
    discount: 0,
  },
  {
    section: ShopSection.Crates,
    nameKey: 'shop.section.crates',
    slots: 0,
    rotation: 'none',
    categories: [ItemCategory.Crate],
    discount: 0,
  },
];

// --------------------------------------------------------- Premium tiers --
/**
 * Paid entitlements.
 *
 * IMPORTANT: this build ships **no payment integration**. These entries
 * describe what a store SKU would grant; `PurchaseService` refuses to grant any
 * of them unless a platform receipt is verified, and there is no verifier
 * configured. Nothing here can be bought in the current build — by design, not
 * by oversight. See docs/MONETIZATION.md.
 *
 * None of these grant combat power.
 */
export interface PremiumTier {
  id: string;
  nameKey: string;
  descriptionKey: string;
  /** Platform SKU, resolved by the (absent) payment provider. */
  sku: string;
  grants: {
    itemIds: string[];
    cores: number;
    /** Cosmetic-only conveniences. */
    perks: PremiumPerk[];
  };
}

export enum PremiumPerk {
  /** Cosmetic name colour in the killfeed and scoreboard. */
  NameColor = 'name_color',
  /** Extra loadout preset slots — convenience, not power. */
  ExtraLoadoutSlots = 'extra_loadout_slots',
  /** Season pass premium reward track. */
  SeasonPremiumTrack = 'season_premium_track',
  /** Profile badge. */
  ProfileBadge = 'profile_badge',
}

export const PREMIUM_TIERS: readonly PremiumTier[] = [
  {
    id: 'titan_pass',
    nameKey: 'premium.titan_pass.name',
    descriptionKey: 'premium.titan_pass.desc',
    sku: 'titan.season.pass',
    grants: {
      itemIds: [],
      cores: 30,
      perks: [PremiumPerk.SeasonPremiumTrack, PremiumPerk.ProfileBadge],
    },
  },
  {
    id: 'titan_vip',
    nameKey: 'premium.titan_vip.name',
    descriptionKey: 'premium.titan_vip.desc',
    sku: 'titan.vip',
    grants: {
      itemIds: ['title.veteran'],
      cores: 0,
      perks: [PremiumPerk.NameColor, PremiumPerk.ExtraLoadoutSlots, PremiumPerk.ProfileBadge],
    },
  },
];

export const getPremiumTier = (id: string): PremiumTier | undefined =>
  PREMIUM_TIERS.find((t) => t.id === id);

export const CURRENCY_ORDER: readonly Currency[] = [Currency.Coins, Currency.Cores];
