/**
 * Deterministic player movement.
 *
 * `stepMovement` is a pure function: (state, input, world, profile) -> state.
 * The client runs it for prediction, the server runs it for authority, and the
 * client re-runs it over its input history when reconciling. Because it is
 * pure and reads no wall-clock time or Math.random(), all three agree.
 */

import {
  type Vec3,
  vec3,
  v3add,
  v3scale,
  v3len,
  v3normalize,
  clamp,
  yawToForward,
  yawToRight,
  moveTowards,
} from '../core/math.js';
import type { CollisionWorld } from './collision.js';
import type { MovementProfile } from '../config/movement.js';
import { MovementState } from '../types/domain.js';
import {
  GRAVITY,
  TERMINAL_VELOCITY,
  PLAYER_RADIUS,
  PLAYER_HEIGHT_STAND,
  PLAYER_HEIGHT_CROUCH,
} from '../core/constants.js';

/** Input button bitmask. Kept as bits so a full input packet stays tiny. */
export const enum InputButton {
  Jump = 1 << 0,
  Crouch = 1 << 1,
  Sprint = 1 << 2,
  Fire = 1 << 3,
  Aim = 1 << 4,
  Reload = 1 << 5,
  Dash = 1 << 6,
  Interact = 1 << 7,
  Skill = 1 << 8,
  Melee = 1 << 9,
  SwitchNext = 1 << 10,
  SwitchPrev = 1 << 11,
  Inspect = 1 << 12,
}

export interface PlayerInput {
  /** Monotonically increasing per client; used for acknowledgement. */
  sequence: number;
  /** Milliseconds this input covers. Clamped server-side against speed hacks. */
  deltaMs: number;
  /** Normalized movement intent in local space: -1..1. */
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  buttons: number;
  /** Client timestamp, used only for lag compensation, never trusted for logic. */
  clientTimeMs: number;
}

export interface MovementStateData {
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  /** Current capsule height; interpolates during crouch transitions. */
  height: number;
  jumpsUsed: number;
  wallJumpsUsed: number;
  stamina: number;
  state: MovementState;
  /** Remaining ms of the current dash/slide, 0 when inactive. */
  dashTimeMs: number;
  slideTimeMs: number;
  dashCooldownMs: number;
  slideCooldownMs: number;
  /** ms since leaving the ground — powers coyote time. */
  airTimeMs: number;
  /** ms since stamina was last spent — powers the regen delay. */
  staminaIdleMs: number;
  /** Buffered jump press, in ms remaining. */
  jumpBufferMs: number;
  /** Set for one step when the player lands; consumed by camera/audio/fall damage. */
  landedSpeed: number;
  /** True while pressing into a wall in the air, enabling a wall jump. */
  againstWall: boolean;
  /** Previous buttons, so we can detect presses (edges) rather than holds. */
  prevButtons: number;
}

export function createMovementState(position: Vec3, yaw = 0): MovementStateData {
  return {
    position: { ...position },
    velocity: vec3(0, 0, 0),
    yaw,
    pitch: 0,
    grounded: false,
    crouching: false,
    height: PLAYER_HEIGHT_STAND,
    jumpsUsed: 0,
    wallJumpsUsed: 0,
    stamina: 100,
    state: MovementState.Idle,
    dashTimeMs: 0,
    slideTimeMs: 0,
    dashCooldownMs: 0,
    slideCooldownMs: 0,
    airTimeMs: 0,
    staminaIdleMs: 0,
    jumpBufferMs: 0,
    landedSpeed: 0,
    againstWall: false,
    prevButtons: 0,
  };
}

export function cloneMovementState(s: MovementStateData): MovementStateData {
  return { ...s, position: { ...s.position }, velocity: { ...s.velocity } };
}

const pressed = (buttons: number, prev: number, bit: number): boolean =>
  (buttons & bit) !== 0 && (prev & bit) === 0;

/** Maximum a single input may advance the simulation. Anti-cheat clamp. */
export const MAX_INPUT_DELTA_MS = 60;

