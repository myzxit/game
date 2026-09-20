/**
 * Delta-snapshot round-trip tests.
 *
 * These exist because the client originally ingested the wire snapshot's player
 * list directly, without applying it to a base. Every delta entry carries only
 * the fields that changed, so a partial entry was read as full state and the
 * renderer threw on the missing `pos` sixty times a second — remote players
 * never appeared at all. Nothing caught it, because `buildDeltaSnapshot` and
 * `applyDeltaSnapshot` were only ever tested apart.
 *
 * So the rule these tests enforce is one property, end to end: applying the
 * delta to the base must reproduce the full snapshot exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  MovementState,
  ServerMessageType,
  TeamId,
  applyDeltaSnapshot,
  buildDeltaSnapshot,
  diffPlayer,
  type DeltaSnapshot,
  type LocalPlayerState,
  type PlayerSnapshot,
  type ServerSnapshot,
} from '../src/index.js';

function player(id: string, overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    id,
    pos: [100, 200, 300],
    vel: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    health: 100,
    shield: 50,
    team: TeamId.Alpha,
    state: MovementState.Idle,
    height: 180,
    weaponId: 'tr9_sentinel',
    ads: 0,
    alive: true,
    flags: 0,
    characterId: 'ch_vanguard',
    skinId: null,
    displayName: id,
    score: 0,
    kills: 0,
    deaths: 0,
    ping: 30,
    ...overrides,
  };
}

const LOCAL: LocalPlayerState = {} as LocalPlayerState;

function snapshot(id: number, players: PlayerSnapshot[]): ServerSnapshot {
  return {
    type: ServerMessageType.Snapshot,
    id,
    serverTimeMs: 1_000 + id * 50,
    tick: id * 3,
    baseId: -1,
    players,
    removed: [],
    local: LOCAL,
    projectiles: [],
    vehicles: [],
    worldEvents: [],
  };
}

/** Compare player lists by id, so list order is not part of the contract. */
function byId(players: PlayerSnapshot[]): Map<string, PlayerSnapshot> {
  return new Map(players.map((p) => [p.id, p]));
}

