/**
 * Team Deathmatch — first team to the score limit, or the leader at time.
 */

import { TeamId, type KillEvent } from '@titan/shared';
import { BaseGameMode, draw, noEnd, teamWin, type EndCondition, type MatchView, type ScoreDelta } from './GameMode.js';

export class TeamDeathmatch extends BaseGameMode {
  override onKill(view: MatchView, event: KillEvent): ScoreDelta | null {
    if (!event.killerId) {
      // Environmental death or suicide: the *other* team gets the point, so
      // falling off the map still costs your team.
      const victimTeam = view.teamOf(event.victimId);
      const other = victimTeam === TeamId.Alpha ? TeamId.Bravo : TeamId.Alpha;
      return { team: { team: other, amount: 1 } };
    }

    const killerTeam = view.teamOf(event.killerId);
    const victimTeam = view.teamOf(event.victimId);

    // A team kill costs the killer's team a point rather than awarding one.
    if (killerTeam === victimTeam) {
      return {
        team: { team: killerTeam, amount: -1 },
        players: [{ playerId: event.killerId, amount: -1 }],
      };
    }

    const players = [{ playerId: event.killerId, amount: 1 }];
    for (const assistId of event.assistIds) players.push({ playerId: assistId, amount: 0.5 });

    return { team: { team: killerTeam, amount: 1 }, players };
  }

  checkMatchEnd(view: MatchView): EndCondition {
    for (const [team, score] of view.teamScores) {
      if (score >= this.config.scoreLimit) {
        return teamWin(team, 'match.victory');
      }
    }

    if (this.timeExpired(view)) {
      const leader = this.leadingTeam(view);
      return leader === null ? draw('match.draw') : teamWin(leader, 'match.victory');
    }

    return noEnd();
  }
}
