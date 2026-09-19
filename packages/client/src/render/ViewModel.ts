/**
 * First-person arms and weapon.
 *
 * This is most of what "good gunplay feel" actually is. The weapon is not
 * rigidly parented to the camera — it lags behind it, sways with movement,
 * bobs with the gait, kicks on fire, and dips on landing. Those offsets are
 * what make a shot feel like it has weight.
 *
 * Every motion here is cosmetic: none of it affects where a bullet goes. Aim is
 * decided by the camera angles, which the server simulates identically.
 */

import * as THREE from 'three';
import {
  WeaponClass,
  WeaponPhase,
  clamp,
  damp,
  getItem,
  lerp,
  type ResolvedWeapon,
} from '@titan/shared';

export interface ViewModelState {
  /** 0-1 aim-down-sights progress. */
  ads: number;
  /** Horizontal speed, for sway and bob. */
  speed: number;
  sprinting: boolean;
  grounded: boolean;
  phase: WeaponPhase;
  /** 0-1 reload progress. */
  reloadProgress: number;
  /** Yaw/pitch delta this frame, for weapon lag. */
  lookDeltaYaw: number;
  lookDeltaPitch: number;
  /** Set for one frame when the player lands, scaled by impact speed. */
  landImpact: number;
  dt: number;
}

/** Per-class silhouette, so weapons read differently in the hands. */
interface WeaponShape {
  bodyLength: number;
  bodyHeight: number;
  bodyWidth: number;
  barrelLength: number;
  barrelRadius: number;
  stock: boolean;
  magazine: boolean;
  scope: 'none' | 'reflex' | 'scope';
  gripForward: number;
}

const SHAPES: Record<string, WeaponShape> = {
  [WeaponClass.AssaultRifle]: {
    bodyLength: 0.44, bodyHeight: 0.1, bodyWidth: 0.07, barrelLength: 0.3,
    barrelRadius: 0.016, stock: true, magazine: true, scope: 'reflex', gripForward: 0.1,
  },
  [WeaponClass.SMG]: {
    bodyLength: 0.32, bodyHeight: 0.095, bodyWidth: 0.065, barrelLength: 0.16,
    barrelRadius: 0.014, stock: false, magazine: true, scope: 'reflex', gripForward: 0.05,
  },
  [WeaponClass.Shotgun]: {
    bodyLength: 0.5, bodyHeight: 0.11, bodyWidth: 0.075, barrelLength: 0.36,
    barrelRadius: 0.026, stock: true, magazine: false, scope: 'none', gripForward: 0.14,
  },
  [WeaponClass.Sniper]: {
    bodyLength: 0.58, bodyHeight: 0.1, bodyWidth: 0.07, barrelLength: 0.5,
    barrelRadius: 0.018, stock: true, magazine: true, scope: 'scope', gripForward: 0.18,
  },
  [WeaponClass.Marksman]: {
    bodyLength: 0.5, bodyHeight: 0.1, bodyWidth: 0.07, barrelLength: 0.38,
    barrelRadius: 0.017, stock: true, magazine: true, scope: 'scope', gripForward: 0.14,
  },
  [WeaponClass.Pistol]: {
    bodyLength: 0.18, bodyHeight: 0.09, bodyWidth: 0.045, barrelLength: 0.08,
    barrelRadius: 0.012, stock: false, magazine: true, scope: 'none', gripForward: 0,
  },
  [WeaponClass.Melee]: {
    bodyLength: 0.06, bodyHeight: 0.05, bodyWidth: 0.03, barrelLength: 0.42,
    barrelRadius: 0.03, stock: false, magazine: false, scope: 'none', gripForward: 0,
  },
  [WeaponClass.Special]: {
    bodyLength: 0.46, bodyHeight: 0.13, bodyWidth: 0.09, barrelLength: 0.26,
    barrelRadius: 0.032, stock: true, magazine: true, scope: 'reflex', gripForward: 0.12,
  },
};

