/**
 * Elimination — round-based, no respawns, first team to `roundsToWin`.
 *
 * Ranked is the same rules with a longer series and rank points on the line,
 * so it subclasses this rather than duplicating the logic.
 */

import { TeamId, type KillEvent } from '@titan/shared';
import type { PlayerEntity } from '../match/PlayerEntity.js';
import {
  BaseGameMode,
  draw,
  noEnd,
  teamWin,
  type EndCondition,
  type MatchView,
  type ScoreDelta,
} from './GameMode.js';

export class Elimination extends BaseGameMode {
  override onKill(view: MatchView, event: KillEvent): ScoreDelta | null {
    if (!event.killerId) return null;
    const killerTeam = view.teamOf(event.killerId);
    const victimTeam = view.teamOf(event.victimId);

    // Team kills are heavily penalised: with no respawns, killing a teammate
    // is far more costly to the team than it is in a respawn mode.
    if (killerTeam === victimTeam) {
      return { players: [{ playerId: event.killerId, amount: -2 }] };
    }

    const players = [{ playerId: event.killerId, amount: 2 }];
    for (const assistId of event.assistIds) players.push({ playerId: assistId, amount: 1 });
    return { players };
  }

  /** Nobody respawns mid-round. */
  override canRespawn(_view: MatchView, _player: PlayerEntity): boolean {
    return false;
  }

  override checkRoundEnd(view: MatchView): EndCondition {
    const alphaAlive = view.livingPlayers(TeamId.Alpha).length;
    const bravoAlive = view.livingPlayers(TeamId.Bravo).length;

    if (alphaAlive === 0 && bravoAlive === 0) return draw('match.draw');
    if (alphaAlive === 0) return teamWin(TeamId.Bravo, 'match.round_end');
    if (bravoAlive === 0) return teamWin(TeamId.Alpha, 'match.round_end');

    // Round timer expired: the team with more players standing takes it, and a
    // tie on numbers goes to whoever has dealt more damage this round.
    if (view.roundElapsedMs >= this.config.roundTimeSec * 1000) {
      if (alphaAlive > bravoAlive) return teamWin(TeamId.Alpha, 'match.round_end');
      if (bravoAlive > alphaAlive) return teamWin(TeamId.Bravo, 'match.round_end');

      const alphaDamage = this.teamDamage(view, TeamId.Alpha);
      const bravoDamage = this.teamDamage(view, TeamId.Bravo);
      if (alphaDamage > bravoDamage) return teamWin(TeamId.Alpha, 'match.round_end');
      if (bravoDamage > alphaDamage) return teamWin(TeamId.Bravo, 'match.round_end');
      return draw('match.draw');
    }

    return noEnd();
  }

  private teamDamage(view: MatchView, team: TeamId): number {
    let total = 0;
    for (const player of view.players.values()) {
      if (player.team === team) total += player.damageDealt;
    }
    return total;
  }

  checkMatchEnd(view: MatchView): EndCondition {
    for (const [team, rounds] of view.roundsWon) {
      if (rounds >= this.config.roundsToWin) return teamWin(team, 'match.victory');
    }

    // A best-of series can also end when neither side can still reach the
    // target — but with a fixed rounds-to-win that only happens on exhaustion
    // of the maximum round count, which the match instance caps.
    return noEnd();
  }
}

/** Ranked: identical rules, different series length and rank points at stake. */
export class Ranked extends Elimination {}
