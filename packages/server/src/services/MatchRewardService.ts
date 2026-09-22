/**
 * Turning a finished match into progression.
 *
 * This is the join point between the match simulation and the meta-game: it
 * reads the authoritative match result, updates lifetime stats, awards XP and
 * coins, feeds the quest tracker, applies rank changes, and produces the result
 * payload the client shows on the post-match screen.
 *
 * It runs entirely from the match's own recorded state — never from anything a
 * client reported.
 */

import {
  COIN_REWARDS,
  Currency,
  ECONOMY,
  GameModeId,
  MatchPhase,
  ObjectiveType,
  TeamId,
  XP_REWARDS,
  createLogger,
  getWeapon,
  type MatchResultPlayer,
} from '@titan/shared';
import type { MatchInstance } from '../match/MatchInstance.js';
import { MatchEventType } from '../match/MatchEvents.js';
import type { PlayerProfile } from '../data/schema.js';
import type { EconomyService } from './EconomyService.js';
import type { ProfileService } from './ProfileService.js';
import type { ProgressionService } from './ProgressionService.js';
import type { QuestService, QuestEvent } from './QuestService.js';
import type { AnalyticsService } from './AnalyticsService.js';
import type { LeaderboardService } from './LeaderboardService.js';

const log = createLogger('MatchRewards');

export interface PlayerMatchOutcome {
  playerId: string;
  result: MatchResultPlayer;
  leveledUpTo: number | null;
  rankChange: { from: string; to: string; promoted: boolean } | null;
  questsCompleted: string[];
  achievementsUnlocked: string[];
  itemsGranted: string[];
}

