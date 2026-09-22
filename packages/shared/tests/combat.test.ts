import { describe, it, expect } from 'vitest';
import {
  CollisionWorld,
  computeShotRays,
  computeRecoil,
  currentSpread,
  computeDamage,
  damageAtRange,
  explosionDamage,
  addSpread,
  recoverSpread,
  resolveWeapon,
  requireWeapon,
  raycastHitboxes,
  buildHitboxes,
  createWeaponRuntime,
  stepWeapon,
  WeaponPhase,
  createProjectile,
  stepProjectile,
  HitZone,
  MovementState,
  SurfaceMaterial,
  FireMode,
  vec3,
  v3normalize,
  anglesToForward,
  shotIntervalMs,
  type ShotContext,
  type ResolvedWeapon,
  PLAYER_HEIGHT_STAND,
} from '../src/index.js';

const rifle = (): ResolvedWeapon => resolveWeapon('tr9_sentinel')!;
const shotgun = (): ResolvedWeapon => resolveWeapon('br12_fracture')!;
const sniper = (): ResolvedWeapon => resolveWeapon('mk7_nightfall')!;

const ctx = (o: Partial<ShotContext> = {}): ShotContext => ({
  origin: vec3(0, 1.6, 0),
  yaw: 0,
  pitch: 0,
  spreadAccum: 0,
  isAiming: false,
  isCrouching: false,
  isMoving: false,
  isAirborne: false,
  seed: 12345,
  ...o,
});

describe('ballistics — spread', () => {
  it('aiming, crouching and moving modify the cone in the expected directions', () => {
    const w = rifle();
    const base = currentSpread(w, ctx());
    expect(currentSpread(w, ctx({ isAiming: true }))).toBeLessThan(base);
    expect(currentSpread(w, ctx({ isCrouching: true }))).toBeLessThan(base);
    expect(currentSpread(w, ctx({ isMoving: true }))).toBeGreaterThan(base);
    expect(currentSpread(w, ctx({ isAirborne: true }))).toBeGreaterThan(base);
  });

  it('accumulates per shot up to the weapon maximum', () => {
    const w = rifle();
    let s = 0;
    for (let i = 0; i < 200; i++) s = addSpread(w, s);
    expect(s).toBe(w.spread.max);
  });

  it('recovers toward zero over time and never goes negative', () => {
    const w = rifle();
    const s = recoverSpread(w, 0.01, 10);
    expect(s).toBe(0);
  });

  it('produces the same rays for the same seed, and different for a different seed', () => {
    const w = rifle();
    const a = computeShotRays(w, ctx({ seed: 999, spreadAccum: 0.02 }));
    const b = computeShotRays(w, ctx({ seed: 999, spreadAccum: 0.02 }));
    const c = computeShotRays(w, ctx({ seed: 1000, spreadAccum: 0.02 }));

    expect(a).toEqual(b);
    expect(a[0]!.direction).not.toEqual(c[0]!.direction);
  });

  it('fires exactly one ray for a rifle and one per pellet for a shotgun', () => {
    expect(computeShotRays(rifle(), ctx())).toHaveLength(1);
    expect(computeShotRays(shotgun(), ctx())).toHaveLength(shotgun().pellets);
  });

  it('a zero-spread shot goes exactly where the player is aiming', () => {
    const w = sniper();
    // Scoped snipers have adsMultiplier 0 — pinpoint accuracy.
    const rays = computeShotRays(w, ctx({ isAiming: true, yaw: 0.4, pitch: 0.2 }));
    const expected = anglesToForward(0.4, 0.2);
    expect(rays[0]!.direction.x).toBeCloseTo(expected.x, 6);
    expect(rays[0]!.direction.y).toBeCloseTo(expected.y, 6);
    expect(rays[0]!.direction.z).toBeCloseTo(expected.z, 6);
  });

  it('all rays remain unit vectors', () => {
    for (const ray of computeShotRays(shotgun(), ctx({ spreadAccum: 0.05 }))) {
      const len = Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z);
      expect(len).toBeCloseTo(1, 6);
    }
  });
});

