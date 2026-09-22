/**
 * Objective — capture and hold points to accumulate score.
 *
 * Capture rules, chosen so holding is active rather than passive:
 *  - a point captures only when exactly one team has players inside it,
 *  - more attackers capture faster, with diminishing returns,
 *  - a contested point freezes rather than reverting, so a defender arriving
 *    late can stall without instantly undoing the attackers' work,
 *  - an owned, uncontested point ticks score for its owner.
 */

import {
  TeamId,
  requireMap,
  clamp,
  type KillEvent,
  type MapDefinition,
  type ObjectivePoint,
} from '@titan/shared';
import {
  BaseGameMode,
  draw,
  noEnd,
  teamWin,
  type EndCondition,
  type MatchView,
  type ScoreDelta,
} from './GameMode.js';

interface PointState {
  point: ObjectivePoint;
  owner: TeamId;
  /** -1..1: negative is Alpha progress, positive is Bravo. Sign is the team. */
  progress: number;
  contested: boolean;
  /** Accumulated fractional score, flushed to whole points. */
  scoreCarry: number;
}

export class ObjectiveMode extends BaseGameMode {
  private readonly points = new Map<string, PointState>();
  private map: MapDefinition | null = null;

  override onMatchStart(view: MatchView): void {
    this.map = requireMap(view.mapId);
    this.points.clear();
    for (const point of this.map.objectives) {
      this.points.set(point.id, { point, owner: TeamId.None, progress: 0, contested: false, scoreCarry: 0 });
    }
  }

  override onRoundStart(view: MatchView): void {
    this.onMatchStart(view);
  }

  override onTick(view: MatchView, dtMs: number): ScoreDelta | null {
    if (!this.map) return null;
    const dt = dtMs / 1000;
    const captureRate = 1 / Math.max(1, this.config.captureTimeSec);

    let alphaScore = 0;
    let bravoScore = 0;
    const playerCredit: { playerId: string; amount: number }[] = [];

    for (const state of this.points.values()) {
      const inside = { [TeamId.Alpha]: [] as string[], [TeamId.Bravo]: [] as string[] };

      for (const player of view.livingPlayers()) {
        if (!this.isInside(player.position, state.point)) continue;
        const team = player.team;
        if (team === TeamId.Alpha) inside[TeamId.Alpha].push(player.id);
        else if (team === TeamId.Bravo) inside[TeamId.Bravo].push(player.id);
      }

      const alphaCount = inside[TeamId.Alpha].length;
      const bravoCount = inside[TeamId.Bravo].length;
      state.contested = alphaCount > 0 && bravoCount > 0;

      if (state.contested) {
        // Frozen: neither side progresses while the point is fought over.
      } else if (alphaCount > 0) {
        // Diminishing returns: the second body helps a lot, the fourth barely.
        const speed = captureRate * (1 + Math.log2(alphaCount)) * dt;
        state.progress = clamp(state.progress - speed, -1, 1);
        if (state.progress <= -1) state.owner = TeamId.Alpha;
      } else if (bravoCount > 0) {
        const speed = captureRate * (1 + Math.log2(bravoCount)) * dt;
        state.progress = clamp(state.progress + speed, -1, 1);
        if (state.progress >= 1) state.owner = TeamId.Bravo;
      } else {
        // Empty points decay slowly back toward neutral, so a point taken and
        // abandoned does not stay locked in forever.
        const decay = captureRate * 0.25 * dt;
        if (state.owner === TeamId.None) {
          state.progress = state.progress > 0
            ? Math.max(0, state.progress - decay)
            : Math.min(0, state.progress + decay);
        }
      }

      // Owned and uncontested: tick score.
      if (state.owner !== TeamId.None && !state.contested) {
        state.scoreCarry += this.config.captureTickPoints * dt;
        const whole = Math.floor(state.scoreCarry);
        if (whole > 0) {
          state.scoreCarry -= whole;
          if (state.owner === TeamId.Alpha) alphaScore += whole;
          else bravoScore += whole;

          // Credit players standing on the point they own.
          for (const playerId of inside[state.owner]) {
            playerCredit.push({ playerId, amount: whole });
          }
        }
      }
    }

    if (alphaScore === 0 && bravoScore === 0 && playerCredit.length === 0) return null;

    // Only one team delta per tick is supported by the interface, so emit the
    // larger and fold the other into the next tick via the carry.
    const delta: ScoreDelta = { players: playerCredit };
    if (alphaScore > 0) delta.team = { team: TeamId.Alpha, amount: alphaScore };
    if (bravoScore > 0) {
      if (delta.team) {
        // Both scored this tick: apply Alpha now, defer Bravo by one tick.
        const state = this.points.values().next().value as PointState | undefined;
        if (state) state.scoreCarry += bravoScore;
      } else {
        delta.team = { team: TeamId.Bravo, amount: bravoScore };
      }
    }
    return delta;
  }

  override onKill(view: MatchView, event: KillEvent): ScoreDelta | null {
    if (!event.killerId) return null;
    const killerTeam = view.teamOf(event.killerId);
    const victimTeam = view.teamOf(event.victimId);
    if (killerTeam === victimTeam) return null;

    // Kills are worth much less than objectives here — the mode is about the
    // points, and rewarding kills equally would turn it into deathmatch.
    return {
      team: { team: killerTeam, amount: 1 },
      players: [{ playerId: event.killerId, amount: 1 }],
    };
  }

  private isInside(position: { x: number; y: number; z: number }, point: ObjectivePoint): boolean {
    const dx = position.x - point.at.x;
    const dz = position.z - point.at.z;
    if (dx * dx + dz * dz > point.radius * point.radius) return false;
    return position.y >= point.at.y - 2 && position.y <= point.at.y + point.height;
  }

  override objectiveState(_view: MatchView) {
    return Array.from(this.points.values()).map((s) => ({
      id: s.point.id,
      owner: s.owner,
      progress: Math.abs(s.progress),
      contested: s.contested,
    }));
  }

  checkMatchEnd(view: MatchView): EndCondition {
    for (const [team, score] of view.teamScores) {
      if (score >= this.config.scoreLimit) return teamWin(team, 'match.victory');
    }
    if (this.timeExpired(view)) {
      const leader = this.leadingTeam(view);
      return leader === null ? draw('match.draw') : teamWin(leader, 'match.victory');
    }
    return noEnd();
  }
}
