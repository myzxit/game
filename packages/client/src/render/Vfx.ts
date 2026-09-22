/**
 * Visual effects.
 *
 * Everything is pooled. A firefight spawns hundreds of short-lived objects per
 * second, and allocating them per shot is exactly the pattern that produces
 * visible GC stutter on low-end machines — which is felt most in the moment it
 * matters least: mid-fight.
 *
 * Effects scale with the graphics preset, with one hard rule: the tracer and
 * the impact mark are gameplay information (they tell you where you were shot
 * from), so they are never reduced below the point of legibility. Smoke, dust
 * and sparks are decoration and scale freely.
 */

import * as THREE from 'three';
import {
  ObjectPool,
  SurfaceMaterial,
  clamp,
  type Vec3,
} from '@titan/shared';
import type { GraphicsSettings, AccessibilitySettings } from '../core/Settings.js';

/** Impact colour and behaviour per surface. */
const IMPACT_STYLE: Record<SurfaceMaterial, { color: number; sparks: number; dust: number; decal: boolean }> = {
  [SurfaceMaterial.Metal]: { color: 0xffd08a, sparks: 10, dust: 2, decal: true },
  [SurfaceMaterial.Concrete]: { color: 0xd8d2c6, sparks: 2, dust: 10, decal: true },
  [SurfaceMaterial.Asphalt]: { color: 0x8a8a8a, sparks: 1, dust: 9, decal: true },
  [SurfaceMaterial.Wood]: { color: 0xc09a63, sparks: 0, dust: 8, decal: true },
  [SurfaceMaterial.Glass]: { color: 0xcfe8f5, sparks: 6, dust: 4, decal: false },
  [SurfaceMaterial.Brick]: { color: 0xc08a72, sparks: 2, dust: 10, decal: true },
  [SurfaceMaterial.Plastic]: { color: 0xd0d4da, sparks: 1, dust: 5, decal: true },
  [SurfaceMaterial.Fabric]: { color: 0xa08878, sparks: 0, dust: 6, decal: true },
  [SurfaceMaterial.Dirt]: { color: 0x9a8464, sparks: 0, dust: 14, decal: true },
  [SurfaceMaterial.Grass]: { color: 0x7a9455, sparks: 0, dust: 12, decal: true },
  [SurfaceMaterial.Water]: { color: 0xa8d0e0, sparks: 0, dust: 12, decal: false },
  [SurfaceMaterial.Flesh]: { color: 0xc04a44, sparks: 0, dust: 6, decal: false },
};

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
  spin: number;
  fadeFrom: number;
}

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

interface Decal {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

interface Flash {
  light: THREE.PointLight;
  sprite: THREE.Mesh;
  life: number;
  maxLife: number;
  intensity: number;
}

const MAX_DECALS = 120;

export class VfxSystem {
  readonly root = new THREE.Group();

  private settings: GraphicsSettings;
  private accessibility: AccessibilitySettings;

  private readonly particlePool: ObjectPool<Particle>;
  private readonly tracerPool: ObjectPool<Tracer>;
  private readonly decalPool: ObjectPool<Decal>;

  private readonly activeParticles: Particle[] = [];
  private readonly activeTracers: Tracer[] = [];
  private readonly activeDecals: Decal[] = [];
  private readonly activeFlashes: Flash[] = [];

  private readonly flashLights: THREE.PointLight[] = [];
  private readonly flashSprites: THREE.Mesh[] = [];

  // Shared geometry and materials — one allocation for the whole system.
  private readonly particleGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly tracerGeometry = new THREE.CylinderGeometry(0.012, 0.012, 1, 5, 1, true);
  private readonly decalGeometry = new THREE.CircleGeometry(0.07, 8);
  private readonly flashGeometry = new THREE.PlaneGeometry(0.34, 0.34);

  private readonly tracerMaterial: THREE.MeshBasicMaterial;
  private readonly decalMaterial: THREE.MeshBasicMaterial;
  private readonly flashMaterial: THREE.MeshBasicMaterial;

