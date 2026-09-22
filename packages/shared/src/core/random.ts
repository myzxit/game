/**
 * Deterministic pseudo-random number generation.
 *
 * Every gameplay-relevant random draw (spread, recoil pattern, loot boxes,
 * daily quest rolls, map spawn selection) goes through a seeded generator so
 * that:
 *   - the server can reproduce and audit any outcome,
 *   - the client can predict cosmetic spread without desyncing,
 *   - tests are repeatable.
 *
 * Never use Math.random() for gameplay.
 */

/** mulberry32 — small, fast, good enough distribution for gameplay. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Ensure a non-zero uint32 state.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Raw uint32. */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  /** Uniform point inside a unit circle — used for weapon spread cones. */
  insideUnitCircle(): { x: number; y: number } {
    const angle = this.next() * Math.PI * 2;
    const radius = Math.sqrt(this.next());
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(0, items.length - 1)]!;
  }

  /** Fisher-Yates, returns a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  /** Pick `count` distinct items (or fewer if the pool is smaller). */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.min(count, items.length));
  }

  /**
   * Weighted pick. Weights must be non-negative; entries with weight 0 are
   * never selected. Returns null only if every weight is 0.
   */
  weighted<T>(entries: readonly { value: T; weight: number }[]): T | null {
    let total = 0;
    for (const e of entries) total += Math.max(0, e.weight);
    if (total <= 0) return null;
    let roll = this.next() * total;
    for (const e of entries) {
      roll -= Math.max(0, e.weight);
      if (roll <= 0) return e.value;
    }
    return entries[entries.length - 1]!.value;
  }

  /** Snapshot/restore for save-and-replay of a random stream. */
  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }

  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt, 0x85ebca6b)) >>> 0);
  }
}

/** Hash a string into a uint32 seed (FNV-1a). Stable across runs and platforms. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combine seeds without losing entropy — e.g. matchSeed + tick + playerId. */
export function mixSeeds(...seeds: number[]): number {
  let h = 0x9e3779b9;
  for (const s of seeds) {
    h ^= s >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/**
 * Day index in UTC — the reset boundary for daily quests and login streaks.
 * Using a pure function of the timestamp keeps reset logic testable.
 */
export function utcDayIndex(timestampMs: number): number {
  return Math.floor(timestampMs / 86_400_000);
}

/** ISO week index in UTC — the reset boundary for weekly quests. */
export function utcWeekIndex(timestampMs: number): number {
  // Epoch (1970-01-01) was a Thursday; shift by 4 days so weeks start Monday.
  return Math.floor((utcDayIndex(timestampMs) + 4) / 7);
}
