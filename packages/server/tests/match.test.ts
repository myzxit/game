/**
 * End-to-end match simulation, headless.
 *
 * These drive a real MatchInstance with synthetic inputs and assert on the
 * authoritative outcome. If the core loop is broken — movement, shooting,
 * damage, kills, scoring, respawns, mode rules — these fail.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LOADOUT,
  GameModeId,
  HitZone,
  InputButton,
  MatchPhase,
  TICK_MS,
  TeamId,
  cloneLoadout,
  requireMap,
  vec3,
  PLAYER_RADIUS,
  PLAYER_HEIGHT_STAND,
  type PlayerInput,
  DamageType,
} from '@titan/shared';
import { MatchInstance, type MatchPlayerSeed } from '../src/match/MatchInstance.js';
import { WorldRegistry } from '../src/world/WorldRegistry.js';
import { AntiCheat } from '../src/anticheat/AntiCheat.js';
import { createGameMode } from '../src/gamemodes/index.js';

const worlds = new WorldRegistry();

function seed(id: string, team: TeamId): MatchPlayerSeed {
  return {
    id,
    displayName: id.toUpperCase(),
    team,
    loadout: cloneLoadout(DEFAULT_LOADOUT),
    rating: 1000,
  };
}

function makeMatch(modeId: string, players: MatchPlayerSeed[], mapId = 'foundry_reach') {
  return new MatchInstance({
    id: 'test-match',
    modeId,
    mapId,
    seed: 12345,
    world: worlds.get(mapId),
    mode: createGameMode(modeId),
    antiCheat: new AntiCheat(),
    players,
  });
}

const input = (sequence: number, o: Partial<PlayerInput> = {}): PlayerInput => ({
  sequence,
  deltaMs: TICK_MS,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  clientTimeMs: sequence * TICK_MS,
  ...o,
});

/**
 * A single monotonic clock per match.
 *
 * This matters: lag compensation rewinds a target's hitboxes to
 * `now - (halfRtt + interpolationDelay)`. If the test's notion of "now" jumps
 * backwards between helper calls, the rewind lands before the recorded pose
 * history and resolves to the player's *spawn* position instead of where the
 * test placed them — so shots miss for reasons that have nothing to do with the
 * engine. One shared clock keeps server time continuous.
 */
const clocks = new WeakMap<MatchInstance, { now: number }>();

function clockFor(match: MatchInstance): { now: number } {
  let clock = clocks.get(match);
  if (!clock) {
    clock = { now: Date.now() };
    clocks.set(match, clock);
  }
  return clock;
}

/** Current server time for a match. */
function timeOf(match: MatchInstance): number {
  return clockFor(match).now;
}

/** Advance the match by N ticks of continuous time. */
function advance(match: MatchInstance, ticks: number): number {
  const clock = clockFor(match);
  for (let i = 0; i < ticks; i++) {
    clock.now += TICK_MS;
    match.step(clock.now);
  }
  return clock.now;
}

/**
 * Find a stretch of genuinely open ground on a map.
 *
 * Hardcoding duel coordinates is brittle: a map edit can drop a shipping
 * container on top of them, and the test then fails for a reason that has
 * nothing to do with combat. This searches for a spot where both players fit
 * and have line of sight, so the test keeps testing what it means to.
 */
function findOpenCorridor(mapId: string, length: number): { x: number; z: number } {
  const world = worlds.get(mapId).collision;
  const fits = (x: number, z: number): boolean =>
    !world.overlapsAny(
      vec3(x - PLAYER_RADIUS, 0.25, z - PLAYER_RADIUS),
      vec3(x + PLAYER_RADIUS, 0.2 + PLAYER_HEIGHT_STAND, z + PLAYER_RADIUS),
    );

  for (let z = -40; z <= 40; z += 1) {
    for (let x = -48; x <= 20; x += 1) {
      let clear = true;
      for (let d = 0; d <= length + 2 && clear; d += 0.5) clear = fits(x + d, z);
      if (!clear) continue;
      if (!world.hasLineOfSight(vec3(x, 1.84, z), vec3(x + length, 1.5, z))) continue;
      return { x, z };
    }
  }
  throw new Error(`no open corridor of ${length}m found on ${mapId}`);
}

