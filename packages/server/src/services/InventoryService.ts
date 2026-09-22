/**
 * Ownership and equipping.
 *
 * The server is the only thing that decides what a player owns. A client can
 * ask to equip anything; this service silently refuses to equip what isn't
 * owned and repairs the loadout instead of rejecting the whole thing — a
 * player whose skin was removed in an update should still spawn, not be stuck.
 */

import {
  cloneLoadout,
  createLogger,
  DEFAULT_LOADOUT,
  ErrorCode,
  fail,
  getAttachment,
  getCharacter,
  getItem,
  getSkill,
  getWeapon,
  ItemCategory,
  levelFromTotalXp,
  ok,
  type AttachmentSlot,
  type ItemDefinition,
  type Loadout,
  type Result,
} from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { ProfileService } from './ProfileService.js';

const log = createLogger('Inventory');

export type OwnableKind = 'weapon' | 'attachment' | 'character' | 'item' | 'title';

export function classify(id: string): OwnableKind | null {
  if (getWeapon(id)) return 'weapon';
  if (getAttachment(id)) return 'attachment';
  if (getCharacter(id)) return 'character';
  const item = getItem(id);
  if (item) return item.category === ItemCategory.Title ? 'title' : 'item';
  return null;
}

export class InventoryService {
  constructor(private readonly profiles: ProfileService) {}

  owns(profile: PlayerProfile, id: string): boolean {
    return (
      profile.ownedWeaponIds.includes(id) ||
      profile.ownedAttachmentIds.includes(id) ||
      profile.ownedCharacterIds.includes(id) ||
      profile.ownedItemIds.includes(id) ||
      profile.unlockedTitleIds.includes(id)
    );
  }

  /**
   * Add something to the player's collection.
   * Returns false when it was already owned (the caller turns that into a
   * duplicate conversion for crates, or a no-op for rewards).
   */
  grant(profile: PlayerProfile, id: string): Result<boolean> {
    const kind = classify(id);
    if (!kind) return fail(ErrorCode.NotFound, `unknown ownable id: ${id}`);
    if (this.owns(profile, id)) return ok(false);

    switch (kind) {
      case 'weapon':
        profile.ownedWeaponIds.push(id);
        break;
      case 'attachment':
        profile.ownedAttachmentIds.push(id);
        break;
      case 'character':
        profile.ownedCharacterIds.push(id);
        break;
      case 'title':
        profile.unlockedTitleIds.push(id);
        break;
      default:
        profile.ownedItemIds.push(id);
    }
    this.profiles.markDirty(profile.id);
    return ok(true);
  }

  grantMany(profile: PlayerProfile, ids: string[]): string[] {
    const granted: string[] = [];
    for (const id of ids) {
      const r = this.grant(profile, id);
      if (r.ok && r.value) granted.push(id);
      else if (!r.ok) log.warn('skipped unknown grant', { id, playerId: profile.id });
    }
    return granted;
  }

  /** Total distinct items owned — feeds the collector achievement. */
  collectionSize(profile: PlayerProfile): number {
    return (
      profile.ownedWeaponIds.length +
      profile.ownedAttachmentIds.length +
      profile.ownedCharacterIds.length +
      profile.ownedItemIds.length
    );
  }

  /** Is this level/unlock gate satisfied? */
  meetsUnlock(profile: PlayerProfile, id: string): boolean {
    const level = levelFromTotalXp(profile.totalXp).level;
    const weapon = getWeapon(id);
    if (weapon) return level >= weapon.unlockLevel;
    const attachment = getAttachment(id);
    if (attachment) return level >= attachment.unlockLevel;
    const character = getCharacter(id);
    if (character) return level >= character.unlockLevel;
    const item = getItem(id);
    if (item) return level >= item.unlockLevel;
    return true;
  }

  // ------------------------------------------------------------ equipping --

  /**
   * Apply a requested loadout, keeping only the parts the player actually owns
   * and that are legal. Always returns a loadout the player can spawn with.
   */
  applyLoadout(profile: PlayerProfile, requested: Loadout): Loadout {
    const current = profile.loadout;
    const result = cloneLoadout(current);

    const pickWeapon = (id: string, fallback: string): string => {
      const w = getWeapon(id);
      if (!w) return fallback;
      if (!profile.ownedWeaponIds.includes(id)) return fallback;
      if (!this.meetsUnlock(profile, id)) return fallback;
      return id;
    };

    result.primaryWeaponId = pickWeapon(requested.primaryWeaponId, current.primaryWeaponId);
    result.secondaryWeaponId = pickWeapon(requested.secondaryWeaponId, current.secondaryWeaponId);
    result.meleeWeaponId = pickWeapon(requested.meleeWeaponId, current.meleeWeaponId);

    const character = getCharacter(requested.characterId);
    result.characterId =
      character && profile.ownedCharacterIds.includes(requested.characterId)
        ? requested.characterId
        : current.characterId;

    // Skills unlock by level rather than purchase.
    const skill = getSkill(requested.skillId);
    const level = levelFromTotalXp(profile.totalXp).level;
    result.skillId = skill && level >= skill.unlockLevel ? requested.skillId : current.skillId;

    // Attachments: only owned ones, only in slots the weapon has.
    result.attachments = {};
    for (const [weaponId, slots] of Object.entries(requested.attachments ?? {})) {
      const weapon = getWeapon(weaponId);
      if (!weapon) continue;
      const kept: Partial<Record<AttachmentSlot, string>> = {};
      for (const [slot, attachmentId] of Object.entries(slots)) {
        const att = getAttachment(attachmentId);
        if (!att) continue;
        if (att.slot !== slot) continue;
        if (!weapon.attachmentSlots.includes(att.slot)) continue;
        if (!profile.ownedAttachmentIds.includes(attachmentId)) continue;
        if (!this.meetsUnlock(profile, attachmentId)) continue;
        kept[att.slot] = attachmentId;
      }
      if (Object.keys(kept).length > 0) result.attachments[weaponId] = kept;
    }

    // Skins are cosmetic, but still gated on ownership so they can't be spoofed.
    result.weaponSkins = {};
    for (const [weaponId, skinId] of Object.entries(requested.weaponSkins ?? {})) {
      if (!getWeapon(weaponId)) continue;
      const skin = getItem(skinId);
      if (!skin || skin.category !== ItemCategory.WeaponSkin) continue;
      if (!profile.ownedItemIds.includes(skinId)) continue;
      // A skin bound to a specific weapon may only go on that weapon.
      if (skin.appliesTo !== null && skin.appliesTo !== weaponId) continue;
      result.weaponSkins[weaponId] = skinId;
    }

    if (requested.characterSkinId) {
      const skin = getItem(requested.characterSkinId);
      const valid =
        skin &&
        skin.category === ItemCategory.CharacterSkin &&
        profile.ownedItemIds.includes(requested.characterSkinId) &&
        (skin.appliesTo === null || skin.appliesTo === result.characterId);
      result.characterSkinId = valid ? requested.characterSkinId : null;
    } else {
      result.characterSkinId = null;
    }

    profile.loadout = result;
    this.profiles.markDirty(profile.id);
    return result;
  }

