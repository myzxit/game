/**
 * Playable characters and their active skills.
 *
 * Design rule: characters change *how* you move and reposition, never how much
 * damage you deal. Health/shield differences are small and paired with a
 * movement cost, so no character is a straight upgrade and nothing here is
 * purchasable power (see `tests/balance.test.ts`).
 */

import { Rarity } from '../types/domain.js';

export enum SkillCategory {
  Offense = 'offense',
  Defense = 'defense',
  Mobility = 'mobility',
  Utility = 'utility',
}

export interface SkillDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  category: SkillCategory;
  cooldownMs: number;
  /** Energy cost; energy refills passively and on damage dealt. */
  energyCost: number;
  durationMs: number;
  /** Category-specific tuning, read by the matching SkillBehavior on the server. */
  params: Record<string, number>;
  /** Cosmetic/behavioural keys the client uses to pick VFX, sound and animation. */
  vfxKey: string;
  sfxKey: string;
  animationKey: string;
  unlockLevel: number;
  /** Upgrade tiers unlocked by using the skill; each is a modest tuning bump. */
  upgrades: SkillUpgrade[];
}

export interface SkillUpgrade {
  tier: number;
  requiredUses: number;
  descriptionKey: string;
  /** Multipliers applied to `params` / cooldown at this tier. */
  modifiers: Record<string, number>;
}