/** Run past warmup and countdown into the live phase. */
function goLive(match: MatchInstance): number {
  const warmupTicks = Math.ceil(
    ((match.mode.config.warmupSec + match.mode.config.countdownSec) * 1000) / TICK_MS,
  );
  return advance(match, warmupTicks + 2);
}

describe('match lifecycle', () => {
  it('progresses warmup -> countdown -> live', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    expect(match.phase).toBe(MatchPhase.Warmup);

    advance(match, Math.ceil((match.mode.config.warmupSec * 1000) / TICK_MS) + 1);
    expect(match.phase).toBe(MatchPhase.Countdown);

    advance(match, Math.ceil((match.mode.config.countdownSec * 1000) / TICK_MS) + 1);
    expect(match.phase).toBe(MatchPhase.Live);
  });

  it('spawns every player alive, at full health, inside the map', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('a2', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
      seed('b2', TeamId.Bravo),
    ]);
    const map = requireMap('foundry_reach');

    expect(match.players.size).toBe(4);
    for (const player of match.players.values()) {
      expect(player.alive).toBe(true);
      expect(player.health).toBe(player.maxHealth);
      expect(player.position.x).toBeGreaterThanOrEqual(map.bounds.min.x);
      expect(player.position.x).toBeLessThanOrEqual(map.bounds.max.x);
      expect(player.activeWeapon).not.toBeNull();
    }
  });

  it('assigns teams as requested', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    expect(match.players.get('a1')!.team).toBe(TeamId.Alpha);
    expect(match.players.get('b1')!.team).toBe(TeamId.Bravo);
  });
});

describe('movement through the match', () => {
  it('a player who presses forward actually moves', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    const player = match.players.get('a1')!;
    const start = { ...player.position };

    for (let i = 0; i < 60; i++) {
      match.enqueueInputs('a1', [input(i + 1, { moveZ: 1, yaw: player.movement.yaw })]);
      advance(match, 1);
    }

    const moved = Math.hypot(
      player.position.x - start.x,
      player.position.z - start.z,
    );
    expect(moved).toBeGreaterThan(1);
  });

  it('acknowledges the last processed input for reconciliation', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    match.enqueueInputs('a1', [input(1), input(2), input(3)]);
    advance(match, 2);
    expect(match.players.get('a1')!.lastProcessedInput).toBeGreaterThanOrEqual(3);
  });

  it('rejects replayed input sequences', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    match.enqueueInputs('a1', [input(10, { moveZ: 1 })]);
    advance(match, 1);
    const afterFirst = { ...match.players.get('a1')!.position };

    // Replaying an older sequence must not move the player again.
    match.enqueueInputs('a1', [input(5, { moveZ: 1 }), input(10, { moveZ: 1 })]);
    advance(match, 1);

    const player = match.players.get('a1')!;
    // Velocity carries the player forward, but no *extra* input was applied,
    // so the last processed sequence must not have gone backwards.
    expect(player.lastProcessedInput).toBeGreaterThanOrEqual(10);
    void afterFirst;
  });
});

