/**
 * Remote player interpolation.
 *
 * Snapshots arrive at 20 Hz but the game renders at 60-240. Rendering the
 * latest snapshot directly would look like a slideshow, so remote players are
 * rendered `INTERPOLATION_DELAY_MS` in the past and smoothly interpolated
 * between the two snapshots that bracket that moment.
 *
 * The delay is the price of smoothness, and it is exactly what the server's lag
 * compensation rewinds by — which is why a shot at what you see registers.
 */

import {
  INTERPOLATION_DELAY_MS,
  MovementState,
  RingBuffer,
  SnapshotFlag,
  TeamId,
  dequantizeAngle,
  dequantizePos,
  dequantizeVel,
  lerp,
  v3lerp,
  wrapAngle,
  type PlayerSnapshot,
  type Vec3,
} from '@titan/shared';

export interface InterpolatedPlayer {
  id: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  height: number;
  health: number;
  shield: number;
  team: TeamId;
  state: MovementState;
  weaponId: string;
  characterId: string;
  skinId: string | null;
  displayName: string;
  ads: number;
  alive: boolean;
  flags: number;
  score: number;
  kills: number;
  deaths: number;
  ping: number;
  /** Horizontal speed, derived for animation. */
  speed: number;
}

interface Sample {
  serverTimeMs: number;
  snapshot: PlayerSnapshot;
}

/** How long to keep a player after they stop appearing in snapshots. */
const STALE_MS = 3000;

class EntityTrack {
  readonly samples = new RingBuffer<Sample>(24);
  lastSeenAt = 0;

  push(serverTimeMs: number, snapshot: PlayerSnapshot): void {
    this.samples.push({ serverTimeMs, snapshot });
    this.lastSeenAt = serverTimeMs;
  }

  /**
   * Interpolate to `renderTime`.
   * Returns null if there is not enough history yet.
   */
  sample(renderTime: number): InterpolatedPlayer | null {
    const count = this.samples.length;
    if (count === 0) return null;

    const newest = this.samples.newest()!;
    if (count === 1) return decode(newest.snapshot, newest.snapshot, 0);

    const oldest = this.samples.at(0)!;

    // Render time is ahead of everything we have: extrapolate briefly using
    // the last known velocity rather than freezing the player in place. Past
    // ~150ms this looks worse than freezing, so it is capped.
    if (renderTime >= newest.serverTimeMs) {
      const ahead = Math.min(renderTime - newest.serverTimeMs, 150) / 1000;
      const result = decode(newest.snapshot, newest.snapshot, 0);
      if (ahead > 0.001) {
        result.position = {
          x: result.position.x + result.velocity.x * ahead,
          y: result.position.y + result.velocity.y * ahead,
          z: result.position.z + result.velocity.z * ahead,
        };
      }
      return result;
    }

    // Render time predates our history: show the oldest we have.
    if (renderTime <= oldest.serverTimeMs) {
      return decode(oldest.snapshot, oldest.snapshot, 0);
    }

    // Find the bracketing pair.
    for (let i = count - 1; i > 0; i--) {
      const after = this.samples.at(i)!;
      const before = this.samples.at(i - 1)!;
      if (renderTime >= before.serverTimeMs && renderTime <= after.serverTimeMs) {
        const span = after.serverTimeMs - before.serverTimeMs;
        const t = span > 0 ? (renderTime - before.serverTimeMs) / span : 0;
        return decode(before.snapshot, after.snapshot, t);
      }
    }

    return decode(newest.snapshot, newest.snapshot, 0);
  }
}