/**
 * Advance movement by one input.
 *
 * @returns a NEW state object; the input state is never mutated, so the client
 *          can keep a history for reconciliation.
 */
export function stepMovement(
  prev: MovementStateData,
  input: PlayerInput,
  world: CollisionWorld,
  profile: MovementProfile,
): MovementStateData {
  const s = cloneMovementState(prev);

  // Clamp dt: a client claiming a 5-second frame would otherwise teleport.
  const dtMs = clamp(input.deltaMs, 1, MAX_INPUT_DELTA_MS);
  const dt = dtMs / 1000;

  // Look direction is client-authoritative (it has no effect on position) but
  // pitch is clamped so an impossible angle can't be used to fake hitscans.
  s.yaw = input.yaw;
  s.pitch = clamp(input.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

  const buttons = input.buttons;
  const wantsCrouch = (buttons & InputButton.Crouch) !== 0;
  const wantsSprint = (buttons & InputButton.Sprint) !== 0;

  // ---- Timers ------------------------------------------------------------
  s.dashCooldownMs = Math.max(0, s.dashCooldownMs - dtMs);
  s.slideCooldownMs = Math.max(0, s.slideCooldownMs - dtMs);
  s.dashTimeMs = Math.max(0, s.dashTimeMs - dtMs);
  s.slideTimeMs = Math.max(0, s.slideTimeMs - dtMs);
  s.jumpBufferMs = Math.max(0, s.jumpBufferMs - dtMs);
  s.landedSpeed = 0;

  if (pressed(buttons, s.prevButtons, InputButton.Jump)) s.jumpBufferMs = profile.jumpBufferMs;

  // ---- Desired horizontal direction --------------------------------------
  const moveLen = Math.hypot(input.moveX, input.moveZ);
  const mx = moveLen > 1 ? input.moveX / moveLen : input.moveX;
  const mz = moveLen > 1 ? input.moveZ / moveLen : input.moveZ;
  const hasMoveInput = Math.abs(mx) > 0.01 || Math.abs(mz) > 0.01;

  const fwd = yawToForward(s.yaw);
  const right = yawToRight(s.yaw);
  const wishDir = v3normalize(
    vec3(fwd.x * mz + right.x * mx, 0, fwd.z * mz + right.z * mx),
  );

  // ---- Crouch / slide state ---------------------------------------------
  const horizontalSpeed = Math.hypot(s.velocity.x, s.velocity.z);
  const canStand = canStandUp(world, s.position);

  // Sliding: begins when crouching is pressed while sprinting on the ground.
  if (
    pressed(buttons, s.prevButtons, InputButton.Crouch) &&
    s.grounded &&
    s.slideTimeMs <= 0 &&
    s.slideCooldownMs <= 0 &&
    horizontalSpeed > profile.slideMinSpeed &&
    s.stamina >= profile.slideStaminaCost
  ) {
    s.slideTimeMs = profile.slideDurationMs;
    s.slideCooldownMs = profile.slideCooldownMs;
    s.stamina -= profile.slideStaminaCost;
    s.staminaIdleMs = 0;
    // A slide is a burst of speed in the direction you were already going.
    const dir = horizontalSpeed > 0.1 ? v3normalize(vec3(s.velocity.x, 0, s.velocity.z)) : wishDir;
    s.velocity.x += dir.x * profile.slideImpulse;
    s.velocity.z += dir.z * profile.slideImpulse;
  }

  const sliding = s.slideTimeMs > 0 && s.grounded;
  s.crouching = (wantsCrouch || sliding || !canStand) && !(s.dashTimeMs > 0);

  // Smooth the capsule height so the camera doesn't snap.
  const targetHeight = s.crouching ? PLAYER_HEIGHT_CROUCH : PLAYER_HEIGHT_STAND;
  const heightRate = (PLAYER_HEIGHT_STAND - PLAYER_HEIGHT_CROUCH) / (profile.crouchTransitionMs / 1000);
  s.height = moveTowards(s.height, targetHeight, heightRate * dt);

  // ---- Dash --------------------------------------------------------------
  if (
    pressed(buttons, s.prevButtons, InputButton.Dash) &&
    s.dashCooldownMs <= 0 &&
    s.stamina >= profile.dashStaminaCost
  ) {
    // Dash goes where you're steering, or forward if you have no input.
    const dir = hasMoveInput ? wishDir : yawToForward(s.yaw);
    s.velocity.x = dir.x * profile.dashImpulse;
    s.velocity.z = dir.z * profile.dashImpulse;
    if (!s.grounded) s.velocity.y = Math.max(s.velocity.y, 0.5);
    s.dashTimeMs = profile.dashDurationMs;
    s.dashCooldownMs = profile.dashCooldownMs;
    s.stamina -= profile.dashStaminaCost;
    s.staminaIdleMs = 0;
    s.slideTimeMs = 0;
  }

  // ---- Sprint ------------------------------------------------------------
  // Sprint requires forward intent and stamina, and is cancelled by crouching.
  const sprinting =
    wantsSprint && hasMoveInput && mz > 0.1 && !s.crouching && s.stamina > 0 && !sliding;

  if (sprinting && s.grounded) {
    s.stamina -= profile.sprintStaminaPerSec * dt;
    s.staminaIdleMs = 0;
    if (s.stamina < 0) s.stamina = 0;
  } else {
    s.staminaIdleMs += dtMs;
    if (s.staminaIdleMs >= profile.staminaRegenDelayMs) {
      s.stamina = Math.min(profile.maxStamina, s.stamina + profile.staminaRegenPerSec * dt);
    }
  }

  // ---- Target speed ------------------------------------------------------
  let targetSpeed: number;
  if (sliding) targetSpeed = 0; // slides decay via friction, not acceleration
  else if (s.crouching) targetSpeed = profile.crouchSpeed;
  else if (sprinting) targetSpeed = profile.sprintSpeed;
  else targetSpeed = profile.walkSpeed;

  // ---- Jump / wall jump --------------------------------------------------
  const coyoteOk = s.grounded || s.airTimeMs <= profile.coyoteTimeMs;

  if (s.jumpBufferMs > 0) {
    if (coyoteOk && s.jumpsUsed === 0) {
      s.velocity.y = profile.jumpVelocity;
      s.jumpsUsed = 1;
      s.grounded = false;
      s.jumpBufferMs = 0;
      s.slideTimeMs = 0;
      s.airTimeMs = profile.coyoteTimeMs + 1; // consume coyote window
    } else if (!s.grounded && s.againstWall && s.wallJumpsUsed < profile.maxWallJumps) {
      const normal = world.probeWall(s.position, PLAYER_RADIUS, s.height, profile.wallDetectDistance);
      if (normal) {
        s.velocity.y = profile.wallJumpVelocity;
        s.velocity.x += normal.x * profile.wallJumpPushback;
        s.velocity.z += normal.z * profile.wallJumpPushback;
        s.wallJumpsUsed++;
        s.jumpBufferMs = 0;
      }
    } else if (!s.grounded && s.jumpsUsed < profile.maxJumps) {
      s.velocity.y = profile.doubleJumpVelocity;
      s.jumpsUsed++;
      s.jumpBufferMs = 0;
    }
  }

  // ---- Acceleration ------------------------------------------------------
  const accel = s.grounded ? profile.groundAccel : profile.airAccel;
  const friction = s.grounded ? (sliding ? profile.slideFriction : profile.groundFriction) : profile.airFriction;

  if (s.dashTimeMs > 0) {
    // During the dash the player has no steering authority — it is committal.
  } else if (hasMoveInput && !sliding) {
    // Accelerate toward the wish velocity.
    const wishX = wishDir.x * targetSpeed;
    const wishZ = wishDir.z * targetSpeed;
    s.velocity.x = moveTowards(s.velocity.x, wishX, accel * dt);
    s.velocity.z = moveTowards(s.velocity.z, wishZ, accel * dt);
  } else {
    // Friction toward zero.
    s.velocity.x = moveTowards(s.velocity.x, 0, friction * dt);
    s.velocity.z = moveTowards(s.velocity.z, 0, friction * dt);
  }

  // Cap horizontal speed, but never below the speed a dash/slide just granted.
  const speedCap = Math.max(
    targetSpeed,
    s.dashTimeMs > 0 ? profile.dashImpulse : 0,
    sliding ? profile.sprintSpeed + profile.slideImpulse : 0,
    !s.grounded ? profile.sprintSpeed * 1.35 : 0,
  );
  const hSpeed = Math.hypot(s.velocity.x, s.velocity.z);
  if (hSpeed > speedCap && hSpeed > 1e-6) {
    const k = speedCap / hSpeed;
    s.velocity.x *= k;
    s.velocity.z *= k;
  }

  // ---- Gravity -----------------------------------------------------------
  if (!s.grounded) {
    s.velocity.y = Math.max(-TERMINAL_VELOCITY, s.velocity.y - GRAVITY * dt);
  } else if (s.velocity.y < 0) {
    s.velocity.y = 0;
  }

  // ---- Integrate & collide ----------------------------------------------
  const wasGrounded = s.grounded;
  const move = world.moveBox(
    s.position,
    s.velocity,
    dt,
    PLAYER_RADIUS,
    s.height,
    s.grounded ? profile.stepHeight : 0, // no step-up while airborne
  );

  s.position = move.position;
  s.velocity = move.velocity;
  s.grounded = move.grounded;

  if (s.grounded) {
    s.airTimeMs = 0;
    s.jumpsUsed = 0;
    s.wallJumpsUsed = 0;
    s.againstWall = false;
    if (!wasGrounded) s.landedSpeed = move.landingSpeed;
  } else {
    s.airTimeMs += dtMs;
    s.againstWall = move.hitWall;
    if (wasGrounded && s.jumpsUsed === 0) {
      // Walked off a ledge: the first jump is now the double jump once coyote expires.
      s.jumpsUsed = 0;
    }
  }

  // ---- Resolve the reported movement state (drives animation + audio) ----
  const finalSpeed = Math.hypot(s.velocity.x, s.velocity.z);
  if (s.dashTimeMs > 0) s.state = MovementState.Dash;
  else if (sliding) s.state = MovementState.Slide;
  else if (!s.grounded) s.state = MovementState.Air;
  else if (s.crouching) s.state = MovementState.Crouch;
  else if (sprinting && finalSpeed > profile.walkSpeed * 0.9) s.state = MovementState.Sprint;
  else if (finalSpeed > 0.35) s.state = MovementState.Walk;
  else s.state = MovementState.Idle;

  s.prevButtons = buttons;
  return s;
}

/** Is there headroom to stand up at this position? */
export function canStandUp(world: CollisionWorld, position: Vec3): boolean {
  const min = vec3(position.x - PLAYER_RADIUS, position.y + PLAYER_HEIGHT_CROUCH, position.z - PLAYER_RADIUS);
  const max = vec3(position.x + PLAYER_RADIUS, position.y + PLAYER_HEIGHT_STAND, position.z + PLAYER_RADIUS);
  return !world.overlapsAny(min, max);
}

/** Fall damage from a landing speed. Returns 0 below the threshold. */
export function fallDamage(landingSpeed: number, profile: MovementProfile): number {
  if (landingSpeed <= profile.fallDamageMinSpeed) return 0;
  const t = clamp(
    (landingSpeed - profile.fallDamageMinSpeed) /
      (profile.fallDamageMaxSpeed - profile.fallDamageMinSpeed),
    0,
    1,
  );
  // Quadratic so small overshoots barely hurt and long falls are lethal.
  return Math.round(profile.fallDamageMax * t * t);
}

/** Eye position for a given movement state — the camera and all shots originate here. */
export function eyePosition(s: MovementStateData): Vec3 {
  return vec3(s.position.x, s.position.y + s.height - 0.16, s.position.z);
}

/** Speed used for weapon spread ("am I moving?"). */
export function horizontalSpeed(s: MovementStateData): number {
  return Math.hypot(s.velocity.x, s.velocity.z);
}

export { v3add, v3scale, v3len };
