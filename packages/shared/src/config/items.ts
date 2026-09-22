/**
 * Item catalogue: skins, cosmetics, crates, titles, emotes.
 *
 * Hard rule enforced by `tests/balance.test.ts`: no item in the catalogue may
 * carry a gameplay stat. Cosmetics are cosmetic. This is the structural reason
 * the game cannot become pay-to-win — there is nowhere to put the power.
 */

import { ItemCategory, Rarity, Currency } from '../types/domain.js';

export interface ItemDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  category: ItemCategory;
  rarity: Rarity;
  /** Which weapon/character/vehicle this skin applies to; null = universal. */
  appliesTo: string | null;
  /** Purchase price; null = not directly purchasable (crate/reward only). */
  price: { currency: Currency; amount: number } | null;
  /** Level gate for *purchasing*; cosmetics rewarded earlier ignore this. */
  unlockLevel: number;
  /** Visual keys the client resolves against the asset manifest. */
  visual: {
    /** Primary tint. */
    color: number;
    /** Secondary/accent tint. */
    accent: number;
    /** Named material treatment: matte, gloss, metallic, iridescent, emissive. */
    finish: 'matte' | 'gloss' | 'metallic' | 'iridescent' | 'emissive' | 'weathered';
    /** Optional texture key; missing textures fall back to the procedural finish. */
    textureKey?: string;
    /** Optional particle trail key for legendary+ items. */
    effectKey?: string;
  };
  /** Non-tradeable season/event exclusives. */
  seasonId?: string;
  eventId?: string;
  tradeable: boolean;
}

const skin = (
  id: string,
  appliesTo: string | null,
  category: ItemCategory,
  rarity: Rarity,
  color: number,
  accent: number,
  finish: ItemDefinition['visual']['finish'],
  amount: number,
  currency = Currency.Coins,
  effectKey?: string,
): ItemDefinition => ({
  id,
  nameKey: `item.${id}.name`,
  descriptionKey: `item.${id}.desc`,
  category,
  rarity,
  appliesTo,
  price: amount > 0 ? { currency, amount } : null,
  unlockLevel: 1,
  visual: { color, accent, finish, effectKey },
  tradeable: false,
});