  constructor(settings: GraphicsSettings, accessibility: AccessibilitySettings) {
    this.settings = settings;
    this.accessibility = accessibility;
    this.root.name = 'vfx';

    this.tracerMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe0a0,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.decalMaterial = new THREE.MeshBasicMaterial({
      color: 0x14161a,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    this.flashMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe6b0,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    this.particlePool = new ObjectPool<Particle>(
      () => {
        const material = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        });
        const mesh = new THREE.Mesh(this.particleGeometry, material);
        mesh.visible = false;
        this.root.add(mesh);
        return {
          mesh,
          velocity: new THREE.Vector3(),
          life: 0,
          maxLife: 1,
          gravity: 0,
          spin: 0,
          fadeFrom: 1,
        };
      },
      (p) => {
        p.mesh.visible = false;
        p.life = 0;
      },
      64,
      400,
    );

    this.tracerPool = new ObjectPool<Tracer>(
      () => {
        const mesh = new THREE.Mesh(this.tracerGeometry, this.tracerMaterial);
        mesh.visible = false;
        this.root.add(mesh);
        return { mesh, life: 0, maxLife: 0.07 };
      },
      (t) => {
        t.mesh.visible = false;
        t.life = 0;
      },
      24,
      120,
    );

    this.decalPool = new ObjectPool<Decal>(
      () => {
        const mesh = new THREE.Mesh(this.decalGeometry, this.decalMaterial.clone());
        mesh.visible = false;
        this.root.add(mesh);
        return { mesh, life: 0, maxLife: 18 };
      },
      (d) => {
        d.mesh.visible = false;
        d.life = 0;
      },
      32,
      MAX_DECALS,
    );

    // A small fixed set of flash lights, reused round-robin. Adding lights
    // dynamically forces a shader recompile in three.js, which is a visible
    // hitch — so the set is allocated once.
    const flashCount = Math.max(1, Math.min(4, Math.round(settings.maxDynamicLights / 4)));
    for (let i = 0; i < flashCount; i++) {
      const light = new THREE.PointLight(0xffcf8a, 0, 12, 2);
      light.visible = false;
      this.root.add(light);
      this.flashLights.push(light);

      const sprite = new THREE.Mesh(this.flashGeometry, this.flashMaterial.clone());
      sprite.visible = false;
      this.root.add(sprite);
      this.flashSprites.push(sprite);
    }
  }

  applySettings(settings: GraphicsSettings, accessibility: AccessibilitySettings): void {
    this.settings = settings;
    this.accessibility = accessibility;
  }

  /** Scale a decorative particle count by the preset. */
  private budget(count: number): number {
    return Math.max(0, Math.round(count * this.settings.particleDensity * this.settings.vfxQuality));
  }

  private spawnParticle(
    position: Vec3 | THREE.Vector3,
    velocity: THREE.Vector3,
    color: number,
    size: number,
    life: number,
    gravity: number,
    opacity = 1,
  ): void {
    // Hard cap: past this, drop the request rather than tank the frame rate.
    if (this.activeParticles.length >= 380) return;

    const particle = this.particlePool.acquire();
    particle.mesh.position.set(position.x, position.y, position.z);
    particle.mesh.scale.setScalar(size);
    particle.mesh.visible = true;
    particle.velocity.copy(velocity);
    particle.life = life;
    particle.maxLife = life;
    particle.gravity = gravity;
    particle.spin = (Math.random() - 0.5) * 6;
    particle.fadeFrom = opacity;

    const material = particle.mesh.material as THREE.MeshBasicMaterial;
    material.color.setHex(color);
    material.opacity = opacity;

    this.activeParticles.push(particle);
  }

  // ---------------------------------------------------------------- effects

