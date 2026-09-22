/**
 * Weapon attachments.
 *
 * Every attachment is a genuine trade-off: each one carries at least one
 * negative modifier. `tests/balance.test.ts` enforces this so no attachment
 * becomes a mandatory pick.
 *
 * Modifiers are multiplicative against the base weapon stat, except the
 * `*Add` fields which are additive.
 */

import { AttachmentSlot } from './weapons.js';
import { Rarity } from '../types/domain.js';

export interface AttachmentModifiers {
  damage?: number;
  fireRate?: number;
  reloadTime?: number;
  adsTime?: number;
  mobility?: number;
  adsMoveMultiplier?: number;
  recoilVertical?: number;
  recoilHorizontal?: number;
  recoilRecovery?: number;
  spreadBase?: number;
  spreadPerShot?: number;
  damageFalloffStart?: number;
  damageFalloffEnd?: number;
  /** Additive change to magazine capacity. */
  magazineSizeAdd?: number;
  /** Additive change to the ADS field of view, in degrees (negative = more zoom). */
  adsFovAdd?: number;
  equipTime?: number;
}

export interface AttachmentDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  slot: AttachmentSlot;
  rarity: Rarity;
  unlockLevel: number;
  price: number;
  modifiers: AttachmentModifiers;
  /** Only these weapon classes may equip it; empty = all classes. */
  allowedClasses: string[];
  balanceNote: string;
}