export const ITEMS: readonly ItemDefinition[] = [
  // ------------------------------------------------------- Weapon skins --
  skin('skin_weapon_ashfall', 'tr9_sentinel', ItemCategory.WeaponSkin, Rarity.Rare, 0x3a3f46, 0xd8542a, 'weathered', 1800),
  skin('skin_weapon_ember_line', 'tr9_sentinel', ItemCategory.WeaponSkin, Rarity.Uncommon, 0x24282e, 0xff7a2a, 'gloss', 900),
  skin('skin_weapon_tidewash', 'vp4_hornet', ItemCategory.WeaponSkin, Rarity.Rare, 0x1c3a4a, 0x2ae0ff, 'gloss', 1800),
  skin('skin_weapon_dune', 'ak_ridgeline', ItemCategory.WeaponSkin, Rarity.Uncommon, 0xa8925e, 0x5c4a2a, 'matte', 900),
  skin('skin_weapon_frostbite', 'mk7_nightfall', ItemCategory.WeaponSkin, Rarity.Epic, 0xcfe6f0, 0x4f9fd0, 'iridescent', 3200, Currency.Coins),
  skin('skin_weapon_nightbloom', 'sk2_cinder', ItemCategory.WeaponSkin, Rarity.Epic, 0x2a1c3a, 0xff3d7a, 'iridescent', 3200),
  skin('skin_weapon_aurum', null, ItemCategory.WeaponSkin, Rarity.Legendary, 0xe0aa3e, 0xfff0c0, 'metallic', 0, Currency.Coins, 'vfx.trail_gold'),
  skin('skin_weapon_voidglass', 'arc9_tempest', ItemCategory.WeaponSkin, Rarity.Legendary, 0x160f26, 0x8a5cff, 'emissive', 0, Currency.Coins, 'vfx.trail_void'),

  // ---------------------------------------------------- Character skins --
  skin('skin_char_obsidian', 'vanguard', ItemCategory.CharacterSkin, Rarity.Epic, 0x1a1c22, 0x4f6fd0, 'gloss', 0),
  skin('skin_char_ashline', 'specter', ItemCategory.CharacterSkin, Rarity.Epic, 0x2e2436, 0xf0a02a, 'matte', 0),
  skin('skin_char_titan', 'warden', ItemCategory.CharacterSkin, Rarity.Mythic, 0x0e1018, 0xf0426e, 'emissive', 0, Currency.Coins, 'vfx.aura_titan'),
  skin('skin_char_surveyor_field', 'surveyor', ItemCategory.CharacterSkin, Rarity.Rare, 0x3d4a35, 0x9fd06a, 'weathered', 2200),
  skin('skin_char_forge_industrial', 'forge', ItemCategory.CharacterSkin, Rarity.Rare, 0x4a3a2a, 0xd88a3a, 'weathered', 2200),

  // ------------------------------------------------------ Vehicle skins --
  skin('skin_vehicle_ranger', 'scout_buggy', ItemCategory.VehicleSkin, Rarity.Uncommon, 0x4a5a3a, 0xd0c090, 'weathered', 1200),
  skin('skin_vehicle_pulse', 'scout_buggy', ItemCategory.VehicleSkin, Rarity.Epic, 0x141822, 0x2ae0ff, 'emissive', 3000),

  // ------------------------------------------------------------- Charms --
  skin('charm_foundry', null, ItemCategory.Charm, Rarity.Rare, 0xd88a3a, 0x3a3f46, 'metallic', 0),
  skin('charm_circuit', null, ItemCategory.Charm, Rarity.Uncommon, 0x2ae0ff, 0x1c2436, 'emissive', 700),

  // ------------------------------------------------------------ Titles --
  {
    id: 'title.operative',
    nameKey: 'title.operative',
    descriptionKey: 'title.operative.desc',
    category: ItemCategory.Title,
    rarity: Rarity.Common,
    appliesTo: null,
    price: null,
    unlockLevel: 10,
    visual: { color: 0x9aa4b2, accent: 0x9aa4b2, finish: 'matte' },
    tradeable: false,
  },
  {
    id: 'title.veteran',
    nameKey: 'title.veteran',
    descriptionKey: 'title.veteran.desc',
    category: ItemCategory.Title,
    rarity: Rarity.Uncommon,
    appliesTo: null,
    price: null,
    unlockLevel: 20,
    visual: { color: 0x4ec97a, accent: 0x4ec97a, finish: 'matte' },
    tradeable: false,
  },
  {
    id: 'title.specialist',
    nameKey: 'title.specialist',
    descriptionKey: 'title.specialist.desc',
    category: ItemCategory.Title,
    rarity: Rarity.Rare,
    appliesTo: null,
    price: null,
    unlockLevel: 40,
    visual: { color: 0x3f8ce8, accent: 0x3f8ce8, finish: 'matte' },
    tradeable: false,
  },
  {
    id: 'title.vanguard_elite',
    nameKey: 'title.vanguard_elite',
    descriptionKey: 'title.vanguard_elite.desc',
    category: ItemCategory.Title,
    rarity: Rarity.Epic,
    appliesTo: null,
    price: null,
    unlockLevel: 50,
    visual: { color: 0xa05ce8, accent: 0xa05ce8, finish: 'matte' },
    tradeable: false,
  },
  {
    id: 'title.titan',
    nameKey: 'title.titan',
    descriptionKey: 'title.titan.desc',
    category: ItemCategory.Title,
    rarity: Rarity.Mythic,
    appliesTo: null,
    price: null,
    unlockLevel: 100,
    visual: { color: 0xf0426e, accent: 0xf0426e, finish: 'emissive' },
    tradeable: false,
  },
  {
    id: 'title.archivist',
    nameKey: 'title.archivist',
    descriptionKey: 'title.archivist.desc',
    category: ItemCategory.Title,
    rarity: Rarity.Legendary,
    appliesTo: null,
    price: null,
    unlockLevel: 1,
    visual: { color: 0xf0a02a, accent: 0xf0a02a, finish: 'emissive' },
    tradeable: false,
  },

  // ------------------------------------------------------------ Emotes --
  skin('emote_salute', null, ItemCategory.Emote, Rarity.Common, 0x9aa4b2, 0xffffff, 'matte', 400),
  skin('emote_taunt', null, ItemCategory.Emote, Rarity.Uncommon, 0xf0a02a, 0xffffff, 'matte', 800),
  skin('emote_victory_pose', null, ItemCategory.Emote, Rarity.Rare, 0x4ec97a, 0xffffff, 'matte', 1400),

  // ------------------------------------------------------------ Crates --
  {
    id: 'crate_standard',
    nameKey: 'item.crate_standard.name',
    descriptionKey: 'item.crate_standard.desc',
    category: ItemCategory.Crate,
    rarity: Rarity.Uncommon,
    appliesTo: null,
    price: { currency: Currency.Coins, amount: 1500 },
    unlockLevel: 1,
    visual: { color: 0x4a5460, accent: 0x4ec97a, finish: 'metallic' },
    tradeable: false,
  },
  {
    id: 'crate_premium',
    nameKey: 'item.crate_premium.name',
    descriptionKey: 'item.crate_premium.desc',
    category: ItemCategory.Crate,
    rarity: Rarity.Epic,
    appliesTo: null,
    price: { currency: Currency.Cores, amount: 40 },
    unlockLevel: 1,
    visual: { color: 0x2a1c3a, accent: 0xa05ce8, finish: 'iridescent' },
    tradeable: false,
  },
  {
    id: 'crate_legendary',
    nameKey: 'item.crate_legendary.name',
    descriptionKey: 'item.crate_legendary.desc',
    category: ItemCategory.Crate,
    rarity: Rarity.Legendary,
    appliesTo: null,
    price: null,
    unlockLevel: 1,
    visual: { color: 0x3a2a10, accent: 0xf0a02a, finish: 'emissive' },
    tradeable: false,
  },
];

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