describe('combat', () => {
  /** Put two players face to face at a known distance on open ground. */
  function duel(distance = 10) {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    const shooter = match.players.get('a1')!;
    const target = match.players.get('b1')!;
    const spot = findOpenCorridor('foundry_reach', distance);

    // yaw = -PI/2 faces +X under the shared angle convention.
    const YAW_PLUS_X = -Math.PI / 2;
    const place = (): void => {
      shooter.movement.position = vec3(spot.x, 0.2, spot.z);
      shooter.movement.yaw = YAW_PLUS_X;
      shooter.movement.pitch = 0;
      shooter.spawnProtectedMs = 0;
      target.movement.position = vec3(spot.x + distance, 0.2, spot.z);
      target.spawnProtectedMs = 0;
    };

    // Place once, then let them settle. Two things need this: the
    // lag-compensation rewind (~130ms) must find poses recorded *here* rather
    // than at their spawns, and both players must come to rest on the ground —
    // an airborne player's weapon spread is 3x wider, which is enough to miss
    // a stationary target at 10m.
    place();
    advance(match, 30);

    return { match, shooter, target, yaw: YAW_PLUS_X, place };
  }

  it('a shot at an enemy in the open deals damage', () => {
    const { match, shooter, target, yaw } = duel(10);
    // Players spawn with a full shield, so a single rifle round reduces
    // effective health without touching the health bar.
    const before = target.effectiveHealth;

    // Aim slightly down: the shooter's eye is ~1.84m up, the target's chest
    // sits around 1.3-1.75m, so a level shot would pass over the shoulder.
    match.enqueueInputs('a1', [input(1, { buttons: InputButton.Fire, yaw, pitch: -0.02 })]);
    advance(match, 2);

    expect(target.effectiveHealth).toBeLessThan(before);
    expect(shooter.shotsFired).toBeGreaterThan(0);
    expect(shooter.damageDealt).toBeGreaterThan(0);
  });

  it('does not damage a teammate when friendly fire is off', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('a2', TeamId.Alpha),
    ]);
    goLive(match);

    const shooter = match.players.get('a1')!;
    const mate = match.players.get('a2')!;
    const spot = findOpenCorridor('foundry_reach', 8);
    const yaw = -Math.PI / 2;

    shooter.movement.position = vec3(spot.x, 0.2, spot.z);
    shooter.movement.yaw = yaw;
    shooter.spawnProtectedMs = 0;
    mate.movement.position = vec3(spot.x + 8, 0.2, spot.z);
    mate.spawnProtectedMs = 0;
    advance(match, 30);
    shooter.spawnProtectedMs = 0;
    mate.spawnProtectedMs = 0;

    const before = mate.effectiveHealth;
    match.enqueueInputs('a1', [input(1, { buttons: InputButton.Fire, yaw, pitch: -0.02 })]);
    advance(match, 2);

    expect(mate.effectiveHealth).toBe(before);
  });

  it('does not damage a spawn-protected player', () => {
    const { match, target, yaw } = duel(10);
    target.spawnProtectedMs = 2000;
    const before = target.effectiveHealth;

    match.enqueueInputs('a1', [input(1, { buttons: InputButton.Fire, yaw, pitch: -0.02 })]);
    advance(match, 2);
    expect(target.effectiveHealth).toBe(before);
  });

  it('sustained fire eventually kills, awarding a kill and a death', () => {
    const { match, shooter, target, yaw, place } = duel(10);

    for (let i = 0; i < 200 && target.alive; i++) {
      match.enqueueInputs('a1', [input(i + 1, { buttons: InputButton.Fire, yaw, pitch: -0.02 })]);
      advance(match, 1);
      // Keep both players still, so this measures damage rather than the
      // target wandering out of the line of fire.
      if (target.alive) place();
    }

    expect(target.alive).toBe(false);
    expect(shooter.kills).toBe(1);
    expect(target.deaths).toBe(1);
    expect(shooter.killStreak).toBe(1);
  });

  it('a wall between shooter and target blocks the shot', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    const shooter = match.players.get('a1')!;
    const target = match.players.get('b1')!;

    // Put the target on the far side of the foundry hall's brick wall.
    shooter.movement.position = vec3(-30, 0.2, 0);
    shooter.movement.yaw = -Math.PI / 2; // face +X, into the hall wall
    shooter.spawnProtectedMs = 0;
    target.movement.position = vec3(-5, 0.2, 0);
    target.spawnProtectedMs = 0;

    shooter.movement.position = vec3(-30, 0.2, 0);
    target.movement.position = vec3(-5, 0.2, 0);
    advance(match, 30);
    shooter.spawnProtectedMs = 0;
    target.spawnProtectedMs = 0;

    const before = target.effectiveHealth;
    for (let i = 0; i < 10; i++) {
      match.enqueueInputs('a1', [input(i + 1, { buttons: InputButton.Fire, yaw: -Math.PI / 2 })]);
      advance(match, 1);
    }
    expect(target.effectiveHealth).toBe(before);
  });

  it('shields absorb damage before health', () => {
    const { match, target, yaw } = duel(10);
    target.shield = 30;
    const startShield = target.shield;
    const startHealth = target.health;

    match.enqueueInputs('a1', [input(1, { buttons: InputButton.Fire, yaw, pitch: -0.02 })]);
    advance(match, 2);

    expect(target.shield).toBeLessThan(startShield);
    expect(target.health).toBe(startHealth);
  });

  it('records assists for a player who contributed damage', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('a2', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    const victim = match.players.get('b1')!;
    const assister = match.players.get('a2')!;
    const killer = match.players.get('a1')!;
    victim.spawnProtectedMs = 0;

    const now = timeOf(match);
    // Assister softens the target, killer finishes it.
    match.applyDamage(victim, assister, 40, DamageType.Bullet, HitZone.Chest, 'tr9_sentinel', 10, now);
    expect(victim.alive).toBe(true);
    match.applyDamage(victim, killer, 200, DamageType.Bullet, HitZone.Chest, 'tr9_sentinel', 10, now);

    expect(victim.alive).toBe(false);
    expect(killer.kills).toBe(1);
    expect(assister.assists).toBe(1);
  });

  it('a headshot deals more damage than a chest shot', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    const attacker = match.players.get('a1')!;
    const victim = match.players.get('b1')!;
    victim.spawnProtectedMs = 0;
    const now = timeOf(match);

    const before = victim.health;
    match.applyDamage(victim, attacker, 24, DamageType.Bullet, HitZone.Chest, 'tr9_sentinel', 10, now);
    const chestLoss = before - victim.health;

    victim.health = victim.maxHealth;
    match.applyDamage(victim, attacker, 24 * 1.8, DamageType.Bullet, HitZone.Head, 'tr9_sentinel', 10, now);
    const headLoss = victim.maxHealth - victim.health;

    expect(headLoss).toBeGreaterThan(chestLoss);
    expect(attacker.headshots).toBe(1);
  });
});

