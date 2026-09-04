/**
 * Profile cache and lifecycle.
 *
 * Services mutate the in-memory profile and mark it dirty; this service batches
 * writes so a busy match doesn't hit the disk on every kill. Dirty profiles are
 * flushed on a timer, on disconnect, and on shutdown.
 */

import {
  createLogger,
  ErrorCode,
  fail,
  ok,
  utcDayIndex,
  type Result,
} from '@titan/shared';
import { createProfile, type PlayerProfile } from '../data/schema.js';
import type { ProfileStore } from '../data/ProfileStore.js';

const log = createLogger('ProfileService');

export interface ProfileServiceOptions {
  /** How often dirty profiles are written. */
  autosaveIntervalMs: number;
  /** How long a profile stays cached after its owner disconnects. */
  evictAfterMs: number;
}

const DEFAULTS: ProfileServiceOptions = {
  autosaveIntervalMs: 15_000,
  evictAfterMs: 5 * 60_000,
};

interface CacheEntry {
  profile: PlayerProfile;
  dirty: boolean;
  /** null while the owner is connected. */
  releasedAt: number | null;
}

export class ProfileService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly options: ProfileServiceOptions;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: ProfileStore,
    options: Partial<ProfileServiceOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.autosave();
    }, this.options.autosaveIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.saveAllDirty();
    await this.store.flush();
  }

  /**
   * Load a profile into the cache, creating one for a new player.
   * `displayName` is only used when creating.
   */
  async acquire(id: string, displayName: string, now = Date.now()): Promise<Result<PlayerProfile>> {
    const cached = this.cache.get(id);
    if (cached) {
      cached.releasedAt = null;
      cached.profile.lastSeenAt = now;
      cached.dirty = true;
      return ok(cached.profile);
    }

    const loaded = await this.store.load(id);
    if (!loaded.ok) {
      // Both save copies were unreadable. Refuse rather than silently wiping
      // the player's progress — an operator needs to see this.
      log.error('refusing to overwrite an unreadable profile', { id, detail: loaded.error.detail });
      return fail(ErrorCode.Storage, loaded.error.detail);
    }

    const profile = loaded.value ?? createProfile(id, displayName, now);
    profile.lastSeenAt = now;
    this.cache.set(id, { profile, dirty: loaded.value === null, releasedAt: null });
    return ok(profile);
  }

  /** Cached profile, or null. Never hits the disk. */
  peek(id: string): PlayerProfile | null {
    return this.cache.get(id)?.profile ?? null;
  }

  /** Mark a profile as changed so the next autosave picks it up. */
  markDirty(id: string): void {
    const entry = this.cache.get(id);
    if (entry) entry.dirty = true;
  }

  /** Convenience: mutate and mark dirty in one call. */
  update<T>(id: string, fn: (p: PlayerProfile) => T): T | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    const result = fn(entry.profile);
    entry.dirty = true;
    return result;
  }

  /** Owner disconnected: save now, then let it age out of the cache. */
  async release(id: string, now = Date.now()): Promise<void> {
    const entry = this.cache.get(id);
    if (!entry) return;
    entry.releasedAt = now;
    entry.profile.lastSeenAt = now;
    entry.dirty = true;
    await this.saveEntry(id, entry);
  }

  /** Force a write for one profile. */
  async save(id: string): Promise<Result<void>> {
    const entry = this.cache.get(id);
    if (!entry) return fail(ErrorCode.NotFound, `profile ${id} not cached`);
    return this.saveEntry(id, entry);
  }

  private async saveEntry(id: string, entry: CacheEntry): Promise<Result<void>> {
    if (!entry.dirty) return ok(undefined);
    const result = await this.store.save(entry.profile);
    // Only clear the dirty flag on success; a failed write stays queued so the
    // next autosave tries again (and the store retries independently).
    if (result.ok) entry.dirty = false;
    return result;
  }

  private async autosave(now = Date.now()): Promise<void> {
    for (const [id, entry] of Array.from(this.cache.entries())) {
      if (entry.dirty) await this.saveEntry(id, entry);
      if (
        entry.releasedAt !== null &&
        !entry.dirty &&
        now - entry.releasedAt > this.options.evictAfterMs
      ) {
        this.cache.delete(id);
      }
    }
  }

  private async saveAllDirty(): Promise<void> {
    for (const [id, entry] of Array.from(this.cache.entries())) {
      await this.saveEntry(id, entry);
    }
  }

  /**
   * Reset per-day counters when the UTC day rolls over.
   * Called on login and at the start of each match.
   */
  rolloverDaily(profile: PlayerProfile, now = Date.now()): boolean {
    const day = utcDayIndex(now);
    if (profile.dailyCoinsDayIndex === day) return false;
    profile.dailyCoinsDayIndex = day;
    profile.dailyCoinsEarned = 0;
    this.markDirty(profile.id);
    return true;
  }

  get cachedCount(): number {
    return this.cache.size;
  }

  /** Every cached profile — used by the leaderboard service. */
  cached(): PlayerProfile[] {
    return Array.from(this.cache.values(), (e) => e.profile);
  }
}
