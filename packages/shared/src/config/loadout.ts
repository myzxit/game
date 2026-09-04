/**
 * Resolves a weapon + its attachments into the final stat block used by the
 * simulation. Both client and server run this so predicted and authoritative
 * shots agree exactly.
 */

import {
  getWeapon,
  type WeaponDefinition,
  type RecoilPattern,
  type SpreadProfile,
  AttachmentSlot,
} from './weapons.js';
import { getAttachment, type AttachmentModifiers } from './attachments.js';
import { clamp } from '../core/math.js';

export interface Loadout {
  primaryWeaponId: string;
  secondaryWeaponId: string;
  meleeWeaponId: string;
  /** attachment ids keyed by slot, per weapon id */
  attachments: Record<string, Partial<Record<AttachmentSlot, string>>>;
  characterId: string;
  skillId: string;
  /** Cosmetic only — must never alter a stat. */
  weaponSkins: Record<string, string>;
  characterSkinId: string | null;
}

/** A weapon definition with attachment modifiers already folded in. */
export interface ResolvedWeapon extends WeaponDefinition {
  readonly baseId: string;
  readonly appliedAttachments: string[];
  /** True when a suppressor-style attachment hides the shooter from the minimap. */
  readonly suppressed: boolean;
}

const mul = (base: number, m: number | undefined): number => (m === undefined ? base : base * m);

/**
 * Fold attachments into a weapon. Pure and side-effect free — the result is
 * cached by the caller (loadouts change rarely, this runs once per spawn).
 */
export function resolveWeapon(
  weaponId: string,
  attachmentIds: Partial<Record<AttachmentSlot, string>> = {},
): ResolvedWeapon | null {
  const w = getWeapon(weaponId);
  if (!w) return null;

  const applied: string[] = [];
  const mods: AttachmentModifiers[] = [];
  let suppressed = false;

  for (const slot of w.attachmentSlots) {
    const id = attachmentIds[slot];
    if (!id) continue;
    const att = getAttachment(id);
    // Silently ignore attachments the weapon can't take — a malformed loadout
    // from a client must degrade, never crash or grant an advantage.
    if (!att || att.slot !== slot) continue;
    if (att.allowedClasses.length > 0 && !att.allowedClasses.includes(w.class)) continue;
    applied.push(id);
    mods.push(att.modifiers);
    if (id === 'barrel_suppressor') suppressed = true;
  }

  if (mods.length === 0) {
    return { ...w, baseId: w.id, appliedAttachments: [], suppressed: false };
  }

  const acc = <K extends keyof AttachmentModifiers>(key: K): number | undefined => {
    let product: number | undefined;
    for (const m of mods) {
      const v = m[key];
      if (v === undefined) continue;
      product = (product ?? 1) * v;
    }
    return product;
  };

  const add = (key: 'magazineSizeAdd' | 'adsFovAdd'): number => {
    let sum = 0;
    for (const m of mods) sum += m[key] ?? 0;
    return sum;
  };

  const recoil: RecoilPattern = {
    ...w.recoil,
    vertical: mul(w.recoil.vertical, acc('recoilVertical')),
    horizontal: mul(w.recoil.horizontal, acc('recoilHorizontal')),
    recovery: mul(w.recoil.recovery, acc('recoilRecovery')),
  };

  const spread: SpreadProfile = {
    ...w.spread,
    base: mul(w.spread.base, acc('spreadBase')),
    perShot: mul(w.spread.perShot, acc('spreadPerShot')),
    max: Math.max(mul(w.spread.max, acc('spreadBase')), mul(w.spread.base, acc('spreadBase'))),
  };

  const falloffStart = mul(w.damageFalloffStart, acc('damageFalloffStart'));
  const falloffEnd = Math.max(falloffStart, mul(w.damageFalloffEnd, acc('damageFalloffEnd')));

  return {
    ...w,
    baseId: w.id,
    appliedAttachments: applied,
    suppressed,
    damage: mul(w.damage, acc('damage')),
    fireRate: mul(w.fireRate, acc('fireRate')),
    reloadTimeMs: mul(w.reloadTimeMs, acc('reloadTime')),
    reloadEmptyTimeMs: mul(w.reloadEmptyTimeMs, acc('reloadTime')),
    adsTimeMs: mul(w.adsTimeMs, acc('adsTime')),
    equipTimeMs: mul(w.equipTimeMs, acc('equipTime')),
    mobility: mul(w.mobility, acc('mobility')),
    adsMoveMultiplier: mul(w.adsMoveMultiplier, acc('adsMoveMultiplier')),
    magazineSize: Math.max(1, Math.round(w.magazineSize + add('magazineSizeAdd'))),
    adsFov: clamp(w.adsFov + add('adsFovAdd'), 12, 90),
    damageFalloffStart: falloffStart,
    damageFalloffEnd: falloffEnd,
    recoil,
    spread,
  };
}

export const DEFAULT_LOADOUT: Loadout = {
  primaryWeaponId: 'tr9_sentinel',
  secondaryWeaponId: 'sp1_ember',
  meleeWeaponId: 'rift_blade',
  attachments: {},
  characterId: 'vanguard',
  skillId: 'skill_pulse_dash',
  weaponSkins: {},
  characterSkinId: null,
};

export function cloneLoadout(l: Loadout): Loadout {
  return {
    ...l,
    attachments: Object.fromEntries(
      Object.entries(l.attachments).map(([k, v]) => [k, { ...v }]),
    ),
    weaponSkins: { ...l.weaponSkins },
  };
}