export const SKILLS: readonly SkillDefinition[] = [
  {
    id: 'skill_pulse_dash',
    nameKey: 'skill.pulse_dash.name',
    descriptionKey: 'skill.pulse_dash.desc',
    category: SkillCategory.Mobility,
    cooldownMs: 9000,
    energyCost: 25,
    durationMs: 220,
    params: { impulse: 15.5, verticalBoost: 1.2, iFrames: 0 },
    vfxKey: 'vfx.dash_trail',
    sfxKey: 'sfx.skill.dash',
    animationKey: 'anim.skill.dash',
    unlockLevel: 1,
    upgrades: [
      {
        tier: 1,
        requiredUses: 50,
        descriptionKey: 'skill.pulse_dash.up1',
        modifiers: { cooldownMs: 0.9 },
      },
      {
        tier: 2,
        requiredUses: 150,
        descriptionKey: 'skill.pulse_dash.up2',
        modifiers: { impulse: 1.1 },
      },
    ],
  },
  {
    id: 'skill_bulwark',
    nameKey: 'skill.bulwark.name',
    descriptionKey: 'skill.bulwark.desc',
    category: SkillCategory.Defense,
    cooldownMs: 22000,
    energyCost: 55,
    durationMs: 6000,
    // A deployable barrier: strong cover, but it is static and blocks your own fire.
    params: { shieldHp: 320, width: 2.6, height: 1.7, deployDistance: 2.2 },
    vfxKey: 'vfx.barrier_deploy',
    sfxKey: 'sfx.skill.barrier',
    animationKey: 'anim.skill.deploy',
    unlockLevel: 4,
    upgrades: [
      {
        tier: 1,
        requiredUses: 40,
        descriptionKey: 'skill.bulwark.up1',
        modifiers: { shieldHp: 1.15 },
      },
      {
        tier: 2,
        requiredUses: 120,
        descriptionKey: 'skill.bulwark.up2',
        modifiers: { durationMs: 1.2 },
      },
    ],
  },
  {
    id: 'skill_scan_pulse',
    nameKey: 'skill.scan_pulse.name',
    descriptionKey: 'skill.scan_pulse.desc',
    category: SkillCategory.Utility,
    cooldownMs: 18000,
    energyCost: 40,
    durationMs: 3500,
    // Reveals enemies on the minimap. Loud and visible, so it also announces you.
    params: { radius: 26, revealDurationMs: 3500 },
    vfxKey: 'vfx.scan_ring',
    sfxKey: 'sfx.skill.scan',
    animationKey: 'anim.skill.cast',
    unlockLevel: 7,
    upgrades: [
      {
        tier: 1,
        requiredUses: 40,
        descriptionKey: 'skill.scan_pulse.up1',
        modifiers: { radius: 1.15 },
      },
      {
        tier: 2,
        requiredUses: 110,
        descriptionKey: 'skill.scan_pulse.up2',
        modifiers: { cooldownMs: 0.85 },
      },
    ],
  },
  {
    id: 'skill_ion_charge',
    nameKey: 'skill.ion_charge.name',
    descriptionKey: 'skill.ion_charge.desc',
    category: SkillCategory.Offense,
    cooldownMs: 26000,
    energyCost: 65,
    durationMs: 800,
    // A thrown charge. Damage is capped below a full kill so it can't replace gunplay.
    params: { damage: 65, radius: 4.5, fuseMs: 1400, throwSpeed: 22 },
    vfxKey: 'vfx.ion_blast',
    sfxKey: 'sfx.skill.ion',
    animationKey: 'anim.skill.throw',
    unlockLevel: 10,
    upgrades: [
      {
        tier: 1,
        requiredUses: 45,
        descriptionKey: 'skill.ion_charge.up1',
        modifiers: { radius: 1.12 },
      },
      {
        tier: 2,
        requiredUses: 130,
        descriptionKey: 'skill.ion_charge.up2',
        modifiers: { fuseMs: 0.8 },
      },
    ],
  },
  {
    id: 'skill_phase_veil',
    nameKey: 'skill.phase_veil.name',
    descriptionKey: 'skill.phase_veil.desc',
    category: SkillCategory.Utility,
    cooldownMs: 24000,
    energyCost: 60,
    durationMs: 3200,
    // Heavy visual distortion rather than true invisibility, and you cannot fire.
    params: { opacity: 0.18, moveMultiplier: 1.1, blocksFiring: 1 },
    vfxKey: 'vfx.phase_shimmer',
    sfxKey: 'sfx.skill.phase',
    animationKey: 'anim.skill.cast',
    unlockLevel: 16,
    upgrades: [
      {
        tier: 1,
        requiredUses: 40,
        descriptionKey: 'skill.phase_veil.up1',
        modifiers: { durationMs: 1.15 },
      },
      {
        tier: 2,
        requiredUses: 120,
        descriptionKey: 'skill.phase_veil.up2',
        modifiers: { opacity: 0.8 },
      },
    ],
  },
  {
    id: 'skill_field_repair',
    nameKey: 'skill.field_repair.name',
    descriptionKey: 'skill.field_repair.desc',
    category: SkillCategory.Defense,
    cooldownMs: 20000,
    energyCost: 50,
    durationMs: 4000,
    // Heals over time and is interrupted by taking damage — rewards disengaging.
    params: { healPerSecond: 22, teamRadius: 5, interruptOnDamage: 1 },
    vfxKey: 'vfx.repair_field',
    sfxKey: 'sfx.skill.repair',
    animationKey: 'anim.skill.channel',
    unlockLevel: 13,
    upgrades: [
      {
        tier: 1,
        requiredUses: 40,
        descriptionKey: 'skill.field_repair.up1',
        modifiers: { healPerSecond: 1.15 },
      },
      {
        tier: 2,
        requiredUses: 120,
        descriptionKey: 'skill.field_repair.up2',
        modifiers: { teamRadius: 1.2 },
      },
    ],
  },
];

export interface CharacterDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  rarity: Rarity;
  /** Multipliers on the shared movement profile. */
  moveSpeedMultiplier: number;
  /** Additive health/shield, kept small and always paired with a movement cost. */
  healthBonus: number;
  shieldBonus: number;
  /** Skill this character starts with; players may equip any unlocked skill. */
  defaultSkillId: string;
  unlockLevel: number;
  price: number;
  /** Placeholder model key — see docs/ASSETS.md for the required art spec. */
  modelKey: string;
  /** Body proportions the client uses to build the placeholder model and hitboxes. */
  build: { height: number; shoulderWidth: number; accentColor: number };
  balanceNote: string;
}

