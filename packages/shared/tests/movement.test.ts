import { describe, it, expect } from 'vitest';
import {
  CollisionWorld,
  createMovementState,
  stepMovement,
  canStandUp,
  fallDamage,
  eyePosition,
  InputButton,
  DEFAULT_MOVEMENT,
  effectiveMovement,
  MovementState,
  SurfaceMaterial,
  vec3,
  type PlayerInput,
  type Brush,
  PLAYER_HEIGHT_STAND,
  PLAYER_HEIGHT_CROUCH,
} from '../src/index.js';

/** A 40x40 floor at y=0, with an optional set of extra brushes. */
function makeWorld(extra: Brush[] = []): CollisionWorld {
  const floor: Brush = {
    id: 1,
    min: vec3(-20, -1, -20),
    max: vec3(20, 0, 20),
    material: SurfaceMaterial.Concrete,
  };
  return new CollisionWorld([floor, ...extra]);
}

const input = (o: Partial<PlayerInput> = {}): PlayerInput => ({
  sequence: 0,
  deltaMs: 16,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  clientTimeMs: 0,
  ...o,
});

/** Run `count` steps, optionally varying the input per step. */
function simulate(
  world: CollisionWorld,
  steps: number,
  make: (i: number) => PlayerInput,
  start = createMovementState(vec3(0, 0.5, 0)),
) {
  let state = start;
  for (let i = 0; i < steps; i++) {
    state = stepMovement(state, make(i), world, DEFAULT_MOVEMENT);
  }
  return state;
}

describe('movement — gravity and ground', () => {
  it('falls under gravity and comes to rest on the floor', () => {
    const world = makeWorld();
    const state = simulate(world, 60, (i) => input({ sequence: i }), createMovementState(vec3(0, 5, 0)));

    expect(state.grounded).toBe(true);
    expect(state.position.y).toBeGreaterThanOrEqual(0);
    expect(state.position.y).toBeLessThan(0.05);
    expect(state.velocity.y).toBe(0);
  });

  it('does not fall through the floor at high speed', () => {
    const world = makeWorld();
    const start = createMovementState(vec3(0, 40, 0));
    const state = simulate(world, 200, (i) => input({ sequence: i }), start);
    expect(state.position.y).toBeGreaterThanOrEqual(0);
    expect(state.grounded).toBe(true);
  });

  it('reports idle when standing still', () => {
    const world = makeWorld();
    const state = simulate(world, 40, (i) => input({ sequence: i }));
    expect(state.state).toBe(MovementState.Idle);
  });
});

describe('movement — walking and sprinting', () => {
  it('moves forward and reaches approximately walk speed', () => {
    const world = makeWorld();
    const state = simulate(world, 60, (i) => input({ sequence: i, moveZ: 1 }));

    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    expect(speed).toBeGreaterThan(DEFAULT_MOVEMENT.walkSpeed * 0.9);
    expect(speed).toBeLessThanOrEqual(DEFAULT_MOVEMENT.walkSpeed + 0.01);
    // Forward with yaw 0 is -Z.
    expect(state.position.z).toBeLessThan(-1);
    expect(state.state).toBe(MovementState.Walk);
  });

  it('sprint is faster than walk and drains stamina', () => {
    const world = makeWorld();
    const walk = simulate(world, 60, (i) => input({ sequence: i, moveZ: 1 }));
    const sprint = simulate(world, 60, (i) =>
      input({ sequence: i, moveZ: 1, buttons: InputButton.Sprint }),
    );

    const walkSpeed = Math.hypot(walk.velocity.x, walk.velocity.z);
    const sprintSpeed = Math.hypot(sprint.velocity.x, sprint.velocity.z);
    expect(sprintSpeed).toBeGreaterThan(walkSpeed);
    expect(sprint.stamina).toBeLessThan(DEFAULT_MOVEMENT.maxStamina);
    expect(sprint.state).toBe(MovementState.Sprint);
  });

  it('cannot sprint backwards', () => {
    const world = makeWorld();
    const state = simulate(world, 60, (i) =>
      input({ sequence: i, moveZ: -1, buttons: InputButton.Sprint }),
    );
    expect(state.state).not.toBe(MovementState.Sprint);
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    expect(speed).toBeLessThanOrEqual(DEFAULT_MOVEMENT.walkSpeed + 0.01);
  });

  it('stamina regenerates after the delay when not sprinting', () => {
    const world = makeWorld();
    const drained = simulate(world, 200, (i) =>
      input({ sequence: i, moveZ: 1, buttons: InputButton.Sprint }),
    );
    expect(drained.stamina).toBeLessThan(DEFAULT_MOVEMENT.maxStamina);

    const recovered = simulate(world, 300, (i) => input({ sequence: i }), drained);
    expect(recovered.stamina).toBeGreaterThan(drained.stamina);
  });

  it('diagonal input does not exceed the speed cap', () => {
    const world = makeWorld();
    const state = simulate(world, 80, (i) => input({ sequence: i, moveX: 1, moveZ: 1 }));
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    expect(speed).toBeLessThanOrEqual(DEFAULT_MOVEMENT.walkSpeed + 0.01);
  });
});

