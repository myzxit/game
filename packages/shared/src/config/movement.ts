/**
 * Movement tuning.
 *
 * These numbers are the feel of the game. They are shared verbatim between the
 * client's prediction and the server's authoritative simulation — changing one
 * value here changes both, which is exactly what keeps prediction correct.
 */

export interface MovementProfile {
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  /** Speed while airborne is not capped to this; it's the air *control* target. */
  airSpeed: number;

  /** Ground acceleration/friction, in units of speed per second. */
  groundAccel: number;
  groundFriction: number;
  /** Air acceleration is deliberately low so air movement is committal. */
  airAccel: number;
  airFriction: number;

  jumpVelocity: number;
  doubleJumpVelocity: number;
  maxJumps: number;
  /** Window after leaving a ledge in which a jump still registers. */
  coyoteTimeMs: number;
  /** Window before landing in which a jump press is buffered. */
  jumpBufferMs: number;

  /** Dash. */
  dashImpulse: number;
  dashDurationMs: number;
  dashCooldownMs: number;
  dashStaminaCost: number;

  /** Slide: entered from a sprint, decays to a crouch. */
  slideImpulse: number;
  slideDurationMs: number;
  slideFriction: number;
  slideMinSpeed: number;
  slideCooldownMs: number;
  slideStaminaCost: number;

  /** Wall jump. */
  wallJumpVelocity: number;
  wallJumpPushback: number;
  wallDetectDistance: number;
  maxWallJumps: number;

  /** Stamina gates sprint, dash and slide. */
  maxStamina: number;
  staminaRegenPerSec: number;
  staminaRegenDelayMs: number;
  sprintStaminaPerSec: number;

  /** Fall damage begins above this landing speed. */
  fallDamageMinSpeed: number;
  fallDamageMaxSpeed: number;
  fallDamageMax: number;

  /** Step-up height for stairs and small ledges. */
  stepHeight: number;
  /** Surfaces steeper than this (radians from horizontal) are not walkable. */
  maxSlopeAngle: number;
  /** Crouch transition time. */
  crouchTransitionMs: number;
}

export const DEFAULT_MOVEMENT: MovementProfile = {
  walkSpeed: 5.6,
  sprintSpeed: 8.4,
  crouchSpeed: 2.9,
  airSpeed: 6.4,

  groundAccel: 62,
  groundFriction: 46,
  airAccel: 14,
  airFriction: 0.6,

  jumpVelocity: 7.4,
  doubleJumpVelocity: 6.5,
  maxJumps: 2,
  coyoteTimeMs: 110,
  jumpBufferMs: 130,

  dashImpulse: 15.5,
  dashDurationMs: 190,
  dashCooldownMs: 1600,
  dashStaminaCost: 28,

  slideImpulse: 5.0,
  slideDurationMs: 900,
  slideFriction: 6.5,
  slideMinSpeed: 3.2,
  slideCooldownMs: 900,
  slideStaminaCost: 18,

  wallJumpVelocity: 7.0,
  wallJumpPushback: 6.2,
  wallDetectDistance: 0.62,
  maxWallJumps: 2,

  maxStamina: 100,
  staminaRegenPerSec: 26,
  staminaRegenDelayMs: 700,
  sprintStaminaPerSec: 12,

  fallDamageMinSpeed: 19,
  fallDamageMaxSpeed: 42,
  fallDamageMax: 85,

  stepHeight: 0.42,
  maxSlopeAngle: 0.85, // ~48.7 degrees
  crouchTransitionMs: 140,
};

/**
 * Build the effective profile for a player: base tuning scaled by their
 * character and the weapon they are currently holding.
 */
export function effectiveMovement(
  base: MovementProfile,
  characterMultiplier: number,
  weaponMobility: number,
): MovementProfile {
  const s = characterMultiplier * weaponMobility;
  return {
    ...base,
    walkSpeed: base.walkSpeed * s,
    sprintSpeed: base.sprintSpeed * s,
    crouchSpeed: base.crouchSpeed * s,
    airSpeed: base.airSpeed * s,
    // Impulses scale with the character but not the weapon: a heavy gun should
    // not shorten your dash, or heavy-weapon players lose all escape options.
    dashImpulse: base.dashImpulse * characterMultiplier,
    slideImpulse: base.slideImpulse * characterMultiplier,
  };
}