export class MatchRewardService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly economy: EconomyService,
    private readonly progression: ProgressionService,
    private readonly quests: QuestService,
    private readonly analytics: AnalyticsService,
    private readonly leaderboards: LeaderboardService,
  ) {}

  /**
   * Award everything for a finished match.
   * `profileFor` resolves a player id to their cached profile; players who have
   * fully disconnected are skipped rather than silently losing rewards, because
   * their profile is kept alive through the reconnect window.
   */
  finalize(
    match: MatchInstance,
    profileFor: (playerId: string) => PlayerProfile | null,
    now = Date.now(),
  ): PlayerMatchOutcome[] {
    const outcomes: PlayerMatchOutcome[] = [];
    const durationMinutes = match.elapsedMs / 60_000;
    const mode = match.mode.config;

    // Average opponent rating, for the ranked calculation.
    const ratings = Array.from(match.ratings.values());
    const averageRating =
      ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 1000;

    // MVP is the highest match score; ties go to the higher damage total.
    const ranked = Array.from(match.players.values()).sort(
      (a, b) => b.score - a.score || b.damageDealt - a.damageDealt,
    );
    const mvpId = ranked[0]?.id ?? null;

    for (const player of match.players.values()) {
      const profile = profileFor(player.id);
      if (!profile) {
        log.warn('no profile for player at match end — rewards skipped', { playerId: player.id });
        continue;
      }

      this.profiles.rolloverDaily(profile, now);

      const won = this.didWin(match, player.team, player.id);

      // ---- Lifetime stats -------------------------------------------------
      const stats = profile.stats;
      stats.kills += player.kills;
      stats.deaths += player.deaths;
      stats.assists += player.assists;
      stats.headshots += player.headshots;
      stats.damageDealt += Math.round(player.damageDealt);
      stats.shotsFired += player.shotsFired;
      stats.shotsHit += player.shotsHit;
      stats.playtimeMs += match.elapsedMs;
      stats.matchesPlayed += 1;
      stats.bestStreak = Math.max(stats.bestStreak, player.bestStreak);
      stats.bestScore = Math.max(stats.bestScore, Math.round(player.score));
      stats.vehicleDistance += Math.round(player.vehicleDistance);
      stats.modeMatches[mode.id] = (stats.modeMatches[mode.id] ?? 0) + 1;
      if (won) stats.wins += 1;
      else stats.losses += 1;

      // Per-weapon kills, from the recorded events rather than a running tally,
      // so the analytics and the profile can never disagree.
      for (const kill of match.recorder.ofType(MatchEventType.Kill)) {
        if (kill.killerId !== player.id || !kill.weaponId) continue;
        stats.weaponKills[kill.weaponId] = (stats.weaponKills[kill.weaponId] ?? 0) + 1;
        this.analytics.weaponKill(kill.weaponId);
      }

      // ---- XP -------------------------------------------------------------
      let xp = 0;
      xp += player.kills * XP_REWARDS.kill;
      xp += player.assists * XP_REWARDS.assist;
      xp += player.headshots * XP_REWARDS.headshotBonus;
      xp += Math.round(durationMinutes * XP_REWARDS.matchCompletionPerMinute);
      xp += won ? XP_REWARDS.matchWin : XP_REWARDS.matchLoss;
      if (player.bestStreak > 2) xp += (player.bestStreak - 2) * XP_REWARDS.killStreakBonus;
      xp = Math.round(xp * mode.xpMultiplier);

      const seasonXp = Math.round(xp * 0.6);
      const progressionResult = this.progression.awardXp(
        profile,
        { amount: xp, reason: `match:${match.id}`, seasonXp },
        now,
      );

      // ---- Coins ----------------------------------------------------------
      let coins = 0;
      coins += player.kills * COIN_REWARDS.kill;
      coins += player.assists * COIN_REWARDS.assist;
      coins += Math.round(durationMinutes * COIN_REWARDS.perMinute);
      coins += won ? COIN_REWARDS.matchWin : COIN_REWARDS.matchLoss;
      coins = Math.round(coins * mode.coinMultiplier * ECONOMY.coinEarnMultiplier);

      const coinResult = this.economy.grant(
        profile,
        Currency.Coins,
        coins,
        { reason: `match:${match.id}`, countsTowardDailyCap: true },
        now,
      );
      const coinsEarned = coinResult.ok ? coinResult.value : 0;

      // ---- Quests ---------------------------------------------------------
      const questEvents = this.buildQuestEvents(match, player.id, won, mode.id);
      const completions = this.quests.trackMany(profile, questEvents, now);
      for (const c of completions) this.analytics.questCompleted(c.questId);
      const achievements = this.quests.syncStatAchievements(profile, now);

      // ---- Rank -----------------------------------------------------------
      let rankChange: PlayerMatchOutcome['rankChange'] = null;
      let rankDelta = 0;
      if (mode.ranked) {
        // Performance relative to the lobby: 1.0 is average.
        const lobbyAverageScore =
          ranked.length > 0
            ? ranked.reduce((a, p) => a + p.score, 0) / ranked.length
            : 1;
        const performance =
          lobbyAverageScore > 0 ? Math.min(2, player.score / lobbyAverageScore) : 1;

        const result = this.progression.applyRankedResult(profile, won, averageRating, performance);
        rankDelta = result.delta;
        rankChange = { from: result.from, to: result.to, promoted: result.promoted };
      }

      this.profiles.markDirty(profile.id);
      this.leaderboards.upsert(profile);

      const matchResult: MatchResultPlayer = {
        playerId: player.id,
        displayName: player.displayName,
        team: player.team,
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        damage: Math.round(player.damageDealt),
        headshots: player.headshots,
        score: Math.round(player.score),
        bestStreak: player.bestStreak,
        accuracy: player.accuracy,
        xpEarned: xp,
        coinsEarned,
        rankDelta,
        mvp: player.id === mvpId,
      };

      outcomes.push({
        playerId: player.id,
        result: matchResult,
        leveledUpTo: progressionResult.leveledUpTo,
        rankChange,
        questsCompleted: completions.map((c) => c.questId),
        achievementsUnlocked: achievements,
        itemsGranted: progressionResult.itemsGranted,
      });

      this.analytics.weaponFired('all', player.shotsFired, player.shotsHit);
    }

    this.analytics.matchCompleted(
      mode.id,
      match.elapsedMs,
      match.winningTeam === TeamId.None ? 'none' : String(match.winningTeam),
    );

    log.info('match rewards applied', { matchId: match.id, players: outcomes.length });
    return outcomes;
  }

  private didWin(match: MatchInstance, team: TeamId, playerId: string): boolean {
    if (match.mode.config.teamBased) return match.winningTeam === team;
    return match.winningPlayerId === playerId;
  }

  /** Translate a player's match performance into quest events. */
  private buildQuestEvents(
    match: MatchInstance,
    playerId: string,
    won: boolean,
    modeId: string,
  ): QuestEvent[] {
    const player = match.players.get(playerId);
    if (!player) return [];

    const events: QuestEvent[] = [
      { type: ObjectiveType.PlayMatch, amount: 1 },
      { type: ObjectiveType.PlayMode, target: modeId, amount: 1 },
      { type: ObjectiveType.Assist, amount: player.assists },
      { type: ObjectiveType.Headshot, amount: player.headshots },
      { type: ObjectiveType.DealDamage, amount: Math.round(player.damageDealt) },
      { type: ObjectiveType.UseSkill, amount: player.skill?.uses ?? 0 },
      { type: ObjectiveType.VehicleDistance, amount: Math.round(player.vehicleDistance) },
    ];

    if (won) events.push({ type: ObjectiveType.WinMatch, amount: 1 });
    if (player.bestStreak > 0) {
      events.push({ type: ObjectiveType.KillStreak, value: player.bestStreak, amount: 1 });
    }

    // Per-kill events carry the weapon, its class and the distance, so
    // weapon-specific and long-shot quests can be counted exactly.
    for (const kill of match.recorder.ofType(MatchEventType.Kill)) {
      if (kill.killerId !== playerId) continue;
      events.push({ type: ObjectiveType.Kill, amount: 1 });
      if (kill.weaponId) {
        events.push({ type: ObjectiveType.KillWithWeapon, target: kill.weaponId, amount: 1 });
        const weapon = getWeapon(kill.weaponId);
        if (weapon) {
          events.push({
            type: ObjectiveType.KillWithWeaponClass,
            target: weapon.class,
            amount: 1,
          });
        }
      }
      events.push({ type: ObjectiveType.LongShot, value: kill.distance, amount: 1 });
    }

    // Zones entered this match.
    for (const zoneId of player.visitedZones) {
      events.push({ type: ObjectiveType.VisitZone, target: zoneId, amount: 1 });
    }

    return events;
  }

  /** Modes that award rank points. */
  static isRankedMode(modeId: string): boolean {
    return modeId === GameModeId.Ranked;
  }

  static isFinished(match: MatchInstance): boolean {
    return match.phase === MatchPhase.MatchEnd;
  }
}