describe('ballistics — recoil', () => {
  it('kicks the view upward and is reduced while aiming', () => {
    const w = rifle();
    const hip = computeRecoil(w, 0, false, 1);
    const ads = computeRecoil(w, 0, true, 1);
    expect(hip.pitch).toBeGreaterThan(0);
    expect(ads.pitch).toBeLessThan(hip.pitch);
  });

  it('climbs as the magazine empties', () => {
    const w = rifle();
    const first = computeRecoil(w, 0, false, 7);
    const later = computeRecoil(w, 15, false, 7);
    expect(later.pitch).toBeGreaterThan(first.pitch);
  });

  it('is deterministic for the same seed and shot index', () => {
    const w = rifle();
    expect(computeRecoil(w, 5, false, 42)).toEqual(computeRecoil(w, 5, false, 42));
  });

  it('alternates horizontal direction so the pattern is learnable', () => {
    const w = rifle();
    const even = computeRecoil(w, 4, false, 3).yaw;
    const odd = computeRecoil(w, 5, false, 3).yaw;
    expect(Math.sign(even)).not.toBe(Math.sign(odd));
  });
});

describe('ballistics — damage', () => {
  it('applies full damage inside the falloff start and the floor beyond the end', () => {
    const w = rifle();
    expect(damageAtRange(w, 0)).toBe(w.damage);
    expect(damageAtRange(w, w.damageFalloffStart)).toBe(w.damage);
    expect(damageAtRange(w, w.damageFalloffEnd)).toBeCloseTo(w.damage * w.minDamageScale, 5);
    expect(damageAtRange(w, w.damageFalloffEnd + 50)).toBeCloseTo(w.damage * w.minDamageScale, 5);
  });

  it('decays monotonically through the falloff band', () => {
    const w = rifle();
    let prev = Infinity;
    for (let d = 0; d <= w.damageFalloffEnd; d += 2) {
      const dmg = damageAtRange(w, d);
      expect(dmg).toBeLessThanOrEqual(prev + 1e-9);
      prev = dmg;
    }
  });

  it('deals zero damage beyond max range', () => {
    const w = rifle();
    expect(damageAtRange(w, w.maxRange + 1)).toBe(0);
  });

  it('applies hit-zone multipliers', () => {
    const w = rifle();
    const chest = computeDamage(w, 5, HitZone.Chest);
    const head = computeDamage(w, 5, HitZone.Head);
    const limb = computeDamage(w, 5, HitZone.Limb);
    expect(head).toBeCloseTo(chest * w.headshotMultiplier, 1);
    expect(limb).toBeLessThan(chest);
  });

  it('reduces damage for bullets that penetrated a surface', () => {
    const w = rifle();
    const clean = computeDamage(w, 5, HitZone.Chest, 0);
    const through = computeDamage(w, 5, HitZone.Chest, 0.35);
    expect(through).toBeCloseTo(clean * 0.65, 1);
  });

  it('explosion damage falls off with distance and is zero outside the radius', () => {
    expect(explosionDamage(100, 0, 5)).toBe(100);
    expect(explosionDamage(100, 5, 5)).toBe(0);
    expect(explosionDamage(100, 6, 5)).toBe(0);
    const near = explosionDamage(100, 1, 5);
    const far = explosionDamage(100, 4, 5);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });
});

