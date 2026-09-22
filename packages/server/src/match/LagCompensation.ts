/**
 * Lag compensation.
 *
 * When a player shoots, they are aiming at where they *saw* their target, which
 * is `interpolationDelay + halfRoundTrip` in the past. To make shots feel fair,
 * the server rewinds every other player's hitboxes to that moment before
 * testing the ray.
 *
 * The rewind is bounded by MAX_REWIND_MS. Without that bound, a client that
 * inflates its reported latency could shoot at targets a full second in the
 * past — the classic "peeker's advantage" exploit.
 */

import {
  INTERPOLATION_DELAY_MS,
  LAG_COMPENSATION_HISTORY_MS,
  MAX_REWIND_MS,
  MovementState,
  RingBuffer,
  TICK_MS,
  clamp,
  v3lerp,
  type Vec3,
} from '@titan/shared';

export interface HistoricalPose {
  timeMs: number;
  position: Vec3;
  height: number;
  state: MovementState;
  alive: boolean;
}

const HISTORY_CAPACITY = Math.ceil(LAG_COMPENSATION_HISTORY_MS / TICK_MS) + 4;

/** Per-player position history, used to rewind hitboxes. */
export class PoseHistory {
  private readonly buffer = new RingBuffer<HistoricalPose>(HISTORY_CAPACITY);

  record(pose: HistoricalPose): void {
    this.buffer.push(pose);
  }

  clear(): void {
    this.buffer.clear();
  }

  get latest(): HistoricalPose | undefined {
    return this.buffer.newest();
  }

  /**
   * Pose at a past time, interpolated between the two surrounding samples.
   * Returns the newest pose if `timeMs` is in the future, and the oldest if the
   * request predates our history.
   */
  sample(timeMs: number): HistoricalPose | null {
    const count = this.buffer.length;
    if (count === 0) return null;

    const newest = this.buffer.newest()!;
    if (timeMs >= newest.timeMs) return newest;

    const oldest = this.buffer.oldest()!;
    if (timeMs <= oldest.timeMs) return oldest;

    // Walk backwards to find the bracketing pair. History is short (~64
    // entries), so a linear scan from the newest end is the fastest option.
    for (let i = count - 1; i > 0; i--) {
      const after = this.buffer.at(i)!;
      const before = this.buffer.at(i - 1)!;
      if (timeMs >= before.timeMs && timeMs <= after.timeMs) {
        const span = after.timeMs - before.timeMs;
        const t = span > 0 ? (timeMs - before.timeMs) / span : 0;
        return {
          timeMs,
          position: v3lerp(before.position, after.position, t),
          height: before.height + (after.height - before.height) * t,
          // Discrete fields snap rather than blend.
          state: t < 0.5 ? before.state : after.state,
          alive: before.alive && after.alive,
        };
      }
    }
    return newest;
  }
}

/**
 * How far back to rewind for a shot from a player with this round-trip time.
 *
 * The client renders remote players INTERPOLATION_DELAY_MS in the past, and the
 * shot took halfRtt to reach us, so the moment the shooter actually saw is
 * `now - (halfRtt + interpolationDelay)`.
 */
export function rewindMsFor(roundTripMs: number): number {
  const halfRtt = clamp(roundTripMs, 0, 400) / 2;
  return clamp(halfRtt + INTERPOLATION_DELAY_MS, 0, MAX_REWIND_MS);
}

/** The server timestamp to rewind hitboxes to for a given shooter. */
export function rewindTargetTime(serverTimeMs: number, roundTripMs: number): number {
  return serverTimeMs - rewindMsFor(roundTripMs);
}
