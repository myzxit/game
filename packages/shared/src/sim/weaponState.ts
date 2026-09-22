/**
 * Weapon runtime state machine.
 *
 * Shared so the client predicts firing, reloading and swapping locally (making
 * the trigger feel instant) while the server runs the identical machine as the
 * authority. Ammo counts are reconciled from server snapshots; the client never
 * decides how much ammo it has, only what it *expects* to have.
 */

import { FireMode } from '../types/domain.js';
import type { ResolvedWeapon } from '../config/loadout.js';
import { shotIntervalMs } from '../config/weapons.js';
import { addSpread, recoverSpread } from './ballistics.js';

export enum WeaponPhase {
  Ready = 'ready',
  Firing = 'firing',
  Reloading = 'reloading',
  Equipping = 'equipping',
  /** Bolt-action cycle between shots. */
  Cycling = 'cycling',
}

export interface WeaponRuntime {
  weaponId: string;
  phase: WeaponPhase;
  ammoInMag: number;
  reserveAmmo: number;
  /** ms until the next shot is allowed. */
  cooldownMs: number;
  /** ms remaining in the current reload/equip. */
  phaseTimeMs: number;
  /** Shots fired without releasing the trigger — drives recoil and spread. */
  shotIndex: number;
  /** Accumulated spread, in radians. */
  spread: number;
  /** ADS progress 0..1. */
  adsProgress: number;
  /** Remaining shots in the current burst. */
  burstRemaining: number;
  /** ms until the next shot of a burst. */
  burstTimerMs: number;
  /** Monotonic shot counter — the seed component that makes each shot unique. */
  totalShotsFired: number;
  /** True when the trigger was held on the previous step (for semi-auto gating). */
  triggerHeld: boolean;
}

export function createWeaponRuntime(w: ResolvedWeapon): WeaponRuntime {
  return {
    weaponId: w.id,
    phase: WeaponPhase.Equipping,
    ammoInMag: w.magazineSize,
    reserveAmmo: w.reserveAmmo,
    cooldownMs: 0,
    phaseTimeMs: w.equipTimeMs,
    shotIndex: 0,
    spread: 0,
    adsProgress: 0,
    burstRemaining: 0,
    burstTimerMs: 0,
    totalShotsFired: 0,
    triggerHeld: false,
  };
}

export interface WeaponStepInput {
  fire: boolean;
  aim: boolean;
  reload: boolean;
  deltaMs: number;
}

export interface WeaponStepResult {
  runtime: WeaponRuntime;
  /** Number of trigger pulls resolved this step (usually 0 or 1). */
  shotsFired: number;
  /** True if a reload completed this step — the client plays the "mag in" cue. */
  reloadCompleted: boolean;
  /** True if the weapon dry-fired (trigger pulled with an empty mag). */
  dryFired: boolean;
}

/**
 * Advance the weapon by `deltaMs`.
 *
 * Note: melee weapons have `magazineSize === 0` and are treated as having
 * infinite ammo; they simply respect the fire-rate cooldown.
 */
