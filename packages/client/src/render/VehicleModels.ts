/**
 * Procedural vehicle models.
 *
 * No authored vehicle mesh ships with this build (see docs/ASSETS.md for the
 * spec: 10-16k tris, 4 wheel bones, 2048 texture). The buggy here is assembled
 * from primitives sized from the vehicle's collision box, so what the player
 * sees is exactly what the server collides — a mesh that looked bigger or
 * smaller than its hitbox would read as "I clearly hit that" misses.
 *
 * Wheels are real child objects so an authored model can bind the same four
 * names later and inherit the spin.
 */

import * as THREE from 'three';
import { clamp, getVehicle, type VehicleDefinition } from '@titan/shared';

export interface VehicleRig {
  root: THREE.Group;
  /** Front-left, front-right, rear-left, rear-right. */
  wheels: THREE.Mesh[];
  body: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  lights: THREE.MeshStandardMaterial;
  def: VehicleDefinition;
  /** Accumulated wheel rotation, in radians. */
  spin: number;
}

const FALLBACK_SIZE = { x: 1.1, y: 0.75, z: 2.1 };

export function buildVehicle(defId: string, castShadow = true): VehicleRig {
  const def = getVehicle(defId);
  const size = def?.size ?? FALLBACK_SIZE;

  const body = new THREE.MeshStandardMaterial({ color: 0x5f6672, roughness: 0.55, metalness: 0.45 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.85, metalness: 0.2 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fd3ff,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.55,
  });
  const lights = new THREE.MeshStandardMaterial({
    color: 0xfff1c0,
    emissive: new THREE.Color(0xffe9a8),
    emissiveIntensity: 1.2,
  });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.95, metalness: 0 });

  const root = new THREE.Group();
  root.name = `vehicle:${defId}`;

  const shadowed = (mesh: THREE.Mesh): THREE.Mesh => {
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  };

  // Half-extents come from the collision box; the visual sits inside it.
  const hx = size.x;
  const hy = size.y;
  const hz = size.z;
  const wheelRadius = hy * 0.55;
  const wheelWidth = hx * 0.32;

  // Chassis tub. Its underside clears the wheels' centre line.
  const tub = shadowed(new THREE.Mesh(new THREE.BoxGeometry(hx * 1.7, hy * 0.7, hz * 1.9), body));
  tub.position.y = wheelRadius + hy * 0.35;
  root.add(tub);

  // Front nose, slightly lower and narrower.
  const nose = shadowed(new THREE.Mesh(new THREE.BoxGeometry(hx * 1.4, hy * 0.45, hz * 0.5), body));
  nose.position.set(0, wheelRadius + hy * 0.25, -hz * 0.95);
  root.add(nose);

  // Roll cage: four uprights and a roof bar. Reads as "open buggy" at a glance.
  const barGeometry = new THREE.BoxGeometry(0.07, hy * 1.1, 0.07);
  const cageY = wheelRadius + hy * 0.7 + hy * 0.55;
  for (const sx of [-1, 1]) {
    for (const sz of [-0.55, 0.45]) {
      const bar = shadowed(new THREE.Mesh(barGeometry, trim));
      bar.position.set(sx * hx * 0.72, cageY, sz * hz);
      root.add(bar);
    }
  }
  const roof = shadowed(new THREE.Mesh(new THREE.BoxGeometry(hx * 1.55, 0.07, hz * 1.05), trim));
  roof.position.set(0, cageY + hy * 0.55, -hz * 0.05);
  root.add(roof);

  // Windscreen.
  const screen = new THREE.Mesh(new THREE.BoxGeometry(hx * 1.4, hy * 0.6, 0.04), glass);
  screen.position.set(0, wheelRadius + hy * 0.7 + hy * 0.3, -hz * 0.55);
  screen.rotation.x = -0.35;
  root.add(screen);

  // Seats: driver left, passenger right — matches the boarding order.
  for (const sx of [-0.4, 0.4]) {
    const seat = shadowed(new THREE.Mesh(new THREE.BoxGeometry(hx * 0.6, hy * 0.5, hz * 0.4), trim));
    seat.position.set(sx * hx, wheelRadius + hy * 0.7 + hy * 0.1, hz * 0.05);
    root.add(seat);
  }

  // Headlights, so the buggy is legible at night and from a distance.
  for (const sx of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(hx * 0.3, hy * 0.2, 0.06), lights);
    lamp.position.set(sx * hx * 0.5, wheelRadius + hy * 0.3, -hz * 1.2);
    root.add(lamp);
  }

  // Wheels.
  const wheelGeometry = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 14);
  wheelGeometry.rotateZ(Math.PI / 2);
  const wheels: THREE.Mesh[] = [];
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const wheel = shadowed(new THREE.Mesh(wheelGeometry, rubber));
    wheel.position.set(sx * hx * 0.95, wheelRadius, sz * hz * 0.62);
    root.add(wheel);
    wheels.push(wheel);
  }

  return { root, wheels, body, glass, lights, def: def ?? fallbackDef(defId), spin: 0 };
}

/** Advance wheel spin and damage tint from the latest authoritative state. */
export function updateVehicleRig(
  rig: VehicleRig,
  speed: number,
  health: number,
  destroyed: boolean,
  dt: number,
): void {
  const wheelRadius = rig.wheels[0]?.position.y ?? 0.4;
  rig.spin += (speed / Math.max(0.05, wheelRadius)) * dt;
  for (const wheel of rig.wheels) wheel.rotation.x = rig.spin;

  // Damage reads as scorching: the body darkens toward the trim colour.
  const ratio = clamp(health / Math.max(1, rig.def.health), 0, 1);
  rig.body.color.setHex(0x5f6672).lerp(new THREE.Color(0x2b2420), 1 - ratio);

  rig.lights.emissiveIntensity = destroyed ? 0 : 1.2;
  rig.glass.opacity = destroyed ? 0.15 : 0.55;
  // A wreck sits lower and stays visible until it respawns at its pad.
  rig.root.position.y = destroyed ? rig.root.position.y - 0.12 : rig.root.position.y;
}

export function disposeVehicle(rig: VehicleRig): void {
  rig.root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) for (const m of material) m.dispose();
      else material.dispose();
    }
  });
}

function fallbackDef(id: string): VehicleDefinition {
  // Only reachable if the server names a vehicle this build does not know,
  // which means the two are out of date with each other. Render something
  // rather than nothing so the mismatch is visible.
  return {
    id,
    nameKey: 'vehicle.unknown.name',
    descriptionKey: 'vehicle.unknown.desc',
    rarity: 'common' as VehicleDefinition['rarity'],
    seats: 1,
    maxSpeed: 20,
    reverseSpeed: 6,
    acceleration: 10,
    brakeForce: 20,
    steerRate: 2,
    steerSpeedFalloff: 0.5,
    grip: 8,
    mass: 900,
    health: 400,
    collisionDamageScale: 4,
    collisionDamageThreshold: 8,
    ramDamageScale: 3,
    ramDamageMax: 60,
    respawnSec: 30,
    occupantDamageScale: 0.85,
    size: FALLBACK_SIZE,
    modelKey: 'model.vehicle.unknown',
    engineSfxKey: '',
    unlockLevel: 1,
    price: 0,
    balanceNote: '',
  };
}