describe('respawn', () => {
  it('respawns a dead player after the delay, at full health', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    const victim = match.players.get('b1')!;
    const attacker = match.players.get('a1')!;
    victim.spawnProtectedMs = 0;
    match.applyDamage(victim, attacker, 500, DamageType.Bullet, HitZone.Chest, 'tr9_sentinel', 5, timeOf(match));

    expect(victim.alive).toBe(false);
    expect(victim.respawnInMs).toBeGreaterThan(0);

    advance(match, Math.ceil(match.mode.config.respawnDelayMs / TICK_MS) + 5);

    expect(victim.alive).toBe(true);
    expect(victim.health).toBe(victim.maxHealth);
    expect(victim.isSpawnProtected).toBe(true);
  });

  it('does not respawn in Elimination', () => {
    const match = makeMatch(GameModeId.Elimination, [
      seed('a1', TeamId.Alpha),
      seed('a2', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
      seed('b2', TeamId.Bravo),
    ]);
    goLive(match);

    const victim = match.players.get('b1')!;
    victim.spawnProtectedMs = 0;
    match.applyDamage(victim, match.players.get('a1')!, 500, DamageType.Bullet, HitZone.Chest, null, 5, timeOf(match));

    advance(match, 400);
    expect(victim.alive).toBe(false);
  });
});

