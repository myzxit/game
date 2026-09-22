/**
 * Weapon definitions.
 *
 * All content is original to PROJECT TITAN. Balance intent is recorded next to
 * each weapon so future tuning passes know what role the gun is meant to fill;
 * every weapon must have a clear strength AND a clear weakness (see
 * `tests/balance.test.ts`, which enforces that no weapon dominates at all ranges).
 *
 * Damage model: `damage` is the base chest damage at or below `damageFalloffStart`
 * metres; it decays linearly to `damage * minDamageScale` at `damageFalloffEnd`.
 */

import { FireMode, WeaponClass, DamageType } from '../types/domain.js';

export interface RecoilPattern {
  /** Upward kick per shot, in radians. */
  vertical: number;
  /** Horizontal kick magnitude, in radians; sign alternates via the seeded RNG. */
  horizontal: number;
  /** How quickly the view returns to centre once firing stops (per second). */
  recovery: number;
  /** Multiplier applied to kick once the magazine is half empty (heat build-up). */
  climb: number;
  /** Recoil multiplier while aiming down sights. */
  adsMultiplier: number;
}

export interface SpreadProfile {
  /** Cone half-angle in radians while standing still and hip-firing. */
  base: number;
  /** Added per consecutive shot, up to `max`. */
  perShot: number;
  max: number;
  /** Cone shrink per second when not firing. */
  recovery: number;
  /** Multipliers for player state. */
  adsMultiplier: number;
  crouchMultiplier: number;
  movingMultiplier: number;
  airborneMultiplier: number;
}

export interface WeaponDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  class: WeaponClass;
  fireMode: FireMode;
  damageType: DamageType;

  /** Base chest damage. */
  damage: number;
  headshotMultiplier: number;
  limbMultiplier: number;
  stomachMultiplier: number;

  /** Rounds per minute. For melee, swings per minute. */
  fireRate: number;
  /** Shots per burst; only meaningful for FireMode.Burst. */
  burstCount: number;
  burstDelayMs: number;

  magazineSize: number;
  reserveAmmo: number;
  reloadTimeMs: number;
  /** Reload from empty (bolt/chamber cycle) — always >= reloadTimeMs. */
  reloadEmptyTimeMs: number;

  /** Metres. Beyond `damageFalloffEnd` the weapon still hits but at min damage. */
  damageFalloffStart: number;
  damageFalloffEnd: number;
  minDamageScale: number;
  /** Hard range limit for hitscan weapons. */
  maxRange: number;

  /** Pellets per trigger pull (shotguns). 1 for everything else. */
  pellets: number;

  /** If > 0, the weapon fires a simulated projectile at this speed (m/s) instead of hitscan. */
  projectileSpeed: number;
  projectileGravity: number;
  /** Splash radius in metres; 0 = no splash. */
  explosionRadius: number;

  recoil: RecoilPattern;
  spread: SpreadProfile;

  /** Movement speed multiplier while this weapon is equipped. */
  mobility: number;
  /** Movement speed multiplier while aiming down sights. */
  adsMoveMultiplier: number;
  adsTimeMs: number;
  /** FOV while aiming, in degrees. Lower = more zoom. */
  adsFov: number;
  equipTimeMs: number;

  /** Attachment slots this weapon accepts. */
  attachmentSlots: AttachmentSlot[];

  unlockLevel: number;
  /** Purchase price in coins; 0 = unlocked by default. */
  price: number;

  /** Designer note recording the intended role. Surfaced in the dev balance tool. */
  balanceNote: string;
}

export enum AttachmentSlot {
  Optic = 'optic',
  Barrel = 'barrel',
  Grip = 'grip',
  Magazine = 'magazine',
  Stock = 'stock',
  Special = 'special',
}

/** Shared spread/recoil presets keep numbers consistent between similar guns. */
const spread = (o: Partial<SpreadProfile>): SpreadProfile => ({
  base: 0.012,
  perShot: 0.0035,
  max: 0.075,
  recovery: 0.12,
  adsMultiplier: 0.25,
  crouchMultiplier: 0.8,
  movingMultiplier: 1.9,
  airborneMultiplier: 3.0,
  ...o,
});

const recoil = (o: Partial<RecoilPattern>): RecoilPattern => ({
  vertical: 0.011,
  horizontal: 0.005,
  recovery: 7.5,
  climb: 1.35,
  adsMultiplier: 0.75,
  ...o,
});

