/**
 * First-person camera.
 *
 * Camera feel is largely a matter of *what the camera does that the player did
 * not ask for*: the FOV that widens as you sprint, the dip when you land, the
 * shake when something explodes nearby. Each of those is a separate, tunable
 * offset here, and every one of them respects the accessibility settings — a
 * player with `cameraShake: 0` gets a perfectly steady camera and loses no
 * information, because none of these effects carry gameplay data.
 */

import * as THREE from 'three';
import { clamp, damp, lerp, type Vec3 } from '@titan/shared';
import type { AccessibilitySettings, GameplaySettings } from '../core/Settings.js';

export interface CameraInput {
  /** Eye position from the predicted local player. */
  eye: Vec3;
  yaw: number;
  pitch: number;
  /** 0-1 ADS progress. */
  ads: number;
  /** Target FOV while aiming, from the weapon. */
  adsFov: number;
  speed: number;
  sprinting: boolean;
  grounded: boolean;
  /** Landing speed for one frame after touching down. */
  landImpact: number;
  /** Server recoil, which the view blends toward. */
  recoilPitch: number;
  recoilYaw: number;
  dt: number;
}

interface ShakeSource {
  strength: number;
  frequency: number;
  remaining: number;
  duration: number;
}

export class CameraController {
  private baseFov: number;
  private currentFov: number;
  private landDip = 0;
  private bobPhase = 0;
  private readonly shakes: ShakeSource[] = [];
  /** Roll applied when strafing, for a subtle sense of momentum. */
  private strafeRoll = 0;
  private lastYaw = 0;
  private deathTime = 0;

  /** Set while spectating; the camera follows a target instead of the player. */
  private spectatePosition: THREE.Vector3 | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private gameplay: GameplaySettings,
    private accessibility: AccessibilitySettings,
  ) {
    this.baseFov = gameplay.fov;
    this.currentFov = gameplay.fov;
  }

  applySettings(gameplay: GameplaySettings, accessibility: AccessibilitySettings): void {
    this.gameplay = gameplay;
    this.accessibility = accessibility;
    this.baseFov = gameplay.fov;
  }

  /**
   * Add camera shake.
   * `strength` is in radians of peak deflection; anything above ~0.05 is very
   * aggressive. Scaled by the accessibility setting, and skipped entirely at 0.
   */
  addShake(strength: number, duration = 0.35, frequency = 28): void {
    const scaled = strength * this.accessibility.cameraShake;
    if (scaled <= 0.0001) return;
    this.shakes.push({ strength: scaled, frequency, remaining: duration, duration });
    // Keep the list bounded; overlapping shakes past a handful are inaudible.
    if (this.shakes.length > 6) this.shakes.shift();
  }

  /** Shake scaled by distance, for explosions. */
  addExplosionShake(distance: number, radius: number): void {
    const falloff = clamp(1 - distance / (radius * 3), 0, 1);
    if (falloff <= 0) return;
    this.addShake(0.05 * falloff, 0.5, 22);
  }

  /** Called when the local player dies: the camera drops and tilts. */
  onDeath(): void {
    this.deathTime = 1;
  }

  onRespawn(): void {
    this.deathTime = 0;
    this.landDip = 0;
    this.shakes.length = 0;
  }

  /** Spectate a world position instead of the local player. */
  setSpectateTarget(position: Vec3 | null): void {
    this.spectatePosition = position
      ? new THREE.Vector3(position.x, position.y, position.z)
      : null;
  }

  update(input: CameraInput): void {
    const dt = Math.min(input.dt, 0.05);

    // ---- FOV ------------------------------------------------------------
    // Sprinting widens the view slightly (a speed cue), aiming narrows it to
    // the weapon's scope FOV. Both are eased so neither snaps.
    const sprintFov = input.sprinting && input.grounded ? this.baseFov + 8 : this.baseFov;
    const targetFov = lerp(sprintFov, input.adsFov, input.ads);
    this.currentFov = damp(this.currentFov, targetFov, 12, dt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // ---- Landing dip ----------------------------------------------------
    if (input.landImpact > 0 && !this.accessibility.reduceMotion) {
      this.landDip = Math.min(0.16, this.landDip + input.landImpact * 0.005);
      if (input.landImpact > 12) this.addShake(0.012 * (input.landImpact / 20), 0.25, 20);
    }
    this.landDip = damp(this.landDip, 0, 9, dt);

    // ---- Head bob -------------------------------------------------------
    // Reduced heavily while aiming, and off entirely under reduce-motion.
    let bobX = 0;
    let bobY = 0;
    if (!this.accessibility.reduceMotion) {
      if (input.grounded && input.speed > 0.4) {
        this.bobPhase += (input.speed * dt) / 1.5 * Math.PI * 2;
      } else {
        this.bobPhase = damp(this.bobPhase % (Math.PI * 2), 0, 5, dt);
      }
      const amount = clamp(input.speed / 8, 0, 1) * lerp(0.02, 0.004, input.ads);
      bobX = Math.sin(this.bobPhase) * amount * 0.5;
      bobY = Math.abs(Math.cos(this.bobPhase)) * amount;
    }

    // ---- Strafe roll ----------------------------------------------------
    const yawDelta = input.yaw - this.lastYaw;
    this.lastYaw = input.yaw;
    const rollTarget = this.accessibility.reduceMotion
      ? 0
      : clamp(-yawDelta * 2.2, -0.035, 0.035) * (1 - input.ads * 0.7);
    this.strafeRoll = damp(this.strafeRoll, rollTarget, 8, dt);

    // ---- Shake ----------------------------------------------------------
    let shakeX = 0;
    let shakeY = 0;
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const shake = this.shakes[i]!;
      shake.remaining -= dt;
      if (shake.remaining <= 0) {
        this.shakes.splice(i, 1);
        continue;
      }
      const t = shake.remaining / shake.duration;
      // Decay quadratically so shakes end softly rather than cutting off.
      const amplitude = shake.strength * t * t;
      const phase = (shake.duration - shake.remaining) * shake.frequency;
      shakeX += Math.sin(phase * 1.7) * amplitude;
      shakeY += Math.cos(phase * 2.3) * amplitude;
    }

    // ---- Death ----------------------------------------------------------
    let deathPitch = 0;
    let deathDrop = 0;
    let deathRoll = 0;
    if (this.deathTime > 0) {
      this.deathTime = Math.max(0, this.deathTime - dt * 0.8);
      const fallen = 1 - this.deathTime;
      deathDrop = fallen * 0.9;
      deathPitch = fallen * 0.35;
      deathRoll = fallen * 0.6;
    }

    // ---- Compose --------------------------------------------------------
    const position = this.spectatePosition ?? new THREE.Vector3(input.eye.x, input.eye.y, input.eye.z);
    this.camera.position.set(
      position.x + bobX,
      position.y - bobY - this.landDip - deathDrop,
      position.z,
    );

    // Aim comes from the player's own yaw/pitch plus the server's recoil, so
    // what the player sees matches what the server simulated.
    const pitch = clamp(
      input.pitch + input.recoilPitch + shakeY + deathPitch,
      -Math.PI / 2 + 0.01,
      Math.PI / 2 - 0.01,
    );
    const yaw = input.yaw + input.recoilYaw + shakeX;

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(pitch, yaw, this.strafeRoll + deathRoll);
  }

  get fov(): number {
    return this.currentFov;
  }

  /** Forward vector, for spawning effects and raycasting UI. */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }
}