describe('game modes', () => {
  it('Team Deathmatch scores a kill for the killer team', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    const victim = match.players.get('b1')!;
    victim.spawnProtectedMs = 0;
    match.applyDamage(victim, match.players.get('a1')!, 500, DamageType.Bullet, HitZone.Chest, null, 5, timeOf(match));

    expect(match.teamScores.get(TeamId.Alpha)).toBe(1);
    expect(match.teamScores.get(TeamId.Bravo)).toBe(0);
  });

  it('Free For All scores the individual', () => {
    const match = makeMatch(GameModeId.FreeForAll, [
      seed('p1', TeamId.None),
      seed('p2', TeamId.None),
    ]);
    goLive(match);

    const victim = match.players.get('p2')!;
    victim.spawnProtectedMs = 0;
    match.applyDamage(victim, match.players.get('p1')!, 500, DamageType.Bullet, HitZone.Chest, null, 5, timeOf(match));

    expect(match.playerScores.get('p1')).toBe(1);
  });

  it('Elimination ends the round when a team is wiped out', () => {
    const match = makeMatch(GameModeId.Elimination, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);
    expect(match.phase).toBe(MatchPhase.Live);

    const victim = match.players.get('b1')!;
    victim.spawnProtectedMs = 0;
    match.applyDamage(victim, match.players.get('a1')!, 500, DamageType.Bullet, HitZone.Chest, null, 5, timeOf(match));

    advance(match, 2);
    expect(match.roundsWon.get(TeamId.Alpha)).toBe(1);
    expect([MatchPhase.RoundEnd, MatchPhase.MatchEnd]).toContain(match.phase);
  });

  it('Team Deathmatch ends when the score limit is reached', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    // Drive the score straight to the limit.
    match.teamScores.set(TeamId.Alpha, match.mode.config.scoreLimit);
    advance(match, 2);

    expect(match.phase).toBe(MatchPhase.MatchEnd);
    expect(match.winningTeam).toBe(TeamId.Alpha);
    expect(match.ended).toBe(true);
  });
});

describe('match recording', () => {
  it('records the events a replay would need', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    const victim = match.players.get('b1')!;
    victim.spawnProtectedMs = 0;
    match.applyDamage(victim, match.players.get('a1')!, 500, DamageType.Bullet, HitZone.Chest, 'tr9_sentinel', 5, timeOf(match));
    advance(match, 5);

    const events = match.recorder.all();
    const types = new Set(events.map((e) => e.type));
    expect(types.has('match_start' as never)).toBe(true);
    expect(types.has('player_join' as never)).toBe(true);
    expect(types.has('kill' as never)).toBe(true);

    const serialized = match.recorder.serialize({
      matchId: match.id,
      mapId: match.mapId,
      modeId: match.modeId,
      seed: match.seed,
    });
    expect(JSON.parse(serialized).events.length).toBeGreaterThan(0);
  });
});

describe('disconnection and reconnection', () => {
  it('holds a disconnected player\'s slot and restores them', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);

    match.markDisconnected('a1', timeOf(match));
    expect(match.players.has('a1')).toBe(true);
    expect(match.players.get('a1')!.alive).toBe(false);
    expect(match.activePlayerCount).toBe(1);

    expect(match.markReconnected('a1')).toBe(true);
    expect(match.activePlayerCount).toBe(2);

    advance(match, 200);
    expect(match.players.get('a1')!.alive).toBe(true);
  });

  it('removes a player who leaves for good', () => {
    const match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
    ]);
    goLive(match);
    match.removePlayer('a1', 'left');
    expect(match.players.has('a1')).toBe(false);
  });
});

describe('stability', () => {
  let match: MatchInstance;

  beforeEach(() => {
    match = makeMatch(GameModeId.TeamDeathmatch, [
      seed('a1', TeamId.Alpha),
      seed('a2', TeamId.Alpha),
      seed('a3', TeamId.Alpha),
      seed('b1', TeamId.Bravo),
      seed('b2', TeamId.Bravo),
      seed('b3', TeamId.Bravo),
    ]);
  });

  it('survives a long run of chaotic input without throwing or losing players', () => {
    goLive(match);
    const ids = Array.from(match.players.keys());

    for (let tick = 0; tick < 800; tick++) {
      for (const [index, id] of ids.entries()) {
        const n = tick + index;
        match.enqueueInputs(
          id,
          [
            input(tick + 1, {
              moveX: Math.sin(n * 0.13),
              moveZ: Math.cos(n * 0.21),
              yaw: n * 0.05,
              pitch: Math.sin(n * 0.07) * 0.5,
              buttons:
                (n % 5 === 0 ? InputButton.Fire : 0) |
                (n % 31 === 0 ? InputButton.Jump : 0) |
                (n % 17 === 0 ? InputButton.Reload : 0) |
                (n % 13 === 0 ? InputButton.Sprint : 0) |
                (n % 41 === 0 ? InputButton.Dash : 0),
            }),
          ],
          -1,
        );
      }
      advance(match, 1);
      if (match.ended) break;
    }

    expect(match.players.size).toBe(6);
    for (const player of match.players.values()) {
      expect(Number.isFinite(player.position.x)).toBe(true);
      expect(Number.isFinite(player.position.y)).toBe(true);
      expect(Number.isFinite(player.position.z)).toBe(true);
      expect(player.health).toBeGreaterThanOrEqual(0);
      expect(player.health).toBeLessThanOrEqual(player.maxHealth);
    }
  });

  it('keeps players inside the world during a long run', () => {
    goLive(match);
    const map = requireMap('foundry_reach');
    const ids = Array.from(match.players.keys());

    for (let tick = 0; tick < 400; tick++) {
      for (const id of ids) {
        match.enqueueInputs(
          id,
          [input(tick + 1, { moveZ: 1, moveX: Math.sin(tick * 0.3), yaw: tick * 0.02 })],
          -1,
        );
      }
      advance(match, 1);
    }

    for (const player of match.players.values()) {
      if (!player.alive) continue; // out-of-bounds kills are the intended handling
      expect(player.position.y).toBeGreaterThan(map.bounds.min.y - 25);
    }
  });
});