  /** Equip a single item into its natural slot. */
  equip(profile: PlayerProfile, itemId: string, slot: string): Result<Loadout> {
    if (!this.owns(profile, itemId)) {
      return fail(ErrorCode.NotOwned, `${profile.id} does not own ${itemId}`);
    }
    if (!this.meetsUnlock(profile, itemId)) {
      return fail(ErrorCode.LevelRequirement, `${itemId} is level-locked`);
    }

    const next = cloneLoadout(profile.loadout);
    const weapon = getWeapon(itemId);
    const character = getCharacter(itemId);
    const item = getItem(itemId);

    if (weapon) {
      if (slot === 'primary') next.primaryWeaponId = itemId;
      else if (slot === 'secondary') next.secondaryWeaponId = itemId;
      else if (slot === 'melee') next.meleeWeaponId = itemId;
      else return fail(ErrorCode.Validation, `weapon cannot go in slot ${slot}`);
    } else if (character) {
      next.characterId = itemId;
      // A character skin bound to a different operator must come off.
      const skin = next.characterSkinId ? getItem(next.characterSkinId) : null;
      if (skin && skin.appliesTo !== null && skin.appliesTo !== itemId) {
        next.characterSkinId = null;
      }
    } else if (getSkill(itemId)) {
      next.skillId = itemId;
    } else if (item) {
      const applied = this.equipItem(next, item, slot);
      if (!applied.ok) return applied;
    } else {
      const attachment = getAttachment(itemId);
      if (!attachment) return fail(ErrorCode.NotFound, `unknown item ${itemId}`);
      const weaponId = slot; // for attachments the slot names the weapon
      const target = getWeapon(weaponId);
      if (!target) return fail(ErrorCode.Validation, `unknown weapon ${weaponId}`);
      if (!target.attachmentSlots.includes(attachment.slot)) {
        return fail(ErrorCode.Validation, `${weaponId} has no ${attachment.slot} slot`);
      }
      next.attachments[weaponId] = { ...next.attachments[weaponId], [attachment.slot]: itemId };
    }

    return ok(this.applyLoadout(profile, next));
  }

  private equipItem(next: Loadout, item: ItemDefinition, slot: string): Result<void> {
    switch (item.category) {
      case ItemCategory.WeaponSkin: {
        const weaponId = item.appliesTo ?? slot;
        if (!getWeapon(weaponId)) return fail(ErrorCode.Validation, `unknown weapon ${weaponId}`);
        next.weaponSkins[weaponId] = item.id;
        return ok(undefined);
      }
      case ItemCategory.CharacterSkin:
        if (item.appliesTo !== null && item.appliesTo !== next.characterId) {
          return fail(ErrorCode.Validation, `${item.id} does not fit ${next.characterId}`);
        }
        next.characterSkinId = item.id;
        return ok(undefined);
      default:
        return fail(ErrorCode.Validation, `${item.category} is not equippable here`);
    }
  }

  /** Titles live outside the loadout because they are a profile decoration. */
  equipTitle(profile: PlayerProfile, titleId: string | null): Result<void> {
    if (titleId === null) {
      profile.equippedTitleId = null;
      this.profiles.markDirty(profile.id);
      return ok(undefined);
    }
    if (!profile.unlockedTitleIds.includes(titleId)) {
      return fail(ErrorCode.NotOwned, `title ${titleId} not unlocked`);
    }
    profile.equippedTitleId = titleId;
    this.profiles.markDirty(profile.id);
    return ok(undefined);
  }

  /**
   * Re-validate the stored loadout. Run on login so a loadout that became
   * illegal (item removed from the game, unlock level raised) is repaired
   * before the player queues rather than failing at spawn.
   */
  sanitize(profile: PlayerProfile): Loadout {
    const repaired = this.applyLoadout(profile, profile.loadout);
    // Absolute floor: if even the default weapons are missing, restore them.
    if (!getWeapon(repaired.primaryWeaponId)) {
      profile.loadout = cloneLoadout(DEFAULT_LOADOUT);
      this.profiles.markDirty(profile.id);
      log.warn('loadout reset to default', { playerId: profile.id });
      return profile.loadout;
    }
    return repaired;
  }
}