describe('movement — jumping', () => {
  it('jumps on a press edge and returns to the ground', () => {
    const world = makeWorld();
    let state = simulate(world, 20, (i) => input({ sequence: i }));
    expect(state.grounded).toBe(true);

    state = stepMovement(state, input({ sequence: 100, buttons: InputButton.Jump }), world, DEFAULT_MOVEMENT);
    expect(state.velocity.y).toBeGreaterThan(0);
    expect(state.grounded).toBe(false);

    // Hold the button: should not double-jump from a held press.
    const held = simulate(world, 4, (i) => input({ sequence: 101 + i, buttons: InputButton.Jump }), state);
    expect(held.jumpsUsed).toBe(1);

    const landed = simulate(world, 120, (i) => input({ sequence: 200 + i }), state);
    expect(landed.grounded).toBe(true);
    expect(landed.jumpsUsed).toBe(0);
  });

  it('supports a double jump from a fresh press in the air', () => {
    const world = makeWorld();
    let state = simulate(world, 20, (i) => input({ sequence: i }));
    state = stepMovement(state, input({ sequence: 50, buttons: InputButton.Jump }), world, DEFAULT_MOVEMENT);
    // Release.
    state = stepMovement(state, input({ sequence: 51 }), world, DEFAULT_MOVEMENT);
    expect(state.jumpsUsed).toBe(1);
    // Press again mid-air.
    state = stepMovement(state, input({ sequence: 52, buttons: InputButton.Jump }), world, DEFAULT_MOVEMENT);
    expect(state.jumpsUsed).toBe(2);
    expect(state.velocity.y).toBeGreaterThan(0);
  });
});

describe('movement — crouch and slide', () => {
  it('crouching lowers the capsule and slows the player', () => {
    const world = makeWorld();
    const state = simulate(world, 80, (i) =>
      input({ sequence: i, moveZ: 1, buttons: InputButton.Crouch }),
    );
    expect(state.crouching).toBe(true);
    expect(state.height).toBeCloseTo(PLAYER_HEIGHT_CROUCH, 1);
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    expect(speed).toBeLessThanOrEqual(DEFAULT_MOVEMENT.crouchSpeed + 0.01);
  });

  it('sliding from a sprint produces a speed burst', () => {
    const world = makeWorld();
    // Build up a sprint first.
    let state = simulate(world, 60, (i) =>
      input({ sequence: i, moveZ: 1, buttons: InputButton.Sprint }),
    );
    const sprintSpeed = Math.hypot(state.velocity.x, state.velocity.z);

    // Press crouch on the next frame to slide.
    state = stepMovement(
      state,
      input({ sequence: 100, moveZ: 1, buttons: InputButton.Sprint | InputButton.Crouch }),
      world,
      DEFAULT_MOVEMENT,
    );

    expect(state.state).toBe(MovementState.Slide);
    const slideSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    expect(slideSpeed).toBeGreaterThan(sprintSpeed);
  });

  it('cannot stand up under a low ceiling', () => {
    const ceiling: Brush = {
      id: 2,
      min: vec3(-2, 1.2, -2),
      max: vec3(2, 2.0, 2),
      material: SurfaceMaterial.Concrete,
    };
    const world = makeWorld([ceiling]);
    expect(canStandUp(world, vec3(0, 0, 0))).toBe(false);
    expect(canStandUp(world, vec3(10, 0, 10))).toBe(true);

    // A player under the ceiling stays crouched even without pressing crouch.
    const state = simulate(world, 40, (i) => input({ sequence: i }), createMovementState(vec3(0, 0.1, 0)));
    expect(state.crouching).toBe(true);
    expect(state.height).toBeLessThan(PLAYER_HEIGHT_STAND);
  });
});