export const CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'vanguard',
    nameKey: 'character.vanguard.name',
    descriptionKey: 'character.vanguard.desc',
    rarity: Rarity.Common,
    moveSpeedMultiplier: 1.0,
    healthBonus: 0,
    shieldBonus: 0,
    defaultSkillId: 'skill_pulse_dash',
    unlockLevel: 1,
    price: 0,
    modelKey: 'model.character.vanguard',
    build: { height: 1.8, shoulderWidth: 0.5, accentColor: 0x3f8ce8 },
    balanceNote: 'The reference character. Every stat is the baseline 1.0.',
  },
  {
    id: 'specter',
    nameKey: 'character.specter.name',
    descriptionKey: 'character.specter.desc',
    rarity: Rarity.Uncommon,
    moveSpeedMultiplier: 1.07,
    healthBonus: -10,
    shieldBonus: 0,
    defaultSkillId: 'skill_phase_veil',
    unlockLevel: 6,
    price: 4000,
    modelKey: 'model.character.specter',
    build: { height: 1.74, shoulderWidth: 0.44, accentColor: 0xa05ce8 },
    balanceNote: 'Faster but dies to one fewer bullet from most rifles. Flanker, not a duellist.',
  },
  {
    id: 'warden',
    nameKey: 'character.warden.name',
    descriptionKey: 'character.warden.desc',
    rarity: Rarity.Uncommon,
    moveSpeedMultiplier: 0.93,
    healthBonus: 0,
    shieldBonus: 20,
    defaultSkillId: 'skill_bulwark',
    unlockLevel: 9,
    price: 4000,
    modelKey: 'model.character.warden',
    build: { height: 1.86, shoulderWidth: 0.58, accentColor: 0xf0a02a },
    balanceNote: 'Extra shield, clearly slower. Holds ground; cannot rotate quickly.',
  },
  {
    id: 'surveyor',
    nameKey: 'character.surveyor.name',
    descriptionKey: 'character.surveyor.desc',
    rarity: Rarity.Rare,
    moveSpeedMultiplier: 1.02,
    healthBonus: -5,
    shieldBonus: 0,
    defaultSkillId: 'skill_scan_pulse',
    unlockLevel: 14,
    price: 6500,
    modelKey: 'model.character.surveyor',
    build: { height: 1.78, shoulderWidth: 0.48, accentColor: 0x4ec97a },
    balanceNote: 'Information character. Marginal stat changes; value comes entirely from the scan.',
  },
  {
    id: 'forge',
    nameKey: 'character.forge.name',
    descriptionKey: 'character.forge.desc',
    rarity: Rarity.Rare,
    moveSpeedMultiplier: 0.96,
    healthBonus: 10,
    shieldBonus: 0,
    defaultSkillId: 'skill_field_repair',
    unlockLevel: 20,
    price: 6500,
    modelKey: 'model.character.forge',
    build: { height: 1.82, shoulderWidth: 0.55, accentColor: 0xf0426e },
    balanceNote: 'Support. Slightly tankier and slower; the healing is the point.',
  },
];

const CHAR_BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));
const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

export const getCharacter = (id: string): CharacterDefinition | undefined => CHAR_BY_ID.get(id);
export const getSkill = (id: string): SkillDefinition | undefined => SKILL_BY_ID.get(id);

export const DEFAULT_CHARACTER_ID = 'vanguard';

/** Apply earned upgrade tiers to a skill's numbers. */
export function resolveSkill(skillId: string, uses: number): SkillDefinition | null {
  const base = getSkill(skillId);
  if (!base) return null;
  const earned = base.upgrades.filter((u) => uses >= u.requiredUses);
  if (earned.length === 0) return base;

  const params = { ...base.params };
  let cooldownMs = base.cooldownMs;
  let durationMs = base.durationMs;

  for (const up of earned) {
    for (const [key, mult] of Object.entries(up.modifiers)) {
      if (key === 'cooldownMs') cooldownMs *= mult;
      else if (key === 'durationMs') durationMs *= mult;
      else if (key in params) params[key] = params[key]! * mult;
    }
  }
  return { ...base, params, cooldownMs, durationMs };
}
