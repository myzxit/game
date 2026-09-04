/**
 * Behavioural anti-cheat.
 *
 * Scope and limits, stated plainly:
 *
 * This is a *server-side plausibility checker*. It never inspects the player's
 * machine, never scans their processes, never installs a driver and never
 * deletes anything. It cannot detect a cheat that only produces plausible
 * inputs (a subtle aimbot with human-like error). What it does do is make the
 * profitable cheats — speed, teleport, fire-rate, infinite ammo, reach —
 * impossible rather than merely detectable, because the server simulates the
 * authoritative result and simply ignores impossible claims.
 *
 * Detection here is the second line. The first is that the server never trusts
 * a client-reported outcome at all (see MatchInstance), and the third is that
 * every economy mutation is server-side (see EconomyService).
 */

import {
  clamp,
  createLogger,
  MAX_INPUT_DELTA_MS,
  TICK_MS,
  v3dist,
  type MovementProfile,
  type PlayerInput,
  type Vec3,
} from '@titan/shared';

const log = createLogger('AntiCheat');

export enum ViolationKind {
  /** Moved further than the movement model allows. */
  Speed = 'speed',
  /** Position jumped discontinuously. */
  Teleport = 'teleport',
  /** Fired faster than the weapon permits. */
  FireRate = 'fire_rate',
  /** Claimed a hit at an impossible range. */
  Reach = 'reach',
  /** Sent inputs faster than wall-clock time allows. */
  TimeDilation = 'time_dilation',
  /** Malformed or out-of-range message field. */
  Protocol = 'protocol',
  /** Too many messages per second. */
  Flood = 'flood',
  /** Input sequence numbers went backwards or repeated. */
  Sequence = 'sequence',
}

export interface Violation {
  kind: ViolationKind;
  detail: string;
  /** How much this contributes to the strike score. */
  weight: number;
  at: number;
}

export interface PlayerAudit {
  playerId: string;
  violations: Violation[];
  score: number;
  /** Total simulated milliseconds this player has claimed. */
  claimedTimeMs: number;
  /** Wall-clock milliseconds since their session started. */
  wallClockMs: number;
  lastSequence: number;
  lastShotAtMs: number;
  sessionStartedAt: number;
}

/**
 * Score at which a player is flagged. Deliberately not an auto-ban: false
 * positives from bad connections are real, so this surfaces the player for
 * operator review rather than acting on its own.
 */
export const FLAG_THRESHOLD = 100;

export class AntiCheat {
  private readonly audits = new Map<string, PlayerAudit>();

  begin(playerId: string, now = Date.now()): PlayerAudit {
    const audit: PlayerAudit = {
      playerId,
      violations: [],
      score: 0,
      claimedTimeMs: 0,
      wallClockMs: 0,
      lastSequence: -1,
      lastShotAtMs: 0,
      sessionStartedAt: now,
    };
    this.audits.set(playerId, audit);
    return audit;
  }

  end(playerId: string): void {
    this.audits.delete(playerId);
  }

  audit(playerId: string): PlayerAudit | null {
    return this.audits.get(playerId) ?? null;
  }

  private flag(playerId: string, kind: ViolationKind, detail: string, weight: number, now: number): void {
    const audit = this.audits.get(playerId) ?? this.begin(playerId, now);
    audit.violations.push({ kind, detail, weight, at: now });
    audit.score += weight;
    // Keep the list bounded; the score is the durable signal.
    if (audit.violations.length > 200) audit.violations.shift();

    if (audit.score >= FLAG_THRESHOLD) {
      log.warn('player flagged for review', { playerId, score: audit.score, kind, detail });
    } else {
      log.debug('violation', { playerId, kind, detail, weight });
    }
  }

  /**
   * Reject an input whose sequence number is not strictly increasing.
   * Replayed inputs are how a naive client tries to move twice per tick.
   */
  checkSequence(playerId: string, input: PlayerInput, now = Date.now()): boolean {
    const audit = this.audits.get(playerId) ?? this.begin(playerId, now);
    if (input.sequence <= audit.lastSequence) {
      // Duplicates are common with packet loss + resend, so this is cheap to
      // discard and only counts as a violation when it happens a lot.
      this.flag(playerId, ViolationKind.Sequence, `seq ${input.sequence} <= ${audit.lastSequence}`, 0.5, now);
      return false;
    }
    audit.lastSequence = input.sequence;
    return true;
  }