describe('hitboxes', () => {
  it('covers the full body height with four zones', () => {
    const boxes = buildHitboxes(vec3(0, 0, 0), PLAYER_HEIGHT_STAND);
    expect(boxes).toHaveLength(4);
    const zones = boxes.map((b) => b.zone);
    expect(zones).toContain(HitZone.Head);
    expect(zones).toContain(HitZone.Chest);
    expect(zones).toContain(HitZone.Stomach);
    expect(zones).toContain(HitZone.Limb);

    const head = boxes.find((b) => b.zone === HitZone.Head)!;
    expect(head.max.y).toBeCloseTo(PLAYER_HEIGHT_STAND, 5);
    const limb = boxes.find((b) => b.zone === HitZone.Limb)!;
    expect(limb.min.y).toBeCloseTo(0, 5);
  });

  it('a level shot at head height registers a headshot', () => {
    const target = vec3(0, 0, -10);
    const origin = vec3(0, PLAYER_HEIGHT_STAND * 0.93, 0);
    const dir = v3normalize(vec3(0, 0, -1));
    const hit = raycastHitboxes(origin, dir, 50, target, PLAYER_HEIGHT_STAND);
    expect(hit?.zone).toBe(HitZone.Head);
  });

  it('a shot at chest height registers a chest hit', () => {
    const hit = raycastHitboxes(
      vec3(0, PLAYER_HEIGHT_STAND * 0.75, 0),
      vec3(0, 0, -1),
      50,
      vec3(0, 0, -10),
      PLAYER_HEIGHT_STAND,
    );
    expect(hit?.zone).toBe(HitZone.Chest);
  });

  it('a shot at ankle height registers a limb hit', () => {
    const hit = raycastHitboxes(
      vec3(0, 0.2, 0),
      vec3(0, 0, -1),
      50,
      vec3(0, 0, -10),
      PLAYER_HEIGHT_STAND,
    );
    expect(hit?.zone).toBe(HitZone.Limb);
  });

  it('misses a target that is not in the ray path', () => {
    const hit = raycastHitboxes(
      vec3(0, 1.6, 0),
      vec3(0, 0, -1),
      50,
      vec3(20, 0, -10),
      PLAYER_HEIGHT_STAND,
    );
    expect(hit).toBeNull();
  });

  it('a crouched target has a lower head box, so a standing headshot line misses it', () => {
    const standing = raycastHitboxes(
      vec3(0, 1.7, 0),
      vec3(0, 0, -1),
      50,
      vec3(0, 0, -10),
      PLAYER_HEIGHT_STAND,
    );
    const crouched = raycastHitboxes(
      vec3(0, 1.7, 0),
      vec3(0, 0, -1),
      50,
      vec3(0, 0, -10),
      1.05,
    );
    expect(standing?.zone).toBe(HitZone.Head);
    expect(crouched).toBeNull();
  });

  it('a sliding target presents a lower profile', () => {
    const normal = buildHitboxes(vec3(0, 0, 0), PLAYER_HEIGHT_STAND, MovementState.Idle);
    const sliding = buildHitboxes(vec3(0, 0, 0), PLAYER_HEIGHT_STAND, MovementState.Slide);
    const normalHead = normal.find((b) => b.zone === HitZone.Head)!;
    const slideHead = sliding.find((b) => b.zone === HitZone.Head)!;
    expect(slideHead.max.y).toBeLessThan(normalHead.max.y);
  });
});