  /**
   * Muzzle flash. Gameplay-relevant (it reveals a shooter's position), so the
   * sprite always plays; only the dynamic light scales with the preset, and
   * the whole thing dims under the photosensitivity setting.
   */
  muzzleFlash(position: THREE.Vector3, direction: THREE.Vector3, scale = 1): void {
    const intensity = this.accessibility.reduceFlashing ? 0.35 : 1;

    const sprite = this.flashSprites[this.flashCursor % this.flashSprites.length];
    const light = this.flashLights[this.flashCursor % this.flashLights.length];
    this.flashCursor++;

    if (sprite) {
      sprite.position.copy(position);
      sprite.scale.setScalar(scale * (0.8 + Math.random() * 0.5));
      sprite.rotation.z = Math.random() * Math.PI;
      sprite.visible = true;
      (sprite.material as THREE.MeshBasicMaterial).opacity = intensity;
    }

    if (light && this.settings.maxDynamicLights > 0) {
      light.position.copy(position);
      light.intensity = 5 * intensity * scale;
      light.visible = true;
    }

    if (sprite && light) {
      this.activeFlashes.push({ light, sprite, life: 0.045, maxLife: 0.045, intensity });
    }

    // Muzzle smoke — decoration, scales freely.
    const smoke = this.budget(3);
    for (let i = 0; i < smoke; i++) {
      const velocity = direction
        .clone()
        .multiplyScalar(1.5 + Math.random())
        .add(new THREE.Vector3((Math.random() - 0.5) * 0.6, Math.random() * 0.4, (Math.random() - 0.5) * 0.6));
      this.spawnParticle(position, velocity, 0x9a9a9a, 0.08, 0.4, -0.4, 0.3);
    }
  }

  private flashCursor = 0;

  /**
   * Bullet tracer. Always drawn: it is the primary cue for "where did that
   * come from", and hiding it on Low would be a competitive disadvantage.
   */
  tracer(from: THREE.Vector3, to: THREE.Vector3, color = 0xffe0a0): void {
    const tracer = this.tracerPool.acquire();
    const distance = from.distanceTo(to);
    if (distance < 0.2) {
      this.tracerPool.release(tracer);
      return;
    }

    const midpoint = from.clone().add(to).multiplyScalar(0.5);
    tracer.mesh.position.copy(midpoint);
    tracer.mesh.scale.set(1, distance, 1);
    // The cylinder's long axis is Y; point it along the shot.
    tracer.mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      to.clone().sub(from).normalize(),
    );
    tracer.mesh.visible = true;
    (tracer.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    tracer.life = 0.06;
    tracer.maxLife = 0.06;
    this.activeTracers.push(tracer);
  }

  /** Surface impact: sparks, dust and a decal, chosen by material. */
  impact(position: Vec3, normal: Vec3, material: SurfaceMaterial): void {
    const style = IMPACT_STYLE[material] ?? IMPACT_STYLE[SurfaceMaterial.Concrete];
    const point = new THREE.Vector3(position.x, position.y, position.z);
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();

    // Sparks: fast, bright, short-lived, gravity-affected.
    const sparks = this.budget(style.sparks);
    for (let i = 0; i < sparks; i++) {
      const velocity = n
        .clone()
        .multiplyScalar(2 + Math.random() * 4)
        .add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3));
      this.spawnParticle(point, velocity, style.color, 0.028, 0.28 + Math.random() * 0.2, 9);
    }

    // Dust: slow, soft, drifts upward.
    const dust = this.budget(style.dust);
    for (let i = 0; i < dust; i++) {
      const velocity = n
        .clone()
        .multiplyScalar(0.6 + Math.random())
        .add(new THREE.Vector3((Math.random() - 0.5) * 1.2, Math.random() * 0.8, (Math.random() - 0.5) * 1.2));
      this.spawnParticle(point, velocity, style.color, 0.07 + Math.random() * 0.06, 0.5 + Math.random() * 0.4, -0.5, 0.35);
    }

    if (style.decal && this.settings.vfxQuality > 0.2) this.decal(point, n);