describe('movement — dash', () => {
  it('dash applies an impulse and enters cooldown', () => {
    const world = makeWorld();
    let state = simulate(world, 20, (i) => input({ sequence: i }));
    state = stepMovement(
      state,
      input({ sequence: 50, moveZ: 1, buttons: InputButton.Dash }),
      world,
      DEFAULT_MOVEMENT,
    );

    expect(state.state).toBe(MovementState.Dash);
    expect(state.dashCooldownMs).toBeGreaterThan(0);
    expect(state.stamina).toBeLessThan(DEFAULT_MOVEMENT.maxStamina);
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    expect(speed).toBeGreaterThan(DEFAULT_MOVEMENT.sprintSpeed);
  });

  it('dash cannot be spammed while on cooldown', () => {
    const world = makeWorld();
    let state = simulate(world, 20, (i) => input({ sequence: i }));
    state = stepMovement(state, input({ sequence: 50, buttons: InputButton.Dash }), world, DEFAULT_MOVEMENT);
    const staminaAfterFirst = state.stamina;

    // Release then press again immediately.
    state = stepMovement(state, input({ sequence: 51 }), world, DEFAULT_MOVEMENT);
    state = stepMovement(state, input({ sequence: 52, buttons: InputButton.Dash }), world, DEFAULT_MOVEMENT);

    // No second dash: stamina should only have regenerated, never dropped again.
    expect(state.stamina).toBeGreaterThanOrEqual(staminaAfterFirst - 0.001);
  });
});

describe('movement — collision', () => {
  it('is blocked by a wall and slides along it', () => {
    const wall: Brush = {
      id: 2,
      min: vec3(-10, 0, -6),
      max: vec3(10, 4, -5),
      material: SurfaceMaterial.Concrete,
    };
    const world = makeWorld([wall]);

    // Walk forward (-Z) into the wall while also strafing. Kept short enough
    // that the player cannot simply travel around the wall's 10m end.
    const state = simulate(world, 60, (i) => input({ sequence: i, moveZ: 1, moveX: 1 }));

    // Stopped by the wall on Z...
    expect(state.position.z).toBeGreaterThan(-5.1);
    // ...but still slid along X.
    expect(state.position.x).toBeGreaterThan(1);
    expect(Math.abs(state.position.x)).toBeLessThan(10);
  });

  it('steps up onto a low ledge', () => {
    const step: Brush = {
      id: 2,
      min: vec3(-10, 0, -8),
      max: vec3(10, 0.3, -4),
      material: SurfaceMaterial.Concrete,
    };
    const world = makeWorld([step]);
    // Stop while still on top of the ledge (its far edge is at z = -8).
    const state = simulate(world, 70, (i) => input({ sequence: i, moveZ: 1 }));

    expect(state.position.z).toBeLessThan(-4);
    expect(state.position.z).toBeGreaterThan(-8);
    expect(state.position.y).toBeGreaterThan(0.25);
    expect(state.grounded).toBe(true);
  });

  it('does not eject a player who starts embedded in geometry', () => {
    // A player spawned with their head inside a slab must fall to the floor,
    // not be teleported on top of the slab.
    const slab: Brush = {
      id: 2,
      min: vec3(-2, 1.2, -2),
      max: vec3(2, 2.0, 2),
      material: SurfaceMaterial.Concrete,
    };
    const world = makeWorld([slab]);
    const state = simulate(world, 40, (i) => input({ sequence: i }), createMovementState(vec3(0, 0.1, 0)));

    expect(state.position.y).toBeLessThan(0.2);
    expect(state.grounded).toBe(true);
  });

  it('is blocked by a ledge taller than the step height', () => {
    const tall: Brush = {
      id: 2,
      min: vec3(-10, 0, -8),
      max: vec3(10, 1.2, -4),
      material: SurfaceMaterial.Concrete,
    };
    const world = makeWorld([tall]);
    const state = simulate(world, 200, (i) => input({ sequence: i, moveZ: 1 }));
    expect(state.position.z).toBeGreaterThan(-4.1);
  });
});