describe('weapon state machine', () => {
  const step = (r: ReturnType<typeof createWeaponRuntime>, w: ResolvedWeapon, o: Partial<{ fire: boolean; aim: boolean; reload: boolean; deltaMs: number }> = {}) =>
    stepWeapon(r, w, { fire: false, aim: false, reload: false, deltaMs: 16, ...o });

  it('cannot fire during the equip animation', () => {
    const w = rifle();
    let r = createWeaponRuntime(w);
    expect(r.phase).toBe(WeaponPhase.Equipping);
    const res = step(r, w, { fire: true });
    expect(res.shotsFired).toBe(0);
    // Once equipped, it becomes ready.
    r = res.runtime;
    for (let i = 0; i < 50 && r.phase === WeaponPhase.Equipping; i++) r = step(r, w).runtime;
    expect(r.phase).toBe(WeaponPhase.Ready);
  });

  function readyRifle() {
    const w = rifle();
    let r = createWeaponRuntime(w);
    for (let i = 0; i < 60 && r.phase !== WeaponPhase.Ready; i++) r = stepWeapon(r, w, { fire: false, aim: false, reload: false, deltaMs: 16 }).runtime;
    return { w, r };
  }

  it('consumes ammo and respects the fire-rate cooldown', () => {
    const { w, r: start } = readyRifle();
    let r = start;
    const first = step(r, w, { fire: true });
    expect(first.shotsFired).toBe(1);
    expect(first.runtime.ammoInMag).toBe(w.magazineSize - 1);
    r = first.runtime;

    // The next 16ms frame is inside the cooldown for a 660 RPM weapon (~91ms).
    const second = step(r, w, { fire: true });
    expect(second.shotsFired).toBe(0);
    expect(second.runtime.ammoInMag).toBe(w.magazineSize - 1);
  });

  it('automatic weapons keep firing while held; semi-auto needs a new press', () => {
    const { w, r: startAuto } = readyRifle();
    let r = startAuto;
    let autoShots = 0;
    for (let i = 0; i < 40; i++) {
      const res = step(r, w, { fire: true });
      autoShots += res.shotsFired;
      r = res.runtime;
    }
    expect(autoShots).toBeGreaterThan(3);

    const pistol = resolveWeapon('sp1_ember')!;
    expect(pistol.fireMode).toBe(FireMode.Semi);
    let pr = createWeaponRuntime(pistol);
    for (let i = 0; i < 60 && pr.phase !== WeaponPhase.Ready; i++) {
      pr = stepWeapon(pr, pistol, { fire: false, aim: false, reload: false, deltaMs: 16 }).runtime;
    }
    let semiShots = 0;
    for (let i = 0; i < 40; i++) {
      const res = stepWeapon(pr, pistol, { fire: true, aim: false, reload: false, deltaMs: 16 });
      semiShots += res.shotsFired;
      pr = res.runtime;
    }
    expect(semiShots).toBe(1);
  });

  it('reloads on request and refills from reserve', () => {
    const { w, r: start } = readyRifle();
    let r = { ...start, ammoInMag: 5 };
    r = step(r, w, { reload: true }).runtime;
    expect(r.phase).toBe(WeaponPhase.Reloading);

    let completed = false;
    for (let i = 0; i < 400 && !completed; i++) {
      const res = step(r, w);
      r = res.runtime;
      completed ||= res.reloadCompleted;
    }
    expect(completed).toBe(true);
    expect(r.ammoInMag).toBe(w.magazineSize);
    expect(r.reserveAmmo).toBe(w.reserveAmmo - (w.magazineSize - 5));
  });

  it('auto-reloads when firing on an empty magazine and reports a dry fire', () => {
    const { w, r: start } = readyRifle();
    let r = { ...start, ammoInMag: 0 };
    const res = step(r, w, { fire: true });
    expect(res.runtime.phase).toBe(WeaponPhase.Reloading);

    // With no reserve left it dry-fires instead.
    const empty = step({ ...start, ammoInMag: 0, reserveAmmo: 0 }, w, { fire: true });
    expect(empty.dryFired).toBe(true);
    expect(empty.shotsFired).toBe(0);
  });

  it('never lets a reload exceed the magazine size', () => {
    const { w, r: start } = readyRifle();
    let r = { ...start, ammoInMag: w.magazineSize - 1, reserveAmmo: 999 };
    r = step(r, w, { reload: true }).runtime;
    for (let i = 0; i < 400 && r.phase === WeaponPhase.Reloading; i++) r = step(r, w).runtime;
    expect(r.ammoInMag).toBe(w.magazineSize);
  });

  it('fires a full burst from a single press', () => {
    const burst = resolveWeapon('vx3_lattice')!;
    expect(burst.fireMode).toBe(FireMode.Burst);
    let r = createWeaponRuntime(burst);
    for (let i = 0; i < 60 && r.phase !== WeaponPhase.Ready; i++) {
      r = stepWeapon(r, burst, { fire: false, aim: false, reload: false, deltaMs: 16 }).runtime;
    }
    // Press once, then release: the burst must still complete.
    let shots = stepWeapon(r, burst, { fire: true, aim: false, reload: false, deltaMs: 16 });
    r = shots.runtime;
    let total = shots.shotsFired;
    for (let i = 0; i < 30; i++) {
      const res = stepWeapon(r, burst, { fire: false, aim: false, reload: false, deltaMs: 16 });
      total += res.shotsFired;
      r = res.runtime;
      if (r.burstRemaining === 0) break;
    }
    expect(total).toBe(burst.burstCount);
  });

  it('ADS progresses toward 1 while aiming and back to 0 when released', () => {
    const { w, r: start } = readyRifle();
    let r = start;
    for (let i = 0; i < 40; i++) r = step(r, w, { aim: true }).runtime;
    expect(r.adsProgress).toBe(1);
    for (let i = 0; i < 40; i++) r = step(r, w).runtime;
    expect(r.adsProgress).toBe(0);
  });

  it('reloading forces the sights down', () => {
    const { w, r: start } = readyRifle();
    let r = start;
    for (let i = 0; i < 40; i++) r = step(r, w, { aim: true }).runtime;
    expect(r.adsProgress).toBe(1);
    r = step({ ...r, ammoInMag: 3 }, w, { reload: true, aim: true }).runtime;
    for (let i = 0; i < 30; i++) r = step(r, w, { aim: true }).runtime;
    expect(r.adsProgress).toBeLessThan(1);
  });
});