export const getItem = (id: string): ItemDefinition | undefined => BY_ID.get(id);

export function itemsByCategory(c: ItemCategory): ItemDefinition[] {
  return ITEMS.filter((i) => i.category === c);
}

/**
 * Crate contents with *published* drop rates.
 *
 * Rates are declared here in plain numbers and surfaced verbatim in the crate
 * UI (see client/ui/CratePanel). There is no hidden pity or weighting: the
 * numbers the player sees are the numbers the server rolls.
 */
export interface CrateTable {
  crateId: string;
  /** Chance per rarity; must sum to 1. */
  rarityWeights: Partial<Record<Rarity, number>>;
  /** Item pool, filtered by the rolled rarity. */
  poolCategories: ItemCategory[];
  /** Guaranteed minimum rarity after this many opens without one. */
  pity?: { rarity: Rarity; afterOpens: number };
  /** Duplicate protection: converts a duplicate into this many coins. */
  duplicateCoins: Partial<Record<Rarity, number>>;
}

export const CRATE_TABLES: readonly CrateTable[] = [
  {
    crateId: 'crate_standard',
    rarityWeights: {
      [Rarity.Common]: 0.55,
      [Rarity.Uncommon]: 0.29,
      [Rarity.Rare]: 0.12,
      [Rarity.Epic]: 0.035,
      [Rarity.Legendary]: 0.005,
    },
    poolCategories: [ItemCategory.WeaponSkin, ItemCategory.CharacterSkin, ItemCategory.Charm, ItemCategory.Emote],
    pity: { rarity: Rarity.Rare, afterOpens: 12 },
    duplicateCoins: {
      [Rarity.Common]: 60,
      [Rarity.Uncommon]: 150,
      [Rarity.Rare]: 400,
      [Rarity.Epic]: 900,
      [Rarity.Legendary]: 2400,
    },
  },
  {
    crateId: 'crate_premium',
    rarityWeights: {
      [Rarity.Uncommon]: 0.4,
      [Rarity.Rare]: 0.36,
      [Rarity.Epic]: 0.19,
      [Rarity.Legendary]: 0.045,
      [Rarity.Mythic]: 0.005,
    },
    poolCategories: [ItemCategory.WeaponSkin, ItemCategory.CharacterSkin, ItemCategory.VehicleSkin, ItemCategory.Charm],
    pity: { rarity: Rarity.Epic, afterOpens: 8 },
    duplicateCoins: {
      [Rarity.Uncommon]: 200,
      [Rarity.Rare]: 500,
      [Rarity.Epic]: 1200,
      [Rarity.Legendary]: 3000,
      [Rarity.Mythic]: 6000,
    },
  },
  {
    crateId: 'crate_legendary',
    rarityWeights: {
      [Rarity.Epic]: 0.6,
      [Rarity.Legendary]: 0.34,
      [Rarity.Mythic]: 0.06,
    },
    poolCategories: [ItemCategory.WeaponSkin, ItemCategory.CharacterSkin, ItemCategory.VehicleSkin],
    duplicateCoins: {
      [Rarity.Epic]: 1500,
      [Rarity.Legendary]: 3500,
      [Rarity.Mythic]: 7000,
    },
  },
];

export const getCrateTable = (crateId: string): CrateTable | undefined =>
  CRATE_TABLES.find((t) => t.crateId === crateId);
