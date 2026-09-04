/**
 * Free For All — everyone against everyone; first to the kill limit wins.
 */

import { type KillEvent } from '@titan/shared';
import {
  BaseGameMode,
  draw,
  noEnd,
  playerWin,
  type EndCondition,
  type MatchView,
  type ScoreDelta,
} from './GameMode.js';

export class FreeForAll extends BaseGameMode {
  override onKill(view: MatchView, event: KillEvent): ScoreDelta | null {
    if (!event.killerId) {
      // Suicide costs a point, so there is no benefit to dying deliberately.
      return { players: [{ playerId: event.victimId, amount: -1 }] };
    }
    if (event.killerId === event.victimId) {
      return { players: [{ playerId: event.victimId, amount: -1 }] };
    }
    void view;
    return { players: [{ playerId: event.killerId, amount: 1 }] };
  }

  checkMatchEnd(view: MatchView): EndCondition {
    for (const [playerId, score] of view.playerScores) {
      if (score >= this.config.scoreLimit) return playerWin(playerId, 'match.victory');
    }

    if (this.timeExpired(view)) {
      const leader = this.leadingPlayer(view);
      return leader === null ? draw('match.draw') : playerWin(leader, 'match.victory');
    }

    return noEnd();
  }
}
