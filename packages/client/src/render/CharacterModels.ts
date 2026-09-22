/**
 * Procedural character models and their animation.
 *
 * No rigged art ships with this build, so each operator is assembled from
 * primitives with a real skeleton hierarchy (hips -> spine -> head, and limbs
 * with elbow/knee joints). That means the poses below are genuine skeletal
 * animation, and swapping in an authored rig later is a matter of binding the
 * same joint names — see docs/ASSETS.md.
 *
 * Animation is procedural too: gait is driven by a phase accumulator scaled by
 * actual movement speed, so a sprinting player's legs move faster than a
 * walking one's without any authored clips.
 */

import * as THREE from 'three';
import {
  MovementState,
  RARITY_COLOR,
  TeamId,
  clamp,
  damp,
  getCharacter,
  getItem,
  type CharacterDefinition,
} from '@titan/shared';

/** Team tints, used when a character has no skin equipped. */
const TEAM_COLORS: Record<number, number> = {
  [TeamId.None]: 0x8a93a5,
  [TeamId.Alpha]: 0x3f8ce8,
  [TeamId.Bravo]: 0xf0674a,
};

export interface CharacterRig {
  root: THREE.Group;
  hips: THREE.Group;
  spine: THREE.Group;
  head: THREE.Group;
  armLeft: THREE.Group;
  armRight: THREE.Group;
  forearmLeft: THREE.Group;
  forearmRight: THREE.Group;
  legLeft: THREE.Group;
  legRight: THREE.Group;
  shinLeft: THREE.Group;
  shinRight: THREE.Group;
  weapon: THREE.Group;
  /** Gait phase, advanced by movement speed. */
  phase: number;
  /** Smoothed values so the pose doesn't snap between states. */
  lean: number;
  crouch: number;
  materials: THREE.MeshStandardMaterial[];
}