function decode(a: PlayerSnapshot, b: PlayerSnapshot, t: number): InterpolatedPlayer {
  const posA = dequantizePos(a.pos);
  const posB = dequantizePos(b.pos);
  const velB = dequantizeVel(b.vel);

  const position = t > 0 ? v3lerp(posA, posB, t) : posA;

  // Angles must go the short way round, or a player crossing the -PI/+PI
  // boundary spins all the way around.
  const yawA = dequantizeAngle(a.yaw);
  const yawB = dequantizeAngle(b.yaw);
  const yaw = yawA + wrapAngle(yawB - yawA) * t;

  const pitchA = dequantizeAngle(a.pitch);
  const pitchB = dequantizeAngle(b.pitch);
  const pitch = lerp(pitchA, pitchB, t);

  // Discrete fields snap to the newer sample rather than blending: a
  // half-interpolated "alive" or weapon id is meaningless.
  const source = t < 0.5 ? a : b;

  return {
    id: b.id,
    position,
    velocity: velB,
    yaw,
    pitch,
    height: lerp(a.height, b.height, t) / 100,
    health: source.health,
    shield: source.shield,
    team: source.team,
    state: source.state,
    weaponId: source.weaponId,
    characterId: source.characterId,
    skinId: source.skinId,
    displayName: source.displayName,
    ads: lerp(a.ads, b.ads, t) / 100,
    alive: source.alive,
    flags: source.flags,
    score: source.score,
    kills: source.kills,
    deaths: source.deaths,
    ping: source.ping,
    speed: Math.hypot(velB.x, velB.z),
  };
}

export class EntityInterpolator {
  private readonly tracks = new Map<string, EntityTrack>();
  /** The most recent server time we've seen, for the render clock. */
  private latestServerTime = 0;

  /** Feed a snapshot's player list. */
  ingest(players: PlayerSnapshot[], serverTimeMs: number, excludeId: string | null): void {
    this.latestServerTime = Math.max(this.latestServerTime, serverTimeMs);

    for (const snapshot of players) {
      if (snapshot.id === excludeId) continue;
      let track = this.tracks.get(snapshot.id);
      if (!track) {
        track = new EntityTrack();
        this.tracks.set(snapshot.id, track);
      }
      track.push(serverTimeMs, snapshot);
    }
  }

  remove(playerId: string): void {
    this.tracks.delete(playerId);
  }

  /**
   * Every remote player, interpolated to the render time.
   * `estimatedServerNow` is the client's estimate of the current server clock.
   */
  sampleAll(estimatedServerNow: number): InterpolatedPlayer[] {
    const renderTime = estimatedServerNow - INTERPOLATION_DELAY_MS;
    const out: InterpolatedPlayer[] = [];

    for (const [id, track] of Array.from(this.tracks.entries())) {
      // Drop players who have stopped appearing — they left the match.
      if (estimatedServerNow - track.lastSeenAt > STALE_MS) {
        this.tracks.delete(id);
        continue;
      }
      const sampled = track.sample(renderTime);
      if (sampled) out.push(sampled);
    }

    return out;
  }

  /** Convenience accessors for the HUD and scoreboard. */
  get trackedIds(): string[] {
    return Array.from(this.tracks.keys());
  }

  clear(): void {
    this.tracks.clear();
    this.latestServerTime = 0;
  }

  /** Flag helpers, so callers don't repeat bit arithmetic. */
  static isFiring(player: InterpolatedPlayer): boolean {
    return (player.flags & SnapshotFlag.Firing) !== 0;
  }
  static isReloading(player: InterpolatedPlayer): boolean {
    return (player.flags & SnapshotFlag.Reloading) !== 0;
  }
  static isAiming(player: InterpolatedPlayer): boolean {
    return (player.flags & SnapshotFlag.Aiming) !== 0;
  }
  static isPhased(player: InterpolatedPlayer): boolean {
    return (player.flags & SnapshotFlag.Phased) !== 0;
  }
  static isScanned(player: InterpolatedPlayer): boolean {
    return (player.flags & SnapshotFlag.Scanned) !== 0;
  }
  static isSpawnProtected(player: InterpolatedPlayer): boolean {
    return (player.flags & SnapshotFlag.SpawnProtected) !== 0;
  }
}