/** Fields every weapon shares, so each definition only states what differs. */
const base = {
  headshotMultiplier: 1.8,
  limbMultiplier: 0.85,
  stomachMultiplier: 1.0,
  burstCount: 1,
  burstDelayMs: 0,
  pellets: 1,
  projectileSpeed: 0,
  projectileGravity: 0,
  explosionRadius: 0,
  minDamageScale: 0.55,
  adsMoveMultiplier: 0.55,
  equipTimeMs: 400,
  unlockLevel: 1,
  price: 0,
  damageType: DamageType.Bullet,
};

export const WEAPONS: readonly WeaponDefinition[] = [
  // ---------------------------------------------------------------- Assault
  {
    ...base,
    id: 'tr9_sentinel',
    nameKey: 'weapon.tr9_sentinel.name',
    descriptionKey: 'weapon.tr9_sentinel.desc',
    class: WeaponClass.AssaultRifle,
    fireMode: FireMode.Auto,
    damage: 24,
    fireRate: 660,
    magazineSize: 30,
    reserveAmmo: 150,
    reloadTimeMs: 2100,
    reloadEmptyTimeMs: 2650,
    damageFalloffStart: 28,
    damageFalloffEnd: 55,
    maxRange: 300,
    recoil: recoil({ vertical: 0.0105, horizontal: 0.0045 }),
    spread: spread({ base: 0.011 }),
    mobility: 1.0,
    adsTimeMs: 240,
    adsFov: 55,
    attachmentSlots: [
      AttachmentSlot.Optic,
      AttachmentSlot.Barrel,
      AttachmentSlot.Grip,
      AttachmentSlot.Magazine,
      AttachmentSlot.Stock,
    ],
    balanceNote:
      'The baseline. Strong at mid range, no standout weakness but beaten by SMGs point-blank and by marksman rifles past 50m.',
  },
  {
    ...base,
    id: 'ak_ridgeline',
    nameKey: 'weapon.ak_ridgeline.name',
    descriptionKey: 'weapon.ak_ridgeline.desc',
    class: WeaponClass.AssaultRifle,
    fireMode: FireMode.Auto,
    damage: 31,
    fireRate: 520,
    magazineSize: 25,
    reserveAmmo: 125,
    reloadTimeMs: 2400,
    reloadEmptyTimeMs: 3000,
    damageFalloffStart: 32,
    damageFalloffEnd: 60,
    maxRange: 300,
    recoil: recoil({ vertical: 0.0165, horizontal: 0.0085, recovery: 6.0, climb: 1.6 }),
    spread: spread({ base: 0.014, perShot: 0.0045 }),
    mobility: 0.94,
    adsTimeMs: 290,
    adsFov: 55,
    attachmentSlots: [
      AttachmentSlot.Optic,
      AttachmentSlot.Barrel,
      AttachmentSlot.Grip,
      AttachmentSlot.Magazine,
      AttachmentSlot.Stock,
    ],
    unlockLevel: 8,
    price: 2400,
    balanceNote:
      'Hard-hitting 4-shot kill but punishing recoil and slow ADS. Rewards burst discipline; loses close-quarters scrambles.',
  },
  {
    ...base,
    id: 'vx3_lattice',
    nameKey: 'weapon.vx3_lattice.name',
    descriptionKey: 'weapon.vx3_lattice.desc',
    class: WeaponClass.AssaultRifle,
    fireMode: FireMode.Burst,
    damage: 27,
    burstCount: 3,
    burstDelayMs: 62,
    fireRate: 330, // bursts-per-minute pacing between bursts
    magazineSize: 30,
    reserveAmmo: 150,
    reloadTimeMs: 2200,
    reloadEmptyTimeMs: 2750,
    damageFalloffStart: 35,
    damageFalloffEnd: 62,
    maxRange: 300,
    headshotMultiplier: 1.9,
    recoil: recoil({ vertical: 0.009, horizontal: 0.003, recovery: 9.0 }),
    spread: spread({ base: 0.008, perShot: 0.002, adsMultiplier: 0.18 }),
    mobility: 0.97,
    adsTimeMs: 260,
    adsFov: 50,
    attachmentSlots: [
      AttachmentSlot.Optic,
      AttachmentSlot.Barrel,
      AttachmentSlot.Grip,
      AttachmentSlot.Magazine,
    ],
    unlockLevel: 15,
    price: 3200,
    balanceNote:
      'Precise 3-round burst, lethal at range with headshots. Fixed burst cadence means a missed burst is heavily punished up close.',
  },

  // -------------------------------------------------------------------- SMG
  {
    ...base,
    id: 'vp4_hornet',
    nameKey: 'weapon.vp4_hornet.name',
    descriptionKey: 'weapon.vp4_hornet.desc',
    class: WeaponClass.SMG,
    fireMode: FireMode.Auto,
    damage: 17,
    headshotMultiplier: 1.6,
    fireRate: 940,
    magazineSize: 32,
    reserveAmmo: 192,
    reloadTimeMs: 1750,
    reloadEmptyTimeMs: 2150,
    damageFalloffStart: 14,
    damageFalloffEnd: 30,
    minDamageScale: 0.42,
    maxRange: 200,
    recoil: recoil({ vertical: 0.008, horizontal: 0.007, recovery: 9.5, climb: 1.5 }),
    spread: spread({ base: 0.02, perShot: 0.003, max: 0.09, movingMultiplier: 1.25 }),
    mobility: 1.12,
    adsMoveMultiplier: 0.72,
    adsTimeMs: 170,
    adsFov: 62,
    attachmentSlots: [
      AttachmentSlot.Optic,
      AttachmentSlot.Barrel,
      AttachmentSlot.Grip,
      AttachmentSlot.Magazine,
      AttachmentSlot.Stock,
    ],
    balanceNote:
      'Fastest TTK inside 14m and barely slowed while strafing. Falls off a cliff past 30m — the intended counter is to hold angles.',
  },
  {
    ...base,
    id: 'sk2_cinder',
    nameKey: 'weapon.sk2_cinder.name',
    descriptionKey: 'weapon.sk2_cinder.desc',
    class: WeaponClass.SMG,
    fireMode: FireMode.Auto,
    damage: 21,
    headshotMultiplier: 1.55,
    fireRate: 760,
    magazineSize: 25,
    reserveAmmo: 150,
    reloadTimeMs: 1900,
    reloadEmptyTimeMs: 2300,
    damageFalloffStart: 18,
    damageFalloffEnd: 34,
    minDamageScale: 0.45,
    maxRange: 220,
    recoil: recoil({ vertical: 0.0095, horizontal: 0.0055, recovery: 8.5 }),
    spread: spread({ base: 0.017, perShot: 0.0028, movingMultiplier: 1.4 }),
    mobility: 1.08,
    adsMoveMultiplier: 0.68,
    adsTimeMs: 195,
    adsFov: 60,
    attachmentSlots: [
      AttachmentSlot.Optic,
      AttachmentSlot.Barrel,
      AttachmentSlot.Grip,
      AttachmentSlot.Magazine,
      AttachmentSlot.Stock,
    ],
    unlockLevel: 11,
    price: 2200,
    balanceNote:
      'The controlled SMG: less DPS than the Hornet but usable out to 34m. Small magazine punishes spraying through multiple enemies.',
  },

  // --------------------------------------------------------------- Shotgun
  {
    ...base,
    id: 'br12_fracture',
    nameKey: 'weapon.br12_fracture.name',
    descriptionKey: 'weapon.br12_fracture.desc',
    class: WeaponClass.Shotgun,
    fireMode: FireMode.Semi,
    damage: 13, // per pellet
    headshotMultiplier: 1.4,
    pellets: 9,
    fireRate: 78,
    magazineSize: 6,
    reserveAmmo: 36,
    reloadTimeMs: 2900,
    reloadEmptyTimeMs: 3300,
    damageFalloffStart: 7,
    damageFalloffEnd: 18,
    minDamageScale: 0.22,
    maxRange: 60,
    recoil: recoil({ vertical: 0.032, horizontal: 0.006, recovery: 5.0, climb: 1.0 }),
    spread: spread({ base: 0.055, perShot: 0.0, max: 0.055, adsMultiplier: 0.7 }),
    mobility: 0.9,
    adsMoveMultiplier: 0.6,
    adsTimeMs: 300,
    adsFov: 65,
    attachmentSlots: [AttachmentSlot.Optic, AttachmentSlot.Barrel, AttachmentSlot.Magazine],
    unlockLevel: 5,
    price: 1800,
    balanceNote:
      'One-shot potential under 7m. Slow fire rate and a 22% damage floor make it near-useless past 18m; hard-countered by open sightlines.',
  },

  // ---------------------------------------------------------------- Sniper
  {
    ...base,
    id: 'mk7_nightfall',
    nameKey: 'weapon.mk7_nightfall.name',
    descriptionKey: 'weapon.mk7_nightfall.desc',
    class: WeaponClass.Sniper,
    fireMode: FireMode.BoltAction,
    damage: 95,
    headshotMultiplier: 2.2,
    limbMultiplier: 0.75,
    stomachMultiplier: 0.95,
    fireRate: 46,
    magazineSize: 5,
    reserveAmmo: 25,
    reloadTimeMs: 3100,
    reloadEmptyTimeMs: 3600,
    damageFalloffStart: 150,
    damageFalloffEnd: 250,
    minDamageScale: 0.85,
    maxRange: 500,
    recoil: recoil({ vertical: 0.05, horizontal: 0.004, recovery: 4.0, climb: 1.0 }),
    spread: spread({ base: 0.09, perShot: 0.0, max: 0.09, adsMultiplier: 0.0, movingMultiplier: 1.0 }),
    mobility: 0.86,
    adsMoveMultiplier: 0.42,
    adsTimeMs: 420,
    adsFov: 22,
    attachmentSlots: [AttachmentSlot.Optic, AttachmentSlot.Barrel, AttachmentSlot.Stock, AttachmentSlot.Special],
    unlockLevel: 12,
    price: 3600,
    balanceNote:
      'Perfect accuracy when scoped and standing still; one-shot to the head at any range. Enormous hip-fire cone, slow ADS and bolt cycle make it helpless when rushed.',
  },
  {
    ...base,
    id: 'dm3_verdict',
    nameKey: 'weapon.dm3_verdict.name',
    descriptionKey: 'weapon.dm3_verdict.desc',
    class: WeaponClass.Marksman,
    fireMode: FireMode.Semi,
    damage: 52,
    headshotMultiplier: 2.0,
    fireRate: 240,
    magazineSize: 12,
    reserveAmmo: 72,
    reloadTimeMs: 2300,
    reloadEmptyTimeMs: 2800,
    damageFalloffStart: 70,
    damageFalloffEnd: 130,
    minDamageScale: 0.75,
    maxRange: 400,
    recoil: recoil({ vertical: 0.024, horizontal: 0.004, recovery: 6.5, climb: 1.15 }),
    spread: spread({ base: 0.03, perShot: 0.006, max: 0.06, adsMultiplier: 0.05 }),
    mobility: 0.92,
    adsTimeMs: 340,
    adsFov: 35,
    attachmentSlots: [
      AttachmentSlot.Optic,
      AttachmentSlot.Barrel,
      AttachmentSlot.Magazine,
      AttachmentSlot.Stock,
    ],
    unlockLevel: 18,
    price: 3000,
    balanceNote:
      'Two-shot body kill at long range with a semi-auto follow-up. Fire-rate cap means a missed shot loses the trade to any automatic weapon.',
  },

  // ---------------------------------------------------------------- Pistol
  {
    ...base,
    id: 'sp1_ember',
    nameKey: 'weapon.sp1_ember.name',
    descriptionKey: 'weapon.sp1_ember.desc',
    class: WeaponClass.Pistol,
    fireMode: FireMode.Semi,
    damage: 28,
    headshotMultiplier: 1.85,
    fireRate: 400,
    magazineSize: 15,
    reserveAmmo: 75,
    reloadTimeMs: 1500,
    reloadEmptyTimeMs: 1900,
    damageFalloffStart: 16,
    damageFalloffEnd: 34,
    minDamageScale: 0.5,
    maxRange: 150,
    recoil: recoil({ vertical: 0.013, horizontal: 0.005, recovery: 11.0 }),
    spread: spread({ base: 0.014, perShot: 0.006, max: 0.07, recovery: 0.2 }),
    mobility: 1.18,
    adsMoveMultiplier: 0.85,
    adsTimeMs: 140,
    adsFov: 63,
    equipTimeMs: 250,
    attachmentSlots: [AttachmentSlot.Optic, AttachmentSlot.Barrel, AttachmentSlot.Magazine],
    balanceNote:
      'Secondary. Fastest swap and best mobility in the game, so it wins the "reload caught me out" moment. Low sustained DPS.',
  },

  // ----------------------------------------------------------------- Melee
  {
    ...base,
    id: 'rift_blade',
    nameKey: 'weapon.rift_blade.name',
    descriptionKey: 'weapon.rift_blade.desc',
    class: WeaponClass.Melee,
    fireMode: FireMode.Melee,
    damageType: DamageType.Melee,
    damage: 72,
    headshotMultiplier: 1.0,
    limbMultiplier: 1.0,
    stomachMultiplier: 1.0,
    fireRate: 110,
    magazineSize: 0,
    reserveAmmo: 0,
    reloadTimeMs: 0,
    reloadEmptyTimeMs: 0,
    damageFalloffStart: 2.6,
    damageFalloffEnd: 2.8,
    minDamageScale: 0,
    maxRange: 2.8,
    recoil: recoil({ vertical: 0, horizontal: 0, recovery: 12 }),
    spread: spread({ base: 0, perShot: 0, max: 0, movingMultiplier: 1, airborneMultiplier: 1 }),
    mobility: 1.25,
    adsMoveMultiplier: 1.0,
    adsTimeMs: 0,
    adsFov: 75,
    equipTimeMs: 220,
    attachmentSlots: [AttachmentSlot.Special],
    balanceNote:
      'Highest movement speed in the game and a two-hit kill. Requires closing 2.8m with no ranged option — a commitment, not a crutch.',
  },

  // --------------------------------------------------------------- Special
  {
    ...base,
    id: 'arc9_tempest',
    nameKey: 'weapon.arc9_tempest.name',
    descriptionKey: 'weapon.arc9_tempest.desc',
    class: WeaponClass.Special,
    fireMode: FireMode.Semi,
    damageType: DamageType.Energy,
    damage: 46,
    headshotMultiplier: 1.3,
    fireRate: 180,
    magazineSize: 8,
    reserveAmmo: 24,
    reloadTimeMs: 2600,
    reloadEmptyTimeMs: 3100,
    damageFalloffStart: 40,
    damageFalloffEnd: 40,
    minDamageScale: 1.0, // energy bolts do not fall off...
    maxRange: 120,
    projectileSpeed: 78, // ...but they travel slowly and must be led
    projectileGravity: 1.5,
    explosionRadius: 2.4,
    recoil: recoil({ vertical: 0.02, horizontal: 0.003, recovery: 6.0 }),
    spread: spread({ base: 0.006, perShot: 0.004, max: 0.03 }),
    mobility: 0.9,
    adsTimeMs: 320,
    adsFov: 58,
    attachmentSlots: [AttachmentSlot.Optic, AttachmentSlot.Special],
    unlockLevel: 25,
    price: 5000,
    balanceNote:
      'No damage falloff and 2.4m splash punishes grouped enemies. Slow travelling projectile means every shot at range must be led — free to dodge if you strafe.',
  },
];