describe('projectiles', () => {
  it('travels forward, drops under gravity, and expires', () => {
    const w = resolveWeapon('arc9_tempest')!;
    const world = new CollisionWorld([]);
    let p = createProjectile(1, 'player', w, vec3(0, 2, 0), vec3(0, 0, -1));

    const startY = p.position.y;
    for (let i = 0; i < 30; i++) p = stepProjectile(p, 1 / 64, world).projectile;

    expect(p.position.z).toBeLessThan(-1);
    expect(p.position.y).toBeLessThan(startY);
    expect(p.distanceTravelled).toBeGreaterThan(0);
  });

  it('stops at a wall instead of tunnelling through it', () => {
    const w = resolveWeapon('arc9_tempest')!;
    const world = new CollisionWorld([
      { id: 1, min: vec3(-10, 0, -10.2), max: vec3(10, 6, -10), material: SurfaceMaterial.Concrete },
    ]);
    let p = createProjectile(1, 'player', w, vec3(0, 2, 0), vec3(0, 0, -1));

    let hit = null;
    for (let i = 0; i < 200 && !hit; i++) {
      const res = stepProjectile(p, 1 / 64, world);
      p = res.projectile;
      hit = res.worldHit;
    }
    expect(hit).not.toBeNull();
    expect(p.position.z).toBeGreaterThanOrEqual(-10.01);
  });
});

describe('attachment resolution', () => {
  it('folds modifiers into the weapon stats', () => {
    const base = requireWeapon('tr9_sentinel');
    const withMag = resolveWeapon('tr9_sentinel', { magazine: 'mag_extended' })!;
    expect(withMag.magazineSize).toBe(base.magazineSize + 10);
    expect(withMag.reloadTimeMs).toBeGreaterThan(base.reloadTimeMs);
    expect(withMag.appliedAttachments).toContain('mag_extended');
  });

  it('ignores an attachment in a slot the weapon does not have', () => {
    // The sniper has no grip slot.
    const w = resolveWeapon('mk7_nightfall', { grip: 'grip_vertical' } as never)!;
    expect(w.appliedAttachments).not.toContain('grip_vertical');
  });

  it('ignores an unknown attachment id rather than throwing', () => {
    const w = resolveWeapon('tr9_sentinel', { optic: 'does_not_exist' })!;
    expect(w.appliedAttachments).toHaveLength(0);
    expect(w.damage).toBe(requireWeapon('tr9_sentinel').damage);
  });

  it('returns null for an unknown weapon', () => {
    expect(resolveWeapon('not_a_weapon')).toBeNull();
  });

  it('marks a suppressed weapon so the minimap can hide the shooter', () => {
    const w = resolveWeapon('tr9_sentinel', { barrel: 'barrel_suppressor' })!;
    expect(w.suppressed).toBe(true);
    expect(w.damage).toBeLessThan(requireWeapon('tr9_sentinel').damage);
  });

  it('derives the shot interval from the fire rate', () => {
    const w = rifle();
    expect(shotIntervalMs(w)).toBeCloseTo(60000 / w.fireRate, 5);
  });
});