describe('movement — determinism', () => {
  it('produces identical results for identical input sequences', () => {
    const world = makeWorld();
    const script = (i: number): PlayerInput =>
      input({
        sequence: i,
        moveX: Math.sin(i * 0.3),
        moveZ: Math.cos(i * 0.2),
        yaw: i * 0.05,
        buttons: i % 17 === 0 ? InputButton.Jump : i % 23 === 0 ? InputButton.Dash : InputButton.Sprint,
      });

    const a = simulate(world, 300, script);
    const b = simulate(world, 300, script);

    expect(a.position).toEqual(b.position);
    expect(a.velocity).toEqual(b.velocity);
    expect(a.stamina).toBe(b.stamina);
    expect(a.state).toBe(b.state);
  });

  it('does not mutate the input state object', () => {
    const world = makeWorld();
    const start = createMovementState(vec3(0, 5, 0));
    const snapshot = JSON.parse(JSON.stringify(start));
    stepMovement(start, input({ moveZ: 1 }), world, DEFAULT_MOVEMENT);
    expect(JSON.parse(JSON.stringify(start))).toEqual(snapshot);
  });

  it('clamps an oversized deltaMs so a client cannot teleport', () => {
    const world = makeWorld();
    const start = createMovementState(vec3(0, 0.5, 0));
    const cheat = stepMovement(start, input({ moveZ: 1, deltaMs: 5000 }), world, DEFAULT_MOVEMENT);
    const honest = stepMovement(start, input({ moveZ: 1, deltaMs: 60 }), world, DEFAULT_MOVEMENT);
    expect(cheat.position.z).toBeCloseTo(honest.position.z, 5);
  });
});

describe('movement — helpers', () => {
  it('fall damage scales with landing speed and has a floor', () => {
    expect(fallDamage(10, DEFAULT_MOVEMENT)).toBe(0);
    expect(fallDamage(DEFAULT_MOVEMENT.fallDamageMinSpeed, DEFAULT_MOVEMENT)).toBe(0);
    const mid = fallDamage(30, DEFAULT_MOVEMENT);
    const high = fallDamage(42, DEFAULT_MOVEMENT);
    expect(mid).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(mid);
    expect(high).toBeLessThanOrEqual(DEFAULT_MOVEMENT.fallDamageMax);
  });

  it('eye position sits near the top of the capsule', () => {
    const s = createMovementState(vec3(1, 2, 3));
    const eye = eyePosition(s);
    expect(eye.x).toBe(1);
    expect(eye.z).toBe(3);
    expect(eye.y).toBeCloseTo(2 + PLAYER_HEIGHT_STAND - 0.16, 5);
  });

  it('character and weapon multipliers scale speeds but not the dash', () => {
    const p = effectiveMovement(DEFAULT_MOVEMENT, 1.1, 0.9);
    expect(p.walkSpeed).toBeCloseTo(DEFAULT_MOVEMENT.walkSpeed * 0.99, 5);
    // Dash scales with the character only, so heavy weapons keep their escape.
    expect(p.dashImpulse).toBeCloseTo(DEFAULT_MOVEMENT.dashImpulse * 1.1, 5);
  });
});
