/**
 * Core domain types shared across client, server and content config.
 */

import type { Vec3 } from '../core/math.js';

export type PlayerId = string;
export type MatchId = string;
export type PartyId = string;
export type ItemId = string;

export enum TeamId {
  None = 0,
  Alpha = 1,
  Bravo = 2,
}

export enum Rarity {
  Common = 'common',
  Uncommon = 'uncommon',
  Rare = 'rare',
  Epic = 'epic',
  Legendary = 'legendary',
  Mythic = 'mythic',
}

export const RARITY_ORDER: readonly Rarity[] = [
  Rarity.Common,
  Rarity.Uncommon,
  Rarity.Rare,
  Rarity.Epic,
  Rarity.Legendary,
  Rarity.Mythic,
];

/** Display colors, also used for VFX tinting and rarity beams. */
export const RARITY_COLOR: Record<Rarity, number> = {
  [Rarity.Common]: 0x9aa4b2,
  [Rarity.Uncommon]: 0x4ec97a,
  [Rarity.Rare]: 0x3f8ce8,
  [Rarity.Epic]: 0xa05ce8,
  [Rarity.Legendary]: 0xf0a02a,
  [Rarity.Mythic]: 0xf0426e,
};

export enum WeaponClass {
  AssaultRifle = 'assault_rifle',
  SMG = 'smg',
  Shotgun = 'shotgun',
  Sniper = 'sniper',
  Marksman = 'marksman',
  Pistol = 'pistol',
  Melee = 'melee',
  Special = 'special',
}

export enum FireMode {
  Auto = 'auto',
  Semi = 'semi',
  Burst = 'burst',
  BoltAction = 'bolt',
  Melee = 'melee',
}

export enum DamageType {
  Bullet = 'bullet',
  Explosive = 'explosive',
  Melee = 'melee',
  Energy = 'energy',
  Fall = 'fall',
  Environment = 'environment',
  Vehicle = 'vehicle',
}

export enum HitZone {
  Head = 'head',
  Chest = 'chest',
  Stomach = 'stomach',
  Limb = 'limb',
}

/** Surface material — drives impact VFX, decals, footsteps and bullet sounds. */
export enum SurfaceMaterial {
  Metal = 'metal',
  Concrete = 'concrete',
  Asphalt = 'asphalt',
  Wood = 'wood',
  Glass = 'glass',
  Brick = 'brick',
  Plastic = 'plastic',
  Fabric = 'fabric',
  Dirt = 'dirt',
  Grass = 'grass',
  Water = 'water',
  Flesh = 'flesh',
}

export enum ItemCategory {
  Weapon = 'weapon',
  WeaponSkin = 'weapon_skin',
  Character = 'character',
  CharacterSkin = 'character_skin',
  Vehicle = 'vehicle',
  VehicleSkin = 'vehicle_skin',
  Attachment = 'attachment',
  Consumable = 'consumable',
  Title = 'title',
  Emote = 'emote',
  Charm = 'charm',
  Crate = 'crate',
}

export enum Currency {
  /** Earned by playing. */
  Coins = 'coins',
  /** Premium/event currency. Never buys raw combat power (no pay-to-win). */
  Cores = 'cores',
}

export enum MovementState {
  Idle = 'idle',
  Walk = 'walk',
  Sprint = 'sprint',
  Crouch = 'crouch',
  Slide = 'slide',
  Air = 'air',
  Dash = 'dash',
}

export enum GameModeId {
  TeamDeathmatch = 'tdm',
  FreeForAll = 'ffa',
  Objective = 'objective',
  Elimination = 'elimination',
  Ranked = 'ranked',
}

export enum MatchPhase {
  Warmup = 'warmup',
  Countdown = 'countdown',
  Live = 'live',
  RoundEnd = 'round_end',
  MatchEnd = 'match_end',
}

/** An axis-aligned box. The map, cover, and hitboxes are all built from these. */
export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface Transform {
  position: Vec3;
  yaw: number;
  pitch: number;
}

export interface DamageEvent {
  attackerId: PlayerId | null;
  victimId: PlayerId;
  amount: number;
  /** Damage that actually reduced health, after shields absorbed their share. */
  healthDamage: number;
  shieldDamage: number;
  type: DamageType;
  zone: HitZone;
  weaponId: string | null;
  distance: number;
  lethal: boolean;
  timestamp: number;
}

export interface KillEvent {
  killerId: PlayerId | null;
  victimId: PlayerId;
  assistIds: PlayerId[];
  weaponId: string | null;
  zone: HitZone;
  distance: number;
  killStreak: number;
  multiKill: number;
  timestamp: number;
}