  /**
   * Time-dilation check: a client cannot simulate more milliseconds than have
   * actually elapsed. A generous margin absorbs legitimate jitter and catch-up
   * after a hitch.
   */
  checkTimeBudget(playerId: string, deltaMs: number, now = Date.now()): boolean {
    const audit = this.audits.get(playerId) ?? this.begin(playerId, now);
    audit.claimedTimeMs += deltaMs;
    audit.wallClockMs = now - audit.sessionStartedAt;

    // Allow 25% over wall clock plus a 3s constant, so short bursts of catch-up
    // are fine but sustained speed-hacking is not.
    const budget = audit.wallClockMs * 1.25 + 3000;
    if (audit.claimedTimeMs > budget) {
      this.flag(
        playerId,
        ViolationKind.TimeDilation,
        `claimed ${Math.round(audit.claimedTimeMs)}ms of ${Math.round(audit.wallClockMs)}ms`,
        8,
        now,
      );
      // Re-baseline so one offence doesn't flag every subsequent input.
      audit.claimedTimeMs = budget;
      return false;
    }
    return true;
  }

  /**
   * Position plausibility.
   *
   * The server has already simulated the authoritative position, so this does
   * not *correct* anything — it detects a client whose predicted position is
   * diverging in a way that suggests tampering rather than latency.
   */
  checkMovement(
    playerId: string,
    from: Vec3,
    to: Vec3,
    deltaMs: number,
    profile: MovementProfile,
    now = Date.now(),
  ): boolean {
    const distance = v3dist(from, to);
    const seconds = clamp(deltaMs, 1, MAX_INPUT_DELTA_MS) / 1000;

    // The fastest legitimate horizontal movement is a dash; vertically it is
    // terminal velocity. Use a generous combined bound plus a constant to
    // absorb step-ups and slope snapping.
    const maxSpeed = Math.max(profile.dashImpulse, profile.sprintSpeed + profile.slideImpulse, 60);
    const allowed = maxSpeed * seconds + 0.6;

    if (distance > allowed) {
      const kind = distance > allowed * 4 ? ViolationKind.Teleport : ViolationKind.Speed;
      this.flag(
        playerId,
        kind,
        `moved ${distance.toFixed(2)}m in ${deltaMs}ms (max ${allowed.toFixed(2)}m)`,
        kind === ViolationKind.Teleport ? 25 : 6,
        now,
      );
      return false;
    }
    return true;
  }

  /**
   * Fire-rate check.
   *
   * The weapon state machine already gates firing, so this catches a client
   * that is sending shot intents faster than any weapon can fire — which means
   * the client-side gate was removed.
   */
  checkFireRate(playerId: string, minIntervalMs: number, now = Date.now()): boolean {
    const audit = this.audits.get(playerId) ?? this.begin(playerId, now);
    // 15% tolerance: a client running ahead by a frame is normal.
    const floor = minIntervalMs * 0.85;
    const elapsed = now - audit.lastShotAtMs;

    if (audit.lastShotAtMs > 0 && elapsed < floor) {
      this.flag(
        playerId,
        ViolationKind.FireRate,
        `${elapsed}ms between shots, minimum ${Math.round(floor)}ms`,
        4,
        now,
      );
      return false;
    }
    audit.lastShotAtMs = now;
    return true;
  }

  /**
   * Reach check: a claimed hit further than the weapon's maximum range, or a
   * melee hit from across the map.
   */
  checkReach(playerId: string, distance: number, maxRange: number, now = Date.now()): boolean {
    // 10% tolerance for lag-compensated positions.
    if (distance > maxRange * 1.1) {
      this.flag(
        playerId,
        ViolationKind.Reach,
        `hit at ${distance.toFixed(1)}m with ${maxRange}m range`,
        20,
        now,
      );
      return false;
    }
    return true;
  }

  /** Called by the connection layer when a message fails validation. */
  reportProtocolViolation(playerId: string, detail: string, suspicious: boolean, now = Date.now()): void {
    this.flag(playerId, ViolationKind.Protocol, detail, suspicious ? 5 : 0.5, now);
  }

  reportFlood(playerId: string, detail: string, now = Date.now()): void {
    this.flag(playerId, ViolationKind.Flood, detail, 3, now);
  }

  isFlagged(playerId: string): boolean {
    return (this.audits.get(playerId)?.score ?? 0) >= FLAG_THRESHOLD;
  }

  /** Flagged players, for the operator dashboard. */
  flagged(): PlayerAudit[] {
    return Array.from(this.audits.values()).filter((a) => a.score >= FLAG_THRESHOLD);
  }

  /** Summary for one player, for the admin tools. */
  summary(playerId: string): { score: number; counts: Record<string, number> } | null {
    const audit = this.audits.get(playerId);
    if (!audit) return null;
    const counts: Record<string, number> = {};
    for (const v of audit.violations) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
    return { score: audit.score, counts };
  }
}

/** Ticks a player may legitimately be behind before we stop buffering input. */
export const MAX_INPUT_BACKLOG_TICKS = Math.ceil(500 / TICK_MS);
