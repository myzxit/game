/**
 * Durable profile storage.
 *
 * Save failures are the one class of bug players never forgive, so the write
 * path is deliberately paranoid:
 *
 *   1. write to a temp file and fsync it,
 *   2. rotate the previous good save to `.bak`,
 *   3. atomically rename the temp file into place.
 *
 * A crash at any point leaves either the old save or the new one intact, never
 * a truncated file. On read, a corrupt primary falls back to the backup. If a
 * write fails entirely the profile stays in memory and is retried with backoff,
 * so a transient disk problem costs nothing.
 *
 * The backing store is a directory of JSON files. That is genuinely enough for
 * a single-server deployment; `ProfileStore` is an interface so a database can
 * be dropped in without touching any service.
 */

import { mkdir, readFile, rename, writeFile, readdir, unlink, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLogger, ErrorCode, fail, ok, type Result } from '@titan/shared';
import { migrate, type PlayerProfile } from './schema.js';

const log = createLogger('ProfileStore');

export interface ProfileStore {
  load(id: string): Promise<Result<PlayerProfile | null>>;
  save(profile: PlayerProfile): Promise<Result<void>>;
  /** Ids of every stored profile — used by the leaderboard rebuild. */
  list(): Promise<string[]>;
  /** Flush anything pending. Called on shutdown. */
  flush(): Promise<void>;
}

/** Ids come from validated input, but the filesystem is worth double-guarding. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class FileProfileStore implements ProfileStore {
  /** Profiles whose last write failed, pending retry. */
  private readonly pending = new Map<string, PlayerProfile>();
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = 1000;
  private closed = false;

  constructor(private readonly directory: string) {}

  private pathFor(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async load(id: string): Promise<Result<PlayerProfile | null>> {
    if (!SAFE_ID.test(id)) {
      return fail(ErrorCode.Validation, `unsafe profile id: ${id}`);
    }

    // An unflushed profile is the freshest copy we have.
    const pending = this.pending.get(id);
    if (pending) return ok(pending);

    const primary = await this.readJson(this.pathFor(id));
    if (primary.found) {
      const result = migrate(primary.value, id, Date.now());
      if (result.applied.length > 0) {
        log.info('migrated profile', { id, from: result.applied });
      }
      if (result.repaired) log.warn('repaired profile fields on load', { id });
      return ok(result.profile);
    }

    // Primary missing or unreadable — try the backup before giving up.
    const backup = await this.readJson(`${this.pathFor(id)}.bak`);
    if (backup.found) {
      log.warn('primary save unreadable, recovered from backup', { id });
      const result = migrate(backup.value, id, Date.now());
      return ok(result.profile);
    }

    if (primary.corrupt || backup.corrupt) {
      // Both copies exist but neither parses. Report it rather than silently
      // handing back a fresh profile, so the caller can decide.
      return fail(ErrorCode.Storage, `profile ${id} is unreadable in both primary and backup`);
    }

    return ok(null); // genuinely a new player
  }

  async save(profile: PlayerProfile): Promise<Result<void>> {
    if (!SAFE_ID.test(profile.id)) {
      return fail(ErrorCode.Validation, `unsafe profile id: ${profile.id}`);
    }
    if (this.closed) return fail(ErrorCode.Unavailable, 'store is closed');

    const result = await this.writeAtomic(profile);
    if (result.ok) {
      this.pending.delete(profile.id);
      return result;
    }

    // Keep the newest state in memory and retry — never drop progress because
    // the disk hiccuped.
    log.error('profile save failed, queued for retry', {
      id: profile.id,
      detail: result.error.detail,
    });
    this.pending.set(profile.id, profile);
    this.scheduleRetry();
    return result;
  }

  private async writeAtomic(profile: PlayerProfile): Promise<Result<void>> {
    const target = this.pathFor(profile.id);
    const temp = `${target}.tmp`;
    const backup = `${target}.bak`;

    try {
      await mkdir(dirname(target), { recursive: true });
      const json = JSON.stringify(profile);

      // Write and fsync the temp file so the bytes are really on disk before
      // we let it replace the good save.
      const handle = await open(temp, 'w');
      try {
        await handle.writeFile(json, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      // Rotate the current save to .bak. Missing primary (first save) is fine.
      try {
        await rename(target, backup);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw e;
      }

      await rename(temp, target);
      return ok(undefined);
    } catch (e) {
      // Clean up the temp file so it can't be mistaken for a real save.
      await unlink(temp).catch(() => undefined);
      return fail(
        ErrorCode.Storage,
        `write failed for ${profile.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async readJson(path: string): Promise<{ found: boolean; corrupt: boolean; value: unknown }> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return { found: false, corrupt: false, value: null };
    }
    try {
      return { found: true, corrupt: false, value: JSON.parse(text) };
    } catch {
      log.error('save file is not valid JSON', { path });
      return { found: false, corrupt: true, value: null };
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drainPending();
    }, this.retryDelayMs);
    // Don't hold the process open just to retry a save.
    this.retryTimer.unref?.();
  }

  private async drainPending(): Promise<void> {
    if (this.pending.size === 0) {
      this.retryDelayMs = 1000;
      return;
    }
    let anyFailed = false;
    for (const profile of Array.from(this.pending.values())) {
      const result = await this.writeAtomic(profile);
      if (result.ok) {
        this.pending.delete(profile.id);
        log.info('queued profile save succeeded on retry', { id: profile.id });
      } else {
        anyFailed = true;
      }
    }
    if (anyFailed) {
      // Exponential backoff, capped, so a full disk doesn't spin the CPU.
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 60_000);
      this.scheduleRetry();
    } else {
      this.retryDelayMs = 1000;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.directory);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  async flush(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.drainPending();
    if (this.pending.size > 0) {
      log.error('shutting down with unsaved profiles', {
        count: this.pending.size,
        ids: Array.from(this.pending.keys()),
      });
    }
    this.closed = true;
  }

  /** Diagnostics for the operator status endpoint. */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/** In-memory store. Used by tests and by `--ephemeral` local runs. */
export class MemoryProfileStore implements ProfileStore {
  private readonly profiles = new Map<string, string>();
  /** Set to make the next write fail — lets tests exercise the retry path. */
  failNextWrite = false;

  async load(id: string): Promise<Result<PlayerProfile | null>> {
    const raw = this.profiles.get(id);
    if (raw === undefined) return ok(null);
    return ok(migrate(JSON.parse(raw), id, Date.now()).profile);
  }

  async save(profile: PlayerProfile): Promise<Result<void>> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return fail(ErrorCode.Storage, 'simulated write failure');
    }
    this.profiles.set(profile.id, JSON.stringify(profile));
    return ok(undefined);
  }

  async list(): Promise<string[]> {
    return Array.from(this.profiles.keys());
  }

  async flush(): Promise<void> {
    /* nothing to flush */
  }
}