function jointBox(
  width: number,
  height: number,
  depth: number,
  material: THREE.Material,
  /** Pivot at the top of the box, so rotation works like a real joint. */
  pivotAtTop = true,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  if (pivotAtTop) geometry.translate(0, -height / 2, 0);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildCharacter(
  characterId: string,
  team: TeamId,
  skinId: string | null,
  castShadow = true,
): CharacterRig {
  const def: CharacterDefinition | undefined = getCharacter(characterId);
  const height = def?.build.height ?? 1.8;
  const shoulders = def?.build.shoulderWidth ?? 0.5;

  // A skin overrides the team tint for the body but not the accent, so team
  // identity stays readable at a glance — the thing that must never be lost.
  const skin = skinId ? getItem(skinId) : null;
  const bodyColor = skin?.visual.color ?? 0x3c4250;
  const accentColor = TEAM_COLORS[team] ?? def?.build.accentColor ?? 0x8a93a5;

  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    roughness: skin?.visual.finish === 'metallic' ? 0.35 : 0.72,
    metalness: skin?.visual.finish === 'metallic' ? 0.8 : 0.15,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.5,
    metalness: 0.3,
    emissive: new THREE.Color(accentColor),
    emissiveIntensity: 0.35,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.8, metalness: 0.2 });

  if (skin?.visual.finish === 'emissive') {
    bodyMat.emissive = new THREE.Color(skin.visual.accent);
    bodyMat.emissiveIntensity = 0.5;
  }

  const root = new THREE.Group();
  root.name = `character:${characterId}`;

  // Proportions as fractions of total height.
  const legLength = height * 0.46;
  const thighLength = legLength * 0.52;
  const shinLength = legLength - thighLength;
  const torsoLength = height * 0.3;
  const headSize = height * 0.13;
  const armLength = height * 0.36;
  const upperArm = armLength * 0.5;

  // Hips sit at the top of the legs.
  const hips = new THREE.Group();
  hips.position.y = legLength;
  root.add(hips);

  const pelvis = jointBox(shoulders * 0.85, height * 0.1, 0.24, bodyMat, false);
  pelvis.position.y = height * 0.03;
  hips.add(pelvis);

  const spine = new THREE.Group();
  hips.add(spine);
  const chest = jointBox(shoulders, torsoLength, 0.28, bodyMat, false);
  chest.position.y = torsoLength / 2 + height * 0.06;
  spine.add(chest);

  // Chest accent panel — the team-colour read at distance.
  const panel = jointBox(shoulders * 0.55, torsoLength * 0.45, 0.06, accentMat, false);
  panel.position.set(0, torsoLength / 2 + height * 0.08, 0.16);
  spine.add(panel);

  const head = new THREE.Group();
  head.position.y = torsoLength + height * 0.09;
  spine.add(head);
  const skull = jointBox(headSize, headSize, headSize, bodyMat, false);
  skull.position.y = headSize / 2;
  head.add(skull);
  const visor = jointBox(headSize * 0.8, headSize * 0.3, 0.04, accentMat, false);
  visor.position.set(0, headSize * 0.55, headSize * 0.5);
  head.add(visor);

  const makeArm = (side: 1 | -1): { arm: THREE.Group; forearm: THREE.Group } => {
    const arm = new THREE.Group();
    arm.position.set(side * (shoulders / 2 + 0.06), torsoLength + height * 0.03, 0);
    spine.add(arm);
    arm.add(jointBox(0.11, upperArm, 0.11, bodyMat));

    const forearm = new THREE.Group();
    forearm.position.y = -upperArm;
    arm.add(forearm);
    forearm.add(jointBox(0.095, armLength - upperArm, 0.095, darkMat));
    return { arm, forearm };
  };

  const makeLeg = (side: 1 | -1): { leg: THREE.Group; shin: THREE.Group } => {
    const leg = new THREE.Group();
    leg.position.set(side * shoulders * 0.22, 0, 0);
    hips.add(leg);
    leg.add(jointBox(0.14, thighLength, 0.15, bodyMat));

    const shin = new THREE.Group();
    shin.position.y = -thighLength;
    leg.add(shin);
    shin.add(jointBox(0.12, shinLength, 0.13, darkMat));

    const boot = jointBox(0.15, 0.1, 0.26, darkMat, false);
    boot.position.set(0, -shinLength + 0.05, 0.05);
    shin.add(boot);
    return { leg, shin };
  };

  const left = makeArm(-1);
  const right = makeArm(1);
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // The weapon hangs off the right hand.
  const weapon = new THREE.Group();
  weapon.position.set(0, -(armLength - upperArm), 0.05);
  right.forearm.add(weapon);
  const weaponBody = jointBox(0.08, 0.1, 0.62, darkMat, false);
  weaponBody.rotation.x = Math.PI / 2;
  weapon.add(weaponBody);

  if (castShadow) {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  return {
    root,
    hips,
    spine,
    head,
    armLeft: left.arm,
    armRight: right.arm,
    forearmLeft: left.forearm,
    forearmRight: right.forearm,
    legLeft: legL.leg,
    legRight: legR.leg,
    shinLeft: legL.shin,
    shinRight: legR.shin,
    weapon,
    phase: 0,
    lean: 0,
    crouch: 0,
    materials: [bodyMat, accentMat, darkMat],
  };
}

export interface PoseInput {
  state: MovementState;
  /** Horizontal speed in m/s. */
  speed: number;
  /** Look pitch in radians. */
  pitch: number;
  aiming: boolean;
  alive: boolean;
  dt: number;
}

/**
 * Pose the rig for this frame.
 *
 * The gait phase advances with distance travelled rather than time, so the
 * feet don't skate: at twice the speed, the legs cycle twice as fast.
 */