const WEAPON_BY_ID = new Map(WEAPONS.map((w) => [w.id, w]));

export function getWeapon(id: string): WeaponDefinition | undefined {
  return WEAPON_BY_ID.get(id);
}

/** Throws — for internal call sites where a missing weapon is a bug, not user input. */
export function requireWeapon(id: string): WeaponDefinition {
  const w = WEAPON_BY_ID.get(id);
  if (!w) throw new Error(`Unknown weapon id: ${id}`);
  return w;
}

export function weaponsByClass(cls: WeaponClass): WeaponDefinition[] {
  return WEAPONS.filter((w) => w.class === cls);
}

/** Weapons available with no purchase or unlock — the new-player loadout pool. */
export const STARTER_WEAPON_IDS = WEAPONS.filter((w) => w.price === 0 && w.unlockLevel <= 1).map(
  (w) => w.id,
);

/** Seconds between shots, derived from RPM. */
export function shotIntervalMs(w: WeaponDefinition): number {
  return 60000 / Math.max(1, w.fireRate);
}

/**
 * Theoretical time-to-kill in ms against a full-health, unshielded target at
 * `distance`. Used by the balance tests and the dev balance tool.
 */
export function timeToKill(
  w: WeaponDefinition,
  distance: number,
  totalHealth = 100,
  headshotRatio = 0,
): number {
  const perPellet = damageAtRange(w, distance);
  const multiplier = 1 + headshotRatio * (w.headshotMultiplier - 1);
  const perShot = perPellet * w.pellets * multiplier;
  if (perShot <= 0) return Infinity;
  const shots = Math.ceil(totalHealth / perShot);
  if (w.fireMode === FireMode.Burst) {
    const bursts = Math.ceil(shots / w.burstCount);
    const withinBurst = Math.min(shots, w.burstCount) - 1;
    return (bursts - 1) * shotIntervalMs(w) + withinBurst * w.burstDelayMs;
  }
  return (shots - 1) * shotIntervalMs(w);
}

/** Linear damage falloff between `damageFalloffStart` and `damageFalloffEnd`. */
export function damageAtRange(w: WeaponDefinition, distance: number): number {
  if (distance > w.maxRange) return 0;
  if (distance <= w.damageFalloffStart) return w.damage;
  if (distance >= w.damageFalloffEnd) return w.damage * w.minDamageScale;
  const t = (distance - w.damageFalloffStart) / (w.damageFalloffEnd - w.damageFalloffStart);
  return w.damage * (1 - t * (1 - w.minDamageScale));
}