export class ViewModel {
  readonly root = new THREE.Group();
  /** Where tracers and muzzle flash originate, in world space. */
  readonly muzzle = new THREE.Object3D();
  /** Where spent casings eject from. */
  readonly ejectionPort = new THREE.Object3D();

  private weaponGroup = new THREE.Group();
  private handLeft: THREE.Group | null = null;
  private handRight: THREE.Group | null = null;
  private materials: THREE.Material[] = [];
  private currentWeaponId: string | null = null;

  // Smoothed animation state.
  private bobPhase = 0;
  private swayX = 0;
  private swayY = 0;
  private kickBack = 0;
  private kickPitch = 0;
  private landDip = 0;
  private sprintBlend = 0;
  private adsBlend = 0;
  private reloadBlend = 0;
  private inspectTime = 0;

  /** Hip and ADS rest positions, in camera space. */
  private readonly hipPosition = new THREE.Vector3(0.17, -0.17, -0.32);
  private readonly adsPosition = new THREE.Vector3(0, -0.075, -0.22);
  private readonly sprintPosition = new THREE.Vector3(0.22, -0.22, -0.3);

  constructor() {
    this.root.name = 'viewmodel';
    // Rendered by a dedicated camera layer so the weapon never clips into
    // walls — the standard solution, and much cheaper than depth tricks.
    this.root.renderOrder = 10;
    this.root.add(this.weaponGroup);
  }

  /** Rebuild the mesh for a new weapon. */
  setWeapon(weapon: ResolvedWeapon, skinId: string | null): void {
    if (this.currentWeaponId === weapon.id) return;
    this.currentWeaponId = weapon.id;
    this.disposeWeapon();

    const shape = SHAPES[weapon.class] ?? SHAPES[WeaponClass.AssaultRifle]!;
    const skin = skinId ? getItem(skinId) : null;

    const bodyColor = skin?.visual.color ?? 0x30343c;
    const accentColor = skin?.visual.accent ?? 0x585f6b;
    const finish = skin?.visual.finish ?? 'matte';

    const bodyMat = new THREE.MeshStandardMaterial({
      color: bodyColor,
      roughness: finish === 'gloss' ? 0.25 : finish === 'metallic' ? 0.3 : 0.62,
      metalness: finish === 'metallic' ? 0.9 : 0.45,
      emissive: finish === 'emissive' ? new THREE.Color(accentColor) : new THREE.Color(0x000000),
      emissiveIntensity: finish === 'emissive' ? 0.8 : 0,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: accentColor,
      roughness: 0.4,
      metalness: 0.7,
    });
    const handMat = new THREE.MeshStandardMaterial({ color: 0x8a6a54, roughness: 0.85 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.8 });
    this.materials = [bodyMat, accentMat, handMat, gloveMat];

    const group = new THREE.Group();

    // Receiver.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(shape.bodyWidth, shape.bodyHeight, shape.bodyLength),
      bodyMat,
    );
    body.position.z = -shape.bodyLength / 2;
    group.add(body);