    // Water gets a ring splash instead of a decal.
    if (material === SurfaceMaterial.Water) {
      const ring = this.budget(6);
      for (let i = 0; i < ring; i++) {
        const angle = (i / Math.max(1, ring)) * Math.PI * 2;
        const velocity = new THREE.Vector3(Math.cos(angle) * 1.6, 2.2 + Math.random(), Math.sin(angle) * 1.6);
        this.spawnParticle(point, velocity, 0xbcdcea, 0.05, 0.45, 7, 0.6);
      }
    }
  }

  private decal(point: THREE.Vector3, normal: THREE.Vector3): void {
    // Retire the oldest decal once the cap is reached, rather than growing.
    if (this.activeDecals.length >= MAX_DECALS) {
      const oldest = this.activeDecals.shift();
      if (oldest) this.decalPool.release(oldest);
    }

    const decal = this.decalPool.acquire();
    // Offset slightly along the normal so it doesn't z-fight the wall.
    decal.mesh.position.copy(point).addScaledVector(normal, 0.012);
    decal.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    decal.mesh.rotation.z = Math.random() * Math.PI;
    decal.mesh.scale.setScalar(0.7 + Math.random() * 0.6);
    decal.mesh.visible = true;
    (decal.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75;
    decal.life = decal.maxLife;
    this.activeDecals.push(decal);
  }

  /** Spent casing, ejected from the weapon. */
  casing(position: THREE.Vector3, right: THREE.Vector3): void {
    if (this.settings.vfxQuality < 0.3) return;
    const velocity = right
      .clone()
      .multiplyScalar(1.8 + Math.random())
      .add(new THREE.Vector3(0, 1.6 + Math.random(), (Math.random() - 0.5) * 0.8));
    this.spawnParticle(position, velocity, 0xd8b060, 0.022, 1.1, 9);
  }

  /** Explosion: flash, fireball and debris. */
  explosion(position: Vec3, radius: number): void {
    const point = new THREE.Vector3(position.x, position.y, position.z);
    const intensity = this.accessibility.reduceFlashing ? 0.3 : 1;

    const light = this.flashLights[this.flashCursor % this.flashLights.length];
    const sprite = this.flashSprites[this.flashCursor % this.flashSprites.length];
    this.flashCursor++;

    if (light && sprite) {
      light.position.copy(point);
      light.intensity = 14 * intensity;
      light.distance = radius * 5;
      light.visible = true;
      sprite.position.copy(point);
      sprite.scale.setScalar(radius * 1.6);
      sprite.visible = true;
      (sprite.material as THREE.MeshBasicMaterial).opacity = intensity;
      this.activeFlashes.push({ light, sprite, life: 0.28, maxLife: 0.28, intensity });
    }

    const fire = this.budget(26);
    for (let i = 0; i < fire; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      this.spawnParticle(
        point,
        dir.multiplyScalar(3 + Math.random() * 8),
        i % 3 === 0 ? 0xffd070 : 0xff7a30,
        0.2 + Math.random() * 0.25,
        0.5 + Math.random() * 0.4,
        -1.5,
        0.8,
      );
    }

    const smoke = this.budget(14);
    for (let i = 0; i < smoke; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize();
      this.spawnParticle(point, dir.multiplyScalar(1.5 + Math.random() * 2), 0x6a6a6a, 0.4, 1.4, -0.7, 0.35);
    }
  }

  /** Glass shattering into falling shards. */
  glassBreak(position: Vec3): void {
    const point = new THREE.Vector3(position.x, position.y, position.z);
    const shards = this.budget(20);
    for (let i = 0; i < shards; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5).normalize();
      this.spawnParticle(point, dir.multiplyScalar(1 + Math.random() * 4), 0xcfe8f5, 0.05, 1.2, 11, 0.7);
    }
  }

  /** Expanding ring, used by the scan pulse. */
  scanPulse(position: Vec3, radius: number, color = 0x4ec97a): void {
    const point = new THREE.Vector3(position.x, position.y, position.z);
    const count = this.budget(24);
    for (let i = 0; i < count; i++) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(angle), 0.05, Math.sin(angle));
      this.spawnParticle(point, dir.multiplyScalar(radius * 0.6), color, 0.12, 1.4, 0, 0.6);
    }
  }

  /** Trail behind a dashing player. */
  dashTrail(position: Vec3, color = 0x8ac0ff): void {
    const count = this.budget(4);
    for (let i = 0; i < count; i++) {
      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.5,
        Math.random() * 0.3,
        (Math.random() - 0.5) * 0.5,
      );
      this.spawnParticle(position, velocity, color, 0.14, 0.35, -0.2, 0.45);
    }
  }

  /** Spawn-in effect, so a respawning player is visually announced. */
  spawnEffect(position: Vec3, color = 0x4ef0a0): void {
    const count = this.budget(18);
    for (let i = 0; i < count; i++) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const velocity = new THREE.Vector3(Math.cos(angle) * 1.2, 2.5 + Math.random(), Math.sin(angle) * 1.2);
      this.spawnParticle(position, velocity, color, 0.09, 0.8, 2.5, 0.7);
    }
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, cameraPosition: THREE.Vector3): void {
    const step = Math.min(dt, 0.05);

    // Particles.
    for (let i = this.activeParticles.length - 1; i >= 0; i--) {
      const particle = this.activeParticles[i]!;
      particle.life -= step;
      if (particle.life <= 0) {
        this.particlePool.release(particle);
        this.activeParticles.splice(i, 1);
        continue;
      }

      particle.velocity.y -= particle.gravity * step;
      particle.mesh.position.addScaledVector(particle.velocity, step);
      particle.mesh.rotation.z += particle.spin * step;
      // Billboard toward the camera so flat planes read as volumetric.
      particle.mesh.lookAt(cameraPosition);

      const t = particle.life / particle.maxLife;
      (particle.mesh.material as THREE.MeshBasicMaterial).opacity = particle.fadeFrom * t;
    }

    // Tracers.
    for (let i = this.activeTracers.length - 1; i >= 0; i--) {
      const tracer = this.activeTracers[i]!;
      tracer.life -= step;
      if (tracer.life <= 0) {
        this.tracerPool.release(tracer);
        this.activeTracers.splice(i, 1);
      }
    }

    // Flashes.
    for (let i = this.activeFlashes.length - 1; i >= 0; i--) {
      const flash = this.activeFlashes[i]!;
      flash.life -= step;
      if (flash.life <= 0) {
        flash.light.visible = false;
        flash.light.intensity = 0;
        flash.sprite.visible = false;
        this.activeFlashes.splice(i, 1);
        continue;
      }
      const t = flash.life / flash.maxLife;
      flash.light.intensity *= 0.82;
      (flash.sprite.material as THREE.MeshBasicMaterial).opacity = flash.intensity * t;
    }

    // Decals fade out slowly near the end of their life.
    for (let i = this.activeDecals.length - 1; i >= 0; i--) {
      const decal = this.activeDecals[i]!;
      decal.life -= step;
      if (decal.life <= 0) {
        this.decalPool.release(decal);
        this.activeDecals.splice(i, 1);
        continue;
      }
      const remaining = decal.life / decal.maxLife;
      if (remaining < 0.25) {
        (decal.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (remaining / 0.25);
      }
    }
  }

  stats(): { particles: number; tracers: number; decals: number } {
    return {
      particles: this.activeParticles.length,
      tracers: this.activeTracers.length,
      decals: this.activeDecals.length,
    };
  }

  /** Drop everything — called on map change. */
  clear(): void {
    for (const particle of this.activeParticles) this.particlePool.release(particle);
    for (const tracer of this.activeTracers) this.tracerPool.release(tracer);
    for (const decal of this.activeDecals) this.decalPool.release(decal);
    for (const flash of this.activeFlashes) {
      flash.light.visible = false;
      flash.sprite.visible = false;
    }
    this.activeParticles.length = 0;
    this.activeTracers.length = 0;
    this.activeDecals.length = 0;
    this.activeFlashes.length = 0;
  }

  dispose(): void {
    this.clear();
    this.particleGeometry.dispose();
    this.tracerGeometry.dispose();
    this.decalGeometry.dispose();
    this.flashGeometry.dispose();
    this.tracerMaterial.dispose();
    this.decalMaterial.dispose();
    this.flashMaterial.dispose();
  }
}

export { clamp };