export const ATTACHMENTS: readonly AttachmentDefinition[] = [
  // ---------------------------------------------------------------- Optics
  {
    id: 'optic_reflex',
    nameKey: 'attachment.optic_reflex.name',
    descriptionKey: 'attachment.optic_reflex.desc',
    slot: AttachmentSlot.Optic,
    rarity: Rarity.Common,
    unlockLevel: 2,
    price: 300,
    modifiers: { adsFovAdd: -3, adsTime: 1.05 },
    allowedClasses: [],
    balanceNote: 'Cleaner sight picture for a slightly slower ADS.',
  },
  {
    id: 'optic_longscope',
    nameKey: 'attachment.optic_longscope.name',
    descriptionKey: 'attachment.optic_longscope.desc',
    slot: AttachmentSlot.Optic,
    rarity: Rarity.Rare,
    unlockLevel: 14,
    price: 900,
    modifiers: { adsFovAdd: -14, adsTime: 1.25, mobility: 0.97 },
    allowedClasses: [],
    balanceNote: 'Heavy zoom; costs ADS speed and mobility, so it is a long-range-only pick.',
  },
  {
    id: 'optic_holo_wide',
    nameKey: 'attachment.optic_holo_wide.name',
    descriptionKey: 'attachment.optic_holo_wide.desc',
    slot: AttachmentSlot.Optic,
    rarity: Rarity.Uncommon,
    unlockLevel: 7,
    price: 600,
    modifiers: { adsFovAdd: 5, adsTime: 0.92, spreadBase: 1.08 },
    allowedClasses: [],
    balanceNote: 'Faster ADS and wide view for close range, at the cost of a looser cone.',
  },

  // --------------------------------------------------------------- Barrels
  {
    id: 'barrel_long',
    nameKey: 'attachment.barrel_long.name',
    descriptionKey: 'attachment.barrel_long.desc',
    slot: AttachmentSlot.Barrel,
    rarity: Rarity.Uncommon,
    unlockLevel: 6,
    price: 700,
    modifiers: {
      damageFalloffStart: 1.25,
      damageFalloffEnd: 1.2,
      mobility: 0.95,
      adsTime: 1.12,
    },
    allowedClasses: [],
    balanceNote: 'Extends effective range but makes the gun sluggish.',
  },
  {
    id: 'barrel_suppressor',
    nameKey: 'attachment.barrel_suppressor.name',
    descriptionKey: 'attachment.barrel_suppressor.desc',
    slot: AttachmentSlot.Barrel,
    rarity: Rarity.Rare,
    unlockLevel: 13,
    price: 1100,
    // Hides the shooter from the minimap (handled in MinimapService), at a real damage cost.
    modifiers: { damage: 0.94, damageFalloffStart: 0.9, recoilVertical: 0.92 },
    allowedClasses: [],
    balanceNote: 'Removes minimap reveal on fire. Pays for it with less damage and range.',
  },
  {
    id: 'barrel_compensator',
    nameKey: 'attachment.barrel_compensator.name',
    descriptionKey: 'attachment.barrel_compensator.desc',
    slot: AttachmentSlot.Barrel,
    rarity: Rarity.Uncommon,
    unlockLevel: 9,
    price: 750,
    modifiers: { recoilVertical: 0.8, recoilHorizontal: 1.15, adsTime: 1.06 },
    allowedClasses: [],
    balanceNote: 'Tames vertical climb but makes horizontal wander worse.',
  },

  // ---------------------------------------------------------------- Grips
  {
    id: 'grip_vertical',
    nameKey: 'attachment.grip_vertical.name',
    descriptionKey: 'attachment.grip_vertical.desc',
    slot: AttachmentSlot.Grip,
    rarity: Rarity.Common,
    unlockLevel: 4,
    price: 400,
    modifiers: { recoilVertical: 0.85, adsMoveMultiplier: 0.92 },
    allowedClasses: [],
    balanceNote: 'Recoil control in exchange for strafe speed while aiming.',
  },
  {
    id: 'grip_light',
    nameKey: 'attachment.grip_light.name',
    descriptionKey: 'attachment.grip_light.desc',
    slot: AttachmentSlot.Grip,
    rarity: Rarity.Uncommon,
    unlockLevel: 10,
    price: 650,
    modifiers: { adsTime: 0.88, mobility: 1.04, recoilHorizontal: 1.2 },
    allowedClasses: [],
    balanceNote: 'Aggressive-play grip: quicker to the shoulder, harder to hold on target.',
  },

  // ------------------------------------------------------------- Magazines
  {
    id: 'mag_extended',
    nameKey: 'attachment.mag_extended.name',
    descriptionKey: 'attachment.mag_extended.desc',
    slot: AttachmentSlot.Magazine,
    rarity: Rarity.Uncommon,
    unlockLevel: 5,
    price: 550,
    modifiers: { magazineSizeAdd: 10, reloadTime: 1.18, mobility: 0.97 },
    allowedClasses: [],
    balanceNote: 'More rounds per magazine, noticeably longer reload.',
  },
  {
    id: 'mag_quickdraw',
    nameKey: 'attachment.mag_quickdraw.name',
    descriptionKey: 'attachment.mag_quickdraw.desc',
    slot: AttachmentSlot.Magazine,
    rarity: Rarity.Rare,
    unlockLevel: 16,
    price: 950,
    modifiers: { reloadTime: 0.75, magazineSizeAdd: -4 },
    allowedClasses: [],
    balanceNote: 'Much faster reloads, smaller magazine — rewards accurate players.',
  },

  // ---------------------------------------------------------------- Stocks
  {
    id: 'stock_heavy',
    nameKey: 'attachment.stock_heavy.name',
    descriptionKey: 'attachment.stock_heavy.desc',
    slot: AttachmentSlot.Stock,
    rarity: Rarity.Common,
    unlockLevel: 3,
    price: 350,
    modifiers: { recoilRecovery: 1.3, spreadPerShot: 0.85, mobility: 0.93 },
    allowedClasses: [],
    balanceNote: 'Stability for a holding-angles playstyle; you move slower.',
  },
  {
    id: 'stock_skeletal',
    nameKey: 'attachment.stock_skeletal.name',
    descriptionKey: 'attachment.stock_skeletal.desc',
    slot: AttachmentSlot.Stock,
    rarity: Rarity.Uncommon,
    unlockLevel: 12,
    price: 700,
    modifiers: { mobility: 1.07, adsMoveMultiplier: 1.15, recoilVertical: 1.18 },
    allowedClasses: [],
    balanceNote: 'Movement-focused; recoil becomes noticeably harder to control.',
  },

  // -------------------------------------------------------------- Specials
  {
    id: 'special_ported_chamber',
    nameKey: 'attachment.special_ported_chamber.name',
    descriptionKey: 'attachment.special_ported_chamber.desc',
    slot: AttachmentSlot.Special,
    rarity: Rarity.Epic,
    unlockLevel: 22,
    price: 1600,
    modifiers: { fireRate: 1.12, damage: 0.93 },
    allowedClasses: [],
    balanceNote: 'Trades per-shot damage for rate of fire — changes breakpoints, not raw power.',
  },
  {
    id: 'special_focus_coil',
    nameKey: 'attachment.special_focus_coil.name',
    descriptionKey: 'attachment.special_focus_coil.desc',
    slot: AttachmentSlot.Special,
    rarity: Rarity.Epic,
    unlockLevel: 26,
    price: 1800,
    modifiers: { spreadBase: 0.7, spreadPerShot: 0.8, equipTime: 1.3, mobility: 0.94 },
    allowedClasses: [],
    balanceNote: 'Very tight cone; slow to bring up, so it punishes reactive swaps.',
  },
];

const BY_ID = new Map(ATTACHMENTS.map((a) => [a.id, a]));

export function getAttachment(id: string): AttachmentDefinition | undefined {
  return BY_ID.get(id);
}

export function attachmentsForSlot(slot: AttachmentSlot): AttachmentDefinition[] {
  return ATTACHMENTS.filter((a) => a.slot === slot);
}

/** Which modifier fields count as a downside when the value moves this way. */
const LOWER_IS_BETTER = new Set<keyof AttachmentModifiers>([
  'reloadTime',
  'adsTime',
  'recoilVertical',
  'recoilHorizontal',
  'spreadBase',
  'spreadPerShot',
  'equipTime',
]);

/**
 * True when the attachment carries at least one genuine downside.
 * Used by the balance test to keep every attachment a trade-off.
 */
export function hasDrawback(a: AttachmentDefinition): boolean {
  for (const [key, value] of Object.entries(a.modifiers) as [
    keyof AttachmentModifiers,
    number,
  ][]) {
    if (value === undefined) continue;
    if (key === 'magazineSizeAdd' || key === 'adsFovAdd') {
      // Additive fields: negative magazine size is a drawback; FOV is contextual.
      if (key === 'magazineSizeAdd' && value < 0) return true;
      continue;
    }
    if (LOWER_IS_BETTER.has(key) ? value > 1 : value < 1) return true;
  }
  return false;
}
