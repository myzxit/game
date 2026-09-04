/**
 * Analytics.
 *
 * Aggregate-only, by design. This records *counts and distributions* needed to
 * balance the game — which weapons get used, which maps get picked, where
 * players drop out of the funnel — and never a per-player behavioural trail.
 * No positions, no chat, no timestamps tied to an individual.
 *
 * Player ids appear only in the transient funnel map, which is keyed by session
 * and discarded once the session ends.
 */

import { createLogger } from '@titan/shared';

const log = createLogger('Analytics');

export enum FunnelStep {
  Connected = 'connected',
  ProfileLoaded = 'profile_loaded',
  EnteredLobby = 'entered_lobby',
  QueuedForMatch = 'queued',
  MatchJoined = 'match_joined',
  MatchCompleted = 'match_completed',
  Disconnected = 'disconnected',
}

export interface AggregateReport {
  /** Matches started and finished, per mode. */
  matchesStarted: Record<string, number>;
  matchesCompleted: Record<string, number>;
  /** Players who left before the match ended, per mode. */
  earlyLeaves: Record<string, number>;

  /** Total match duration per mode, for computing averages. */
  totalMatchMs: Record<string, number>;

  /** Map selection counts. */
  mapPicks: Record<string, number>;

  /** Kills and shots per weapon — the core balance signal. */
  weaponKills: Record<string, number>;
  weaponShots: Record<string, number>;
  weaponHits: Record<string, number>;

  /** Wins per team side, to detect map-side imbalance. */
  sideWins: Record<string, number>;

  /** Quest completions and crate opens. */
  questCompletions: Record<string, number>;
  crateOpens: Record<string, number>;

  /** Funnel counts. */
  funnel: Record<string, number>;

  /** Errors by code, so recurring failures are visible. */
  errors: Record<string, number>;
}

function emptyReport(): AggregateReport {
  return {
    matchesStarted: {},
    matchesCompleted: {},
    earlyLeaves: {},
    totalMatchMs: {},
    mapPicks: {},
    weaponKills: {},
    weaponShots: {},
    weaponHits: {},
    sideWins: {},
    questCompletions: {},
    crateOpens: {},
    funnel: {},
    errors: {},
  };
}

const bump = (record: Record<string, number>, key: string, amount = 1): void => {
  record[key] = (record[key] ?? 0) + amount;
};

export class AnalyticsService {
  private report = emptyReport();
  /** Furthest funnel step reached per live session. Cleared on disconnect. */
  private readonly sessionFunnel = new Map<string, FunnelStep>();
  private readonly startedAt = Date.now();

  recordFunnel(sessionId: string, step: FunnelStep): void {
    this.sessionFunnel.set(sessionId, step);
    bump(this.report.funnel, step);
  }

  endSession(sessionId: string): void {
    this.sessionFunnel.delete(sessionId);
  }

  matchStarted(modeId: string, mapId: string): void {
    bump(this.report.matchesStarted, modeId);
    bump(this.report.mapPicks, mapId);
  }

  matchCompleted(modeId: string, durationMs: number, winningSide: string): void {
    bump(this.report.matchesCompleted, modeId);
    bump(this.report.totalMatchMs, modeId, durationMs);
    bump(this.report.sideWins, winningSide);
  }

  playerLeftEarly(modeId: string): void {
    bump(this.report.earlyLeaves, modeId);
  }

  weaponKill(weaponId: string): void {
    bump(this.report.weaponKills, weaponId);
  }

  weaponFired(weaponId: string, shots: number, hits: number): void {
    bump(this.report.weaponShots, weaponId, shots);
    bump(this.report.weaponHits, weaponId, hits);
  }

  questCompleted(questId: string): void {
    bump(this.report.questCompletions, questId);
  }

  crateOpened(crateId: string): void {
    bump(this.report.crateOpens, crateId);
  }

  errorOccurred(code: string): void {
    bump(this.report.errors, code);
  }

  /** Derived view for the operator dashboard. */
  summary(): {
    uptimeMs: number;
    averageMatchMs: Record<string, number>;
    weaponUsage: { weaponId: string; kills: number; accuracy: number; share: number }[];
    completionRate: Record<string, number>;
    raw: AggregateReport;
  } {
    const averageMatchMs: Record<string, number> = {};
    for (const [modeId, total] of Object.entries(this.report.totalMatchMs)) {
      const completed = this.report.matchesCompleted[modeId] ?? 0;
      if (completed > 0) averageMatchMs[modeId] = Math.round(total / completed);
    }

    const totalKills = Object.values(this.report.weaponKills).reduce((a, b) => a + b, 0);
    const weaponUsage = Object.entries(this.report.weaponKills)
      .map(([weaponId, kills]) => {
        const shots = this.report.weaponShots[weaponId] ?? 0;
        const hits = this.report.weaponHits[weaponId] ?? 0;
        return {
          weaponId,
          kills,
          accuracy: shots > 0 ? hits / shots : 0,
          share: totalKills > 0 ? kills / totalKills : 0,
        };
      })
      .sort((a, b) => b.kills - a.kills);

    const completionRate: Record<string, number> = {};
    for (const [modeId, started] of Object.entries(this.report.matchesStarted)) {
      const completed = this.report.matchesCompleted[modeId] ?? 0;
      completionRate[modeId] = started > 0 ? completed / started : 0;
    }

    return {
      uptimeMs: Date.now() - this.startedAt,
      averageMatchMs,
      weaponUsage,
      completionRate,
      raw: this.report,
    };
  }

  /**
   * A weapon taking a disproportionate share of kills is the signal a balance
   * pass is needed. Surfaced by the dev balance tool.
   */
  balanceOutliers(threshold = 0.25): { weaponId: string; share: number }[] {
    const summary = this.summary();
    return summary.weaponUsage
      .filter((w) => w.share >= threshold)
      .map((w) => ({ weaponId: w.weaponId, share: w.share }));
  }

  reset(): void {
    log.info('analytics reset', { previousUptimeMs: Date.now() - this.startedAt });
    this.report = emptyReport();
  }
}
