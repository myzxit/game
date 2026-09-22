/**
 * Friends, blocking, muting and reports.
 *
 * Reports deliberately store the minimum needed to review an incident: who, of
 * whom, why, when, and the match id. No chat transcripts, no free-form personal
 * data beyond the reporter's own optional note, and reports expire.
 */

import {
  createLogger,
  ErrorCode,
  fail,
  ok,
  type Result,
} from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { ProfileService } from './ProfileService.js';

const log = createLogger('Social');

export type ReportReason = 'cheating' | 'abuse' | 'exploit' | 'other';

export interface PlayerReport {
  id: string;
  reporterId: string;
  targetId: string;
  reason: ReportReason;
  /** Optional note, already sanitised and length-capped by the validator. */
  details: string;
  matchId: string | null;
  at: number;
}

const MAX_FRIENDS = 200;
const MAX_BLOCKED = 200;
/** Reports older than this are dropped — we don't keep an indefinite record. */
const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class SocialService {
  private readonly reports: PlayerReport[] = [];
  /** Per-reporter, per-target cooldown so the button can't be spammed. */
  private readonly recentReports = new Map<string, number>();
  private nextReportId = 1;
  /** Session-scoped mutes; deliberately not persisted. */
  private readonly mutes = new Map<string, Set<string>>();

  constructor(private readonly profiles: ProfileService) {}

  // -------------------------------------------------------------- friends --

  addFriend(profile: PlayerProfile, friendId: string): Result<void> {
    if (friendId === profile.id) return fail(ErrorCode.Validation, 'cannot friend yourself');
    if (profile.blockedIds.includes(friendId)) {
      return fail(ErrorCode.Forbidden, 'unblock them first');
    }
    if (profile.friendIds.includes(friendId)) return ok(undefined);
    if (profile.friendIds.length >= MAX_FRIENDS) {
      return fail(ErrorCode.Validation, 'friend list is full');
    }
    profile.friendIds.push(friendId);
    this.profiles.markDirty(profile.id);
    return ok(undefined);
  }

  removeFriend(profile: PlayerProfile, friendId: string): Result<void> {
    const index = profile.friendIds.indexOf(friendId);
    if (index < 0) return fail(ErrorCode.NotFound, 'not a friend');
    profile.friendIds.splice(index, 1);
    this.profiles.markDirty(profile.id);
    return ok(undefined);
  }

  // -------------------------------------------------------------- blocking --

  setBlocked(profile: PlayerProfile, targetId: string, blocked: boolean): Result<void> {
    if (targetId === profile.id) return fail(ErrorCode.Validation, 'cannot block yourself');

    const index = profile.blockedIds.indexOf(targetId);
    if (blocked) {
      if (index >= 0) return ok(undefined);
      if (profile.blockedIds.length >= MAX_BLOCKED) {
        return fail(ErrorCode.Validation, 'block list is full');
      }
      profile.blockedIds.push(targetId);
      // Blocking implies unfriending.
      const friendIndex = profile.friendIds.indexOf(targetId);
      if (friendIndex >= 0) profile.friendIds.splice(friendIndex, 1);
    } else {
      if (index < 0) return ok(undefined);
      profile.blockedIds.splice(index, 1);
    }

    this.profiles.markDirty(profile.id);
    return ok(undefined);
  }

  /** Blocked players' chat is dropped before it reaches the recipient. */
  hasBlocked(profile: PlayerProfile, otherId: string): boolean {
    return profile.blockedIds.includes(otherId);
  }

  // ---------------------------------------------------------------- mutes --

  setMuted(playerId: string, targetId: string, muted: boolean): void {
    let set = this.mutes.get(playerId);
    if (!set) {
      set = new Set();
      this.mutes.set(playerId, set);
    }
    if (muted) set.add(targetId);
    else set.delete(targetId);
  }

  isMuted(playerId: string, targetId: string): boolean {
    return this.mutes.get(playerId)?.has(targetId) === true;
  }

  clearSession(playerId: string): void {
    this.mutes.delete(playerId);
  }

  // -------------------------------------------------------------- reports --

  report(
    reporterId: string,
    targetId: string,
    reason: ReportReason,
    details: string,
    matchId: string | null,
    now = Date.now(),
  ): Result<PlayerReport> {
    if (reporterId === targetId) return fail(ErrorCode.Validation, 'cannot report yourself');

    const key = `${reporterId}:${targetId}`;
    const last = this.recentReports.get(key) ?? 0;
    if (now - last < 5 * 60_000) {
      return fail(ErrorCode.RateLimited, 'already reported this player recently');
    }

    this.prune(now);

    const report: PlayerReport = {
      id: `report_${this.nextReportId++}`,
      reporterId,
      targetId,
      reason,
      // Cap again defensively — validation already did this, but this is the
      // only thing that gets written down, so it is worth being sure.
      details: details.slice(0, 300),
      matchId,
      at: now,
    };

    this.reports.push(report);
    this.recentReports.set(key, now);
    log.info('player reported', { targetId, reason, matchId });
    return ok(report);
  }

  private prune(now: number): void {
    const cutoff = now - REPORT_RETENTION_MS;
    while (this.reports.length > 0 && this.reports[0]!.at < cutoff) this.reports.shift();
    for (const [key, at] of Array.from(this.recentReports.entries())) {
      if (at < cutoff) this.recentReports.delete(key);
    }
  }

  /** Reports against a player, for operator review. */
  reportsAgainst(targetId: string): PlayerReport[] {
    return this.reports.filter((r) => r.targetId === targetId);
  }

  /** Players with the most reports — the operator triage list. */
  topReported(limit = 20): { targetId: string; count: number; reasons: Record<string, number> }[] {
    const counts = new Map<string, { count: number; reasons: Record<string, number> }>();
    for (const r of this.reports) {
      const entry = counts.get(r.targetId) ?? { count: 0, reasons: {} };
      entry.count++;
      entry.reasons[r.reason] = (entry.reasons[r.reason] ?? 0) + 1;
      counts.set(r.targetId, entry);
    }
    return Array.from(counts.entries())
      .map(([targetId, v]) => ({ targetId, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  get reportCount(): number {
    return this.reports.length;
  }
}