describe('delta snapshots', () => {
  it('sends the first snapshot in full when there is no base', () => {
    const full = snapshot(1, [player('a'), player('b')]);
    const delta = buildDeltaSnapshot(null, full);

    expect(delta.baseId).toBe(-1);
    expect(delta.players).toHaveLength(2);
    // A full snapshot must be usable with no base at all.
    expect(applyDeltaSnapshot(null, delta)).toEqual(full);
  });

  it('round-trips a moved player exactly', () => {
    const base = snapshot(1, [player('a'), player('b')]);
    const next = snapshot(2, [player('a', { pos: [150, 200, 300], yaw: 1570 }), player('b')]);

    const delta = buildDeltaSnapshot(base, next);
    const rebuilt = applyDeltaSnapshot(base, delta);

    expect(rebuilt).not.toBeNull();
    expect(byId(rebuilt!.players)).toEqual(byId(next.players));
  });

  it('omits players that did not change, and still reproduces them', () => {
    const base = snapshot(1, [player('a'), player('b'), player('c')]);
    const next = snapshot(2, [player('a', { health: 40 }), player('b'), player('c')]);

    const delta = buildDeltaSnapshot(base, next);
    // Only 'a' changed, so only 'a' should be on the wire.
    expect(delta.players.map((p) => p.id)).toEqual(['a']);

    const rebuilt = applyDeltaSnapshot(base, delta);
    expect(byId(rebuilt!.players)).toEqual(byId(next.players));
  });

  it('sends a newly joined player in full', () => {
    const base = snapshot(1, [player('a')]);
    const next = snapshot(2, [player('a'), player('b', { pos: [9, 8, 7] })]);

    const delta = buildDeltaSnapshot(base, next);
    const entry = delta.players.find((p) => p.id === 'b');
    // A player the client has never seen has no base to merge onto, so every
    // field must be present.
    expect(entry?.pos).toEqual([9, 8, 7]);
    expect(entry?.weaponId).toBeDefined();
    expect(entry?.displayName).toBeDefined();

    const rebuilt = applyDeltaSnapshot(base, delta);
    expect(byId(rebuilt!.players)).toEqual(byId(next.players));
  });

  it('drops players that left', () => {
    const base = snapshot(1, [player('a'), player('b')]);
    const next = snapshot(2, [player('a')]);

    const delta = buildDeltaSnapshot(base, next);
    expect(delta.removed).toEqual(['b']);

    const rebuilt = applyDeltaSnapshot(base, delta);
    expect(rebuilt!.players.map((p) => p.id)).toEqual(['a']);
  });

  it('refuses to apply a delta whose base it does not hold', () => {
    const base = snapshot(1, [player('a')]);
    const next = snapshot(5, [player('a', { health: 10 })]);
    const delta = buildDeltaSnapshot(base, next);

    // The client is holding snapshot 3, not the 1 this delta references.
    expect(applyDeltaSnapshot(snapshot(3, [player('a')]), delta)).toBeNull();
    expect(applyDeltaSnapshot(null, delta)).toBeNull();
  });

  it('never emits a partial entry the receiver cannot complete', () => {
    // The regression itself: whatever the wire carries, after reconstruction
    // every field the renderer reads must be defined.
    const base = snapshot(1, [player('a'), player('b')]);
    const next = snapshot(2, [player('a', { ads: 100, flags: 1 }), player('b', { alive: false })]);

    const delta = buildDeltaSnapshot(base, next);
    const rebuilt = applyDeltaSnapshot(base, delta)!;

    for (const p of rebuilt.players) {
      expect(p.pos).toHaveLength(3);
      expect(p.vel).toHaveLength(3);
      expect(p.yaw).toBeTypeOf('number');
      expect(p.pitch).toBeTypeOf('number');
      expect(p.height).toBeTypeOf('number');
      expect(p.weaponId).toBeTypeOf('string');
      expect(p.characterId).toBeTypeOf('string');
      expect(p.displayName).toBeTypeOf('string');
      expect(p.alive).toBeTypeOf('boolean');
    }
  });

  it('survives a long chain of deltas without drifting', () => {
    // Each snapshot is delta-compressed against the previous one and rebuilt
    // from the previous reconstruction — the way a real session runs. Any field
    // the differ forgets would show up here as accumulated drift.
    let base = snapshot(0, [player('a'), player('b')]);
    let client: ServerSnapshot = base;

    for (let i = 1; i <= 60; i++) {
      const next = snapshot(i, [
        player('a', { pos: [i * 10, 200, 300], yaw: i * 20, kills: i % 7, ads: i % 101 }),
        player('b', {
          pos: [500 - i, 200, 300],
          health: Math.max(1, 100 - i),
          alive: i % 13 !== 0,
          state: i % 2 === 0 ? MovementState.Sprinting : MovementState.Idle,
          skinId: i % 5 === 0 ? 'skin_weapon_aurum' : null,
        }),
      ]);

      const delta = buildDeltaSnapshot(base, next);
      const rebuilt = applyDeltaSnapshot(client, delta);

      expect(rebuilt, `snapshot ${i} failed to rebuild`).not.toBeNull();
      expect(byId(rebuilt!.players), `drift at snapshot ${i}`).toEqual(byId(next.players));

      base = next;
      client = rebuilt!;
    }
  });

  it('diffPlayer reports null only when nothing changed', () => {
    const a = player('a');
    expect(diffPlayer(a, player('a'))).toBeNull();
    expect(diffPlayer(a, player('a', { pos: [101, 200, 300] }))).not.toBeNull();
    // Array fields must be compared by value, not identity, or an unchanged
    // position would be re-sent on every single snapshot.
    expect(diffPlayer(a, { ...a, pos: [...a.pos] as [number, number, number] })).toBeNull();
  });

  it('covers every field of PlayerSnapshot', () => {
    // If a field is added to PlayerSnapshot but not to diffPlayer's checklist,
    // changes to it would silently never reach the client.
    const base = player('a');
    const keys = Object.keys(base) as (keyof PlayerSnapshot)[];

    for (const key of keys) {
      if (key === 'id') continue;
      const mutated: PlayerSnapshot = { ...base };
      const current = base[key];
      // Perturb the field in a type-appropriate way.
      (mutated as Record<string, unknown>)[key] =
        typeof current === 'number' ? current + 1
        : typeof current === 'boolean' ? !current
        : typeof current === 'string' ? `${current}_x`
        : Array.isArray(current) ? [999, 999, 999]
        : 'changed';

      const delta = diffPlayer(base, mutated);
      expect(delta, `diffPlayer ignores changes to "${key}"`).not.toBeNull();
      expect(delta, `diffPlayer does not transmit "${key}"`).toHaveProperty(key);

      const rebuilt = applyDeltaSnapshot(
        snapshot(1, [base]),
        buildDeltaSnapshot(snapshot(1, [base]), snapshot(2, [mutated])) as DeltaSnapshot,
      );
      expect(rebuilt!.players[0]![key], `"${key}" did not survive the round trip`).toEqual(
        mutated[key],
      );
    }
  });
});