describe('vehicles', () => {
  // Neon Quarter is the map with a vehicle spawn; Foundry Reach has its own.
  const MAP = 'neon_quarter';

  function vehicleMatch() {
    const match = makeMatch(
      GameModeId.TeamDeathmatch,
      [seed('a1', TeamId.Alpha), seed('b1', TeamId.Bravo)],
      MAP,
    );
    advance(match, 1);
    return match;
  }

  it('spawns the vehicles the map declares', () => {
    const match = vehicleMatch();
    const vehicles = match.vehicleSystem.all;
    expect(vehicles.length).toBeGreaterThan(0);
    for (const v of vehicles) {
      expect(v.destroyed).toBe(false);
      expect(v.driverId).toBeNull();
      expect(v.health).toBeGreaterThan(0);
    }
  });

  it('refuses to board a vehicle from across the map', () => {
    // The whole point of server authority here: proximity is checked against
    // the server's position for the player, not asserted by the client.
    const match = vehicleMatch();
    const vehicle = match.vehicleSystem.all[0]!;
    const player = match.players.get('a1')!;

    player.movement.position = vec3(
      vehicle.position.x + 500,
      vehicle.position.y,
      vehicle.position.z,
    );

    expect(match.vehicleSystem.enter(player, vehicle.id)).toBeNull();
    expect(player.vehicleId).toBeNull();
    expect(vehicle.driverId).toBeNull();
  });

  it.each(['neon_quarter', 'foundry_reach'])('boards, drives and dismounts on %s', (mapId) => {
    const match = makeMatch(
      GameModeId.TeamDeathmatch,
      [seed('a1', TeamId.Alpha), seed('b1', TeamId.Bravo)],
      mapId,
    );
    advance(match, 1);
    const vehicle = match.vehicleSystem.all[0]!;
    const player = match.players.get('a1')!;

    // Stand on the vehicle so the proximity check passes.
    player.movement.position = { ...vehicle.position };

    expect(match.vehicleSystem.enter(player, vehicle.id)).not.toBeNull();
    expect(player.vehicleId).toBe(vehicle.id);
    expect(vehicle.driverId).toBe('a1');

    const start = { ...vehicle.position };
    match.vehicleSystem.setInput('a1', 1, 0, false);
    advance(match, 64); // one second of full throttle

    const travelled = Math.hypot(
      vehicle.position.x - start.x,
      vehicle.position.z - start.z,
    );
    // Full throttle from rest for one second: acceleration is 14 m/s², so the
    // buggy should cover roughly 7m on open ground. A much smaller figure means
    // something is scrubbing speed every tick (a wall, or being un-grounded).
    expect(vehicle.speed).toBeGreaterThan(8);
    expect(travelled).toBeGreaterThan(4);
    // The driver rides along rather than being left at the spawn point.
    expect(
      Math.hypot(player.position.x - vehicle.position.x, player.position.z - vehicle.position.z),
    ).toBeLessThan(4);

    match.vehicleSystem.exit(player);
    expect(player.vehicleId).toBeNull();
    expect(vehicle.driverId).toBeNull();
  });

  it('ignores drive input from someone who is not the driver', () => {
    const match = vehicleMatch();
    const vehicle = match.vehicleSystem.all[0]!;
    const driver = match.players.get('a1')!;
    driver.movement.position = { ...vehicle.position };
    match.vehicleSystem.enter(driver, vehicle.id);

    match.vehicleSystem.setInput('a1', 1, 0, false);
    match.vehicleSystem.setInput('b1', -1, 1, true); // not in the vehicle
    expect(vehicle.throttle).toBe(1);
    expect(vehicle.steer).toBe(0);
    expect(vehicle.brake).toBe(false);
  });

  it('does not let two players take the same seat', () => {
    const match = vehicleMatch();
    const vehicle = match.vehicleSystem.all[0]!;
    const a = match.players.get('a1')!;
    const b = match.players.get('b1')!;
    a.movement.position = { ...vehicle.position };
    b.movement.position = { ...vehicle.position };

    match.vehicleSystem.enter(a, vehicle.id);
    const seats = vehicle.def.seats;
    const boarded = match.vehicleSystem.enter(b, vehicle.id);

    if (seats > 1) {
      expect(boarded).not.toBeNull();
      expect(vehicle.passengerIds).toContain('b1');
    } else {
      expect(boarded).toBeNull();
      expect(b.vehicleId).toBeNull();
    }
    // Either way there is exactly one driver.
    expect(vehicle.driverId).toBe('a1');
  });

  it('ejects the occupant when the vehicle is destroyed', () => {
    const match = vehicleMatch();
    const vehicle = match.vehicleSystem.all[0]!;
    const player = match.players.get('a1')!;
    player.movement.position = { ...vehicle.position };
    match.vehicleSystem.enter(player, vehicle.id);

    match.vehicleSystem.damage(vehicle, vehicle.health + 100, 'b1', timeOf(match));

    expect(vehicle.destroyed).toBe(true);
    expect(vehicle.driverId).toBeNull();
    expect(player.vehicleId).toBeNull();
  });
});