export function poseCharacter(rig: CharacterRig, input: PoseInput): void {
  const { dt } = input;

  if (!input.alive) {
    // Death: collapse forward. Kept simple and readable rather than ragdolled,
    // because a clear "that player is down" read matters more than realism.
    rig.hips.rotation.x = damp(rig.hips.rotation.x, Math.PI / 2.2, 8, dt);
    rig.hips.position.y = damp(rig.hips.position.y, 0.25, 8, dt);
    rig.spine.rotation.x = damp(rig.spine.rotation.x, 0.3, 8, dt);
    for (const joint of [rig.armLeft, rig.armRight, rig.legLeft, rig.legRight]) {
      joint.rotation.x = damp(joint.rotation.x, 0.2, 6, dt);
    }
    return;
  }

  const sliding = input.state === MovementState.Slide;
  const crouching = input.state === MovementState.Crouch || sliding;
  const airborne = input.state === MovementState.Air;

  // Advance the gait by distance covered.
  const strideLength = 1.5;
  if (!airborne && input.speed > 0.3) {
    rig.phase += (input.speed * dt) / strideLength * Math.PI * 2;
  } else {
    // Ease back to a neutral stance rather than freezing mid-step.
    rig.phase = damp(rig.phase % (Math.PI * 2), 0, 6, dt);
  }

  const swing = clamp(input.speed / 8, 0, 1);
  const legSwing = Math.sin(rig.phase) * 0.7 * swing;
  const armSwing = Math.sin(rig.phase) * 0.5 * swing;

  // Targets.
  rig.crouch = damp(rig.crouch, crouching ? 1 : 0, 12, dt);
  const leanTarget = sliding ? 0.7 : airborne ? 0.12 : swing * 0.18;
  rig.lean = damp(rig.lean, leanTarget, 8, dt);

  // Hips drop when crouching, and bob slightly with the gait.
  const bob = Math.abs(Math.sin(rig.phase)) * 0.04 * swing;
  rig.hips.position.y = damp(rig.hips.position.y, 0.83 - rig.crouch * 0.42 + bob, 14, dt);
  rig.hips.rotation.x = damp(rig.hips.rotation.x, rig.lean * 0.4, 10, dt);

  rig.spine.rotation.x = damp(rig.spine.rotation.x, rig.lean * 0.5 + rig.crouch * 0.25, 10, dt);
  // The head tracks the player's actual look pitch, which is what sells the
  // "that player is looking at me" read.
  rig.head.rotation.x = damp(rig.head.rotation.x, -input.pitch * 0.6 - rig.lean * 0.4, 14, dt);

  // Legs.
  if (airborne) {
    rig.legLeft.rotation.x = damp(rig.legLeft.rotation.x, -0.35, 8, dt);
    rig.legRight.rotation.x = damp(rig.legRight.rotation.x, 0.2, 8, dt);
    rig.shinLeft.rotation.x = damp(rig.shinLeft.rotation.x, 0.6, 8, dt);
    rig.shinRight.rotation.x = damp(rig.shinRight.rotation.x, 0.25, 8, dt);
  } else {
    rig.legLeft.rotation.x = legSwing - rig.crouch * 0.5;
    rig.legRight.rotation.x = -legSwing - rig.crouch * 0.5;
    // Knees only bend backwards.
    rig.shinLeft.rotation.x = Math.max(0, -legSwing * 0.8) + rig.crouch * 0.9;
    rig.shinRight.rotation.x = Math.max(0, legSwing * 0.8) + rig.crouch * 0.9;
  }

  // Arms. When aiming, both hands come up to the weapon and stop swinging.
  const aimBlend = input.aiming ? 1 : 0;
  const rightTarget = -1.35 * aimBlend + (1 - aimBlend) * (-0.25 - armSwing);
  const leftTarget = -1.2 * aimBlend + (1 - aimBlend) * (-0.25 + armSwing);

  rig.armRight.rotation.x = damp(rig.armRight.rotation.x, rightTarget - input.pitch * 0.5, 12, dt);
  rig.armLeft.rotation.x = damp(rig.armLeft.rotation.x, leftTarget - input.pitch * 0.4, 12, dt);
  rig.armLeft.rotation.z = damp(rig.armLeft.rotation.z, aimBlend * 0.45, 12, dt);
  rig.armRight.rotation.z = damp(rig.armRight.rotation.z, aimBlend * -0.2, 12, dt);
  rig.forearmRight.rotation.x = damp(rig.forearmRight.rotation.x, aimBlend * -0.3, 12, dt);
  rig.forearmLeft.rotation.x = damp(rig.forearmLeft.rotation.x, aimBlend * -0.8, 12, dt);
}

/** Free a rig's GPU resources. */
export function disposeCharacter(rig: CharacterRig): void {
  rig.root.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  for (const material of rig.materials) material.dispose();
}

/** Rarity beam shown above a dropped legendary item, if one is ever added. */
export function rarityColor(rarity: keyof typeof RARITY_COLOR): number {
  return RARITY_COLOR[rarity];
}