export function stepWeapon(
  prev: WeaponRuntime,
  w: ResolvedWeapon,
  input: WeaponStepInput,
): WeaponStepResult {
  const r: WeaponRuntime = { ...prev };
  const dtMs = Math.max(0, input.deltaMs);
  const dt = dtMs / 1000;
  let shotsFired = 0;
  let reloadCompleted = false;
  let dryFired = false;

  const infiniteAmmo = w.magazineSize <= 0;

  // ---- ADS ---------------------------------------------------------------
  // Reloading and equipping force the sights down.
  const canAim = r.phase !== WeaponPhase.Reloading && r.phase !== WeaponPhase.Equipping;
  const adsTarget = input.aim && canAim ? 1 : 0;
  const adsRate = w.adsTimeMs > 0 ? dtMs / w.adsTimeMs : 1;
  r.adsProgress =
    adsTarget > r.adsProgress
      ? Math.min(1, r.adsProgress + adsRate)
      : Math.max(0, r.adsProgress - adsRate);

  // ---- Timers ------------------------------------------------------------
  r.cooldownMs = Math.max(0, r.cooldownMs - dtMs);
  r.burstTimerMs = Math.max(0, r.burstTimerMs - dtMs);

  if (r.phase === WeaponPhase.Equipping || r.phase === WeaponPhase.Reloading) {
    r.phaseTimeMs -= dtMs;
    if (r.phaseTimeMs <= 0) {
      if (r.phase === WeaponPhase.Reloading) {
        const needed = w.magazineSize - r.ammoInMag;
        const taken = Math.min(needed, r.reserveAmmo);
        r.ammoInMag += taken;
        r.reserveAmmo -= taken;
        reloadCompleted = true;
      }
      r.phase = WeaponPhase.Ready;
      r.phaseTimeMs = 0;
    }
  }

  // ---- Spread recovery ---------------------------------------------------
  // Only recovers when not actively firing this step.
  if (!input.fire || r.cooldownMs > 0) {
    r.spread = recoverSpread(w, r.spread, dt);
    if (r.spread <= 0 && !input.fire) r.shotIndex = 0;
  }

  // ---- Reload request ----------------------------------------------------
  const wantsReload =
    !infiniteAmmo &&
    r.phase === WeaponPhase.Ready &&
    r.reserveAmmo > 0 &&
    r.ammoInMag < w.magazineSize &&
    (input.reload || (input.fire && r.ammoInMag <= 0));

  if (wantsReload) {
    r.phase = WeaponPhase.Reloading;
    r.phaseTimeMs = r.ammoInMag <= 0 ? w.reloadEmptyTimeMs : w.reloadTimeMs;
    r.burstRemaining = 0;
    r.triggerHeld = input.fire;
    return { runtime: r, shotsFired, reloadCompleted, dryFired };
  }

  if (r.phase !== WeaponPhase.Ready) {
    r.triggerHeld = input.fire;
    return { runtime: r, shotsFired, reloadCompleted, dryFired };
  }

  // ---- Burst continuation ------------------------------------------------
  if (r.burstRemaining > 0 && r.burstTimerMs <= 0) {
    if (infiniteAmmo || r.ammoInMag > 0) {
      shotsFired += consumeShot(r, w);
      r.burstRemaining--;
      r.burstTimerMs = w.burstDelayMs;
      if (r.burstRemaining > 0) {
        r.triggerHeld = input.fire;
        return { runtime: r, shotsFired, reloadCompleted, dryFired };
      }
      r.cooldownMs = shotIntervalMs(w);
    } else {
      r.burstRemaining = 0;
    }
  }

  // ---- New trigger pull --------------------------------------------------
  const isNewPress = input.fire && !r.triggerHeld;
  const allowedByFireMode =
    w.fireMode === FireMode.Auto ? input.fire : isNewPress;

  if (allowedByFireMode && r.cooldownMs <= 0 && r.burstRemaining === 0) {
    if (!infiniteAmmo && r.ammoInMag <= 0) {
      // Click. Only report a dry fire on the press edge so it doesn't spam.
      if (isNewPress) dryFired = true;
    } else if (w.fireMode === FireMode.Burst) {
      shotsFired += consumeShot(r, w);
      r.burstRemaining = w.burstCount - 1;
      r.burstTimerMs = w.burstDelayMs;
      if (r.burstRemaining <= 0) r.cooldownMs = shotIntervalMs(w);
    } else {
      shotsFired += consumeShot(r, w);
      r.cooldownMs = shotIntervalMs(w);
      if (w.fireMode === FireMode.BoltAction) {
        // The bolt cycle is modelled as the fire-rate cooldown; the client
        // plays the cycle animation over the same window.
        r.phase = WeaponPhase.Ready;
      }
    }
  }

  r.triggerHeld = input.fire;
  return { runtime: r, shotsFired, reloadCompleted, dryFired };
}

function consumeShot(r: WeaponRuntime, w: ResolvedWeapon): number {
  if (w.magazineSize > 0) r.ammoInMag = Math.max(0, r.ammoInMag - 1);
  r.shotIndex++;
  r.totalShotsFired++;
  r.spread = addSpread(w, r.spread);
  return 1;
}

/** Begin swapping to a different weapon. */
export function beginEquip(r: WeaponRuntime, next: ResolvedWeapon, carried: WeaponRuntime | null): WeaponRuntime {
  const base = carried ?? createWeaponRuntime(next);
  return {
    ...base,
    weaponId: next.id,
    phase: WeaponPhase.Equipping,
    phaseTimeMs: next.equipTimeMs,
    cooldownMs: 0,
    burstRemaining: 0,
    burstTimerMs: 0,
    spread: 0,
    shotIndex: 0,
    adsProgress: 0,
    triggerHeld: true, // require a fresh press after swapping
  };
}

export function isReloading(r: WeaponRuntime): boolean {
  return r.phase === WeaponPhase.Reloading;
}

/** Reload progress 0..1, for the HUD ring. */
export function reloadProgress(r: WeaponRuntime, w: ResolvedWeapon): number {
  if (r.phase !== WeaponPhase.Reloading) return 0;
  const total = r.ammoInMag <= 0 ? w.reloadEmptyTimeMs : w.reloadTimeMs;
  if (total <= 0) return 1;
  return 1 - Math.max(0, r.phaseTimeMs) / total;
}

/** Refill on respawn. */
export function resupply(r: WeaponRuntime, w: ResolvedWeapon): WeaponRuntime {
  return {
    ...r,
    ammoInMag: w.magazineSize,
    reserveAmmo: w.reserveAmmo,
    phase: WeaponPhase.Equipping,
    phaseTimeMs: w.equipTimeMs,
    spread: 0,
    shotIndex: 0,
    burstRemaining: 0,
    cooldownMs: 0,
  };
}
