/**
 * Game mode interface.
 *
 * A mode observes the match and decides three things: how score is earned,
 * when a round or match ends, and who won. Everything else — movement, combat,
 * spawning, netcode — is mode-agnostic, which is what makes adding a mode a
 * small, contained job.
 *
 * Modes must not mutate player state directly; they return decisions and let
 * MatchInstance apply them.
 */

import type { GameModeConfig, KillEvent, MatchPhase, TeamId } from '@titan/shared';
import type { PlayerEntity } from '../match/PlayerEntity.js';

/** What a mode can see. Deliberately read-only. */
export interface MatchView {
  readonly mapId: string;
  readonly phase: MatchPhase;
  readonly players: ReadonlyMap<string, PlayerEntity>;
  readonly elapsedMs: number;
  readonly roundElapsedMs: number;
  readonly round: number;
  readonly teamScores: ReadonlyMap<TeamId, number>;
  readonly roundsWon: ReadonlyMap<TeamId, number>;
  readonly playerScores: ReadonlyMap<string, number>;
  readonly objectiveOwners: ReadonlyMap<string, TeamId>;
  livingPlayers(team?: TeamId): PlayerEntity[];
  teamOf(playerId: string): TeamId;
}

/** The outcome a mode reports when something ends. */
export interface EndCondition {
  ended: boolean;
  /** Winning team, or TeamId.None for a draw. */
  winningTeam: TeamId;
  /** For FFA. */
  winningPlayerId: string | null;
  reasonKey: string;
}

export interface ScoreDelta {
  /** Score to add to a team. */
  team?: { team: TeamId; amount: number };
  /** Score to add to individual players. */
  players?: { playerId: string; amount: number }[];
}

export interface GameMode {
  readonly config: GameModeConfig;

  /** Called once when the match is created. */
  onMatchStart(view: MatchView): void;

  /** Called at the start of each round (round-based modes only). */
  onRoundStart(view: MatchView, round: number): void;

  /** Every tick. Return score changes to apply. */
  onTick(view: MatchView, dtMs: number): ScoreDelta | null;

  /** A player was killed. Return the score it earns. */
  onKill(view: MatchView, event: KillEvent): ScoreDelta | null;

  /** Should the current round end? Round-based modes only. */
  checkRoundEnd(view: MatchView): EndCondition;

  /** Should the whole match end? */
  checkMatchEnd(view: MatchView): EndCondition;

  /**
   * May this player respawn right now?
   * Elimination returns false for the duration of a round.
   */
  canRespawn(view: MatchView, player: PlayerEntity): boolean;

  /** Objective state for the HUD, if the mode has objectives. */
  objectiveState(view: MatchView): { id: string; owner: TeamId; progress: number; contested: boolean }[];
}

export const noEnd = (): EndCondition => ({
  ended: false,
  winningTeam: 0 as TeamId,
  winningPlayerId: null,
  reasonKey: '',
});

export const teamWin = (team: TeamId, reasonKey: string): EndCondition => ({
  ended: true,
  winningTeam: team,
  winningPlayerId: null,
  reasonKey,
});

export const playerWin = (playerId: string, reasonKey: string): EndCondition => ({
  ended: true,
  winningTeam: 0 as TeamId,
  winningPlayerId: playerId,
  reasonKey,
});

export const draw = (reasonKey: string): EndCondition => ({
  ended: true,
  winningTeam: 0 as TeamId,
  winningPlayerId: null,
  reasonKey,
});

/** Shared helpers every mode needs. */
export abstract class BaseGameMode implements GameMode {
  constructor(readonly config: GameModeConfig) {}

  onMatchStart(_view: MatchView): void {}
  onRoundStart(_view: MatchView, _round: number): void {}
  onTick(_view: MatchView, _dtMs: number): ScoreDelta | null {
    return null;
  }
  onKill(_view: MatchView, _event: KillEvent): ScoreDelta | null {
    return null;
  }
  checkRoundEnd(_view: MatchView): EndCondition {
    return noEnd();
  }
  canRespawn(_view: MatchView, _player: PlayerEntity): boolean {
    return this.config.respawnEnabled;
  }
  objectiveState(_view: MatchView): { id: string; owner: TeamId; progress: number; contested: boolean }[] {
    return [];
  }

  abstract checkMatchEnd(view: MatchView): EndCondition;

  /** Team with the highest score, or null when tied. */
  protected leadingTeam(view: MatchView): TeamId | null {
    let bestTeam: TeamId | null = null;
    let bestScore = -Infinity;
    let tied = false;
    for (const [team, score] of view.teamScores) {
      if (score > bestScore) {
        bestScore = score;
        bestTeam = team;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    return tied ? null : bestTeam;
  }

  /** Player with the highest score, or null when tied. */
  protected leadingPlayer(view: MatchView): string | null {
    let bestId: string | null = null;
    let bestScore = -Infinity;
    let tied = false;
    for (const [id, score] of view.playerScores) {
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    return tied ? null : bestId;
  }

  /** Has the time limit expired? */
  protected timeExpired(view: MatchView): boolean {
    return this.config.timeLimitSec > 0 && view.elapsedMs >= this.config.timeLimitSec * 1000;
  }
}