    // Barrel.
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(shape.barrelRadius, shape.barrelRadius, shape.barrelLength, 10),
      accentMat,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, shape.bodyHeight * 0.12, -shape.bodyLength - shape.barrelLength / 2);
    group.add(barrel);

    if (shape.stock) {
      const stock = new THREE.Mesh(
        new THREE.BoxGeometry(shape.bodyWidth * 0.85, shape.bodyHeight * 1.1, 0.16),
        bodyMat,
      );
      stock.position.z = 0.08;
      group.add(stock);
    }

    if (shape.magazine) {
      const magazine = new THREE.Mesh(
        new THREE.BoxGeometry(shape.bodyWidth * 0.8, 0.14, 0.05),
        accentMat,
      );
      magazine.position.set(0, -shape.bodyHeight / 2 - 0.06, -shape.bodyLength * 0.45);
      magazine.rotation.x = -0.12;
      magazine.name = 'magazine';
      group.add(magazine);
    }

    if (shape.scope !== 'none') {
      const isScope = shape.scope === 'scope';
      const optic = new THREE.Mesh(
        new THREE.CylinderGeometry(isScope ? 0.026 : 0.018, isScope ? 0.026 : 0.018, isScope ? 0.2 : 0.07, 10),
        bodyMat,
      );
      optic.rotation.x = Math.PI / 2;
      optic.position.set(0, shape.bodyHeight * 0.7, -shape.bodyLength * (isScope ? 0.45 : 0.35));
      group.add(optic);

      // A lit lens element gives the sight a focal point to aim with.
      const lens = new THREE.Mesh(
        new THREE.CircleGeometry(isScope ? 0.023 : 0.015, 12),
        new THREE.MeshBasicMaterial({ color: 0x4ef0a0, transparent: true, opacity: 0.65 }),
      );
      lens.position.set(0, shape.bodyHeight * 0.7, -shape.bodyLength * (isScope ? 0.45 : 0.35) - (isScope ? 0.101 : 0.036));
      group.add(lens);
      this.materials.push(lens.material as THREE.Material);
    }

    // Grip.
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.11, 0.05), bodyMat);
    grip.position.set(0, -shape.bodyHeight / 2 - 0.05, -0.02);
    grip.rotation.x = 0.22;
    group.add(grip);

    // Hands: a forearm and a fist each, positioned on the grip and handguard.
    const makeHand = (x: number, z: number): THREE.Group => {
      const hand = new THREE.Group();
      const fist = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.06, 0.08), gloveMat);
      hand.add(fist);
      const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.2), handMat);
      forearm.position.z = 0.13;
      hand.add(forearm);
      hand.position.set(x, -shape.bodyHeight / 2 - 0.03, z);
      return hand;
    };

    this.handRight = makeHand(0.035, -0.02);
    this.handLeft = makeHand(-0.045, -shape.bodyLength * 0.55 - shape.gripForward);
    this.handLeft.name = 'handLeft';
    group.add(this.handRight, this.handLeft);

    // Sockets.
    this.muzzle.position.set(0, shape.bodyHeight * 0.12, -shape.bodyLength - shape.barrelLength);
    this.ejectionPort.position.set(shape.bodyWidth * 0.6, shape.bodyHeight * 0.2, -shape.bodyLength * 0.35);
    group.add(this.muzzle, this.ejectionPort);

    // Melee weapons are a blade rather than a barrel.
    if (weapon.class === WeaponClass.Melee) {
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, 0.09, shape.barrelLength),
        new THREE.MeshStandardMaterial({ color: 0xc8d4e0, roughness: 0.15, metalness: 0.95 }),
      );
      blade.position.z = -shape.barrelLength / 2 - 0.05;
      group.add(blade);
      this.materials.push(blade.material as THREE.Material);
      barrel.visible = false;
    }

    this.weaponGroup.add(group);
  }

  private disposeWeapon(): void {
    for (const child of this.weaponGroup.children.slice()) {
      child.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      this.weaponGroup.remove(child);
    }
    for (const material of this.materials) material.dispose();
    this.materials = [];
  }

  /** Called on every shot: adds recoil kick to the model. */
  addFireKick(weapon: ResolvedWeapon, aiming: boolean): void {
    // Scale the visual kick with the weapon's actual recoil, so a heavy gun
    // *looks* heavy. ADS reduces it, matching the real recoil model.
    const scale = aiming ? 0.55 : 1;
    this.kickBack = Math.min(0.08, this.kickBack + weapon.recoil.vertical * 2.6 * scale);
    this.kickPitch = Math.min(0.22, this.kickPitch + weapon.recoil.vertical * 7 * scale);
  }

  /** Trigger the inspect animation. */
  inspect(): void {
    if (this.inspectTime <= 0) this.inspectTime = 1.6;
  }

  update(state: ViewModelState): void {
    const dt = Math.min(state.dt, 0.05);

    this.adsBlend = state.ads;
    this.sprintBlend = damp(this.sprintBlend, state.sprinting && state.ads < 0.1 ? 1 : 0, 10, dt);
    this.reloadBlend = damp(
      this.reloadBlend,
      state.phase === WeaponPhase.Reloading ? 1 : 0,
      12,
      dt,
    );

    // Weapon lag: the gun trails the camera, then catches up. This is the
    // single most important cue that the weapon has mass.
    const lagScale = lerp(0.035, 0.012, this.adsBlend);
    this.swayX = damp(this.swayX, clamp(-state.lookDeltaYaw * lagScale * 60, -0.06, 0.06), 9, dt);
    this.swayY = damp(this.swayY, clamp(state.lookDeltaPitch * lagScale * 60, -0.05, 0.05), 9, dt);

    // Bob, driven by distance travelled so it matches the footstep cadence.
    if (state.grounded && state.speed > 0.4) {
      this.bobPhase += (state.speed * dt) / 1.5 * Math.PI * 2;
    } else {
      this.bobPhase = damp(this.bobPhase % (Math.PI * 2), 0, 5, dt);
    }
    const bobAmount = clamp(state.speed / 8, 0, 1) * lerp(1, 0.18, this.adsBlend);
    const bobX = Math.sin(this.bobPhase) * 0.014 * bobAmount;
    const bobY = Math.abs(Math.cos(this.bobPhase)) * 0.011 * bobAmount;

    // Landing dip.
    if (state.landImpact > 0) {
      this.landDip = Math.min(0.09, this.landDip + state.landImpact * 0.006);
    }
    this.landDip = damp(this.landDip, 0, 9, dt);

    // Recoil recovery.
    this.kickBack = damp(this.kickBack, 0, 13, dt);
    this.kickPitch = damp(this.kickPitch, 0, 11, dt);

    // Resting position: hip -> ADS, with a separate sprint pose.
    const target = new THREE.Vector3();
    target.lerpVectors(this.hipPosition, this.adsPosition, this.adsBlend);
    target.lerp(this.sprintPosition, this.sprintBlend);

    target.x += this.swayX + bobX;
    target.y += this.swayY - bobY - this.landDip;
    target.z += this.kickBack;

    // Reload: the weapon drops and tilts out of the sight line.
    target.y -= this.reloadBlend * 0.1;
    target.z += this.reloadBlend * 0.04;

    this.root.position.lerp(target, 1 - Math.exp(-18 * dt));

    // Rotation.
    const targetRotX = -this.kickPitch + this.landDip * 1.2 + this.reloadBlend * 0.5 + this.swayY * 1.6;
    const targetRotY = this.sprintBlend * 0.5 + this.reloadBlend * 0.25 - this.swayX * 1.8;
    const targetRotZ = this.sprintBlend * -0.28 + this.reloadBlend * 0.35 + bobX * 1.5;

    this.root.rotation.x = damp(this.root.rotation.x, targetRotX, 16, dt);
    this.root.rotation.y = damp(this.root.rotation.y, targetRotY, 16, dt);
    this.root.rotation.z = damp(this.root.rotation.z, targetRotZ, 16, dt);

    // The support hand leaves the handguard during a reload to work the
    // magazine — the detail that makes a reload read as a reload.
    if (this.handLeft) {
      const magOut = Math.sin(state.reloadProgress * Math.PI) * this.reloadBlend;
      this.handLeft.position.y = -0.08 - magOut * 0.16;
      this.handLeft.rotation.x = magOut * 0.9;
    }

    // Inspect: a slow rotate-and-return.
    if (this.inspectTime > 0) {
      this.inspectTime -= dt;
      const t = 1 - this.inspectTime / 1.6;
      const curve = Math.sin(t * Math.PI);
      this.root.rotation.y += curve * 0.9;
      this.root.rotation.z += curve * 0.5;
      this.root.position.z += curve * 0.06;
    }
  }

  /** Muzzle position in world space, for spawning VFX. */
  muzzleWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  ejectionWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.ejectionPort.getWorldPosition(out);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  dispose(): void {
    this.disposeWeapon();
  }
}