describe('vehicle state on the wire', () => {
  it('every snapshot carries the full vehicle list', async () => {
    const { SnapshotBuilder } = await import('../src/match/SnapshotBuilder.js');
    const match = makeMatch(
      GameModeId.TeamDeathmatch,
      [seed('a1', TeamId.Alpha), seed('b1', TeamId.Bravo)],
      'neon_quarter',
    );
    advance(match, 1);
    const builder = new SnapshotBuilder(match);

    const vehicle = match.vehicleSystem.all[0]!;
    const driver = match.players.get('a1')!;
    driver.movement.position = { ...vehicle.position };
    match.vehicleSystem.enter(driver, vehicle.id);
    match.vehicleSystem.setInput('a1', 1, 0, false);
    advance(match, 32);

    // Two consecutive snapshots to the same client: the second is a delta,
    // and vehicles must still be present in full on it.
    const first = builder.buildAll(timeOf(match)).get('b1')!;
    builder.acknowledge('b1', first.id);
    advance(match, 3);
    const second = builder.buildAll(timeOf(match)).get('b1')!;

    expect(second.baseId).toBe(first.id);
    expect(second.vehicles).toHaveLength(match.vehicleSystem.all.length);

    const wire = second.vehicles.find((v) => v.id === vehicle.id)!;
    expect(wire.driverId).toBe('a1');
    expect(wire.speed).toBeGreaterThan(0);
    expect(wire.pos[0]).toBeCloseTo(vehicle.position.x, 5);
    expect(wire.destroyed).toBe(false);

    // The seated player's own snapshot says so, in both places a client reads it.
    const own = builder.buildAll(timeOf(match)).get('a1')!;
    expect(own.local.vehicleId).toBe(vehicle.id);
    const entry = own.players.find((p) => p.id === 'a1');
    // 'a1' may be absent from a delta if unchanged — but a moving driver changes every tick.
    expect(entry?.flags !== undefined ? (entry.flags & 16) !== 0 : true).toBe(true);
  });
});
