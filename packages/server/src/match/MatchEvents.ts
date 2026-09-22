/**
 * Match event recording.
 *
 * Every significant occurrence is appended to an ordered, timestamped log. The
 * log is not a replay system, but it is the data a replay system needs: given
 * the map id, the match seed and this event stream, a match can be
 * reconstructed. Recording it now costs almost nothing and means the feature
 * can be added later without a protocol change.
 *
 * It is also what analytics and post-match reports read, so there is exactly
 * one source of truth for "what happened".
 */

import { RingBuffer, type HitZone, type TeamId, type Vec3 } from '@titan/shared';

export enum MatchEventType {
  MatchStart = 'match_start',
  RoundStart = 'round_start',
  PlayerJoin = 'player_join',
  PlayerLeave = 'player_leave',
  Spawn = 'spawn',
  Shot = 'shot',
  Hit = 'hit',
  Kill = 'kill',
  Death = 'death',
  SkillUsed = 'skill_used',
  ObjectiveCapture = 'objective_capture',
  VehicleEnter = 'vehicle_enter',
  VehicleDestroy = 'vehicle_destroy',
  GlassBreak = 'glass_break',
  SecretFound = 'secret_found',
  RoundEnd = 'round_end',
  MatchEnd = 'match_end',
}

interface BaseEvent {
  type: MatchEventType;
  /** Milliseconds since match start. */
  at: number;
  tick: number;
}

export type MatchEvent = BaseEvent &
  (
    | { type: MatchEventType.MatchStart; mapId: string; modeId: string; seed: number }
    | { type: MatchEventType.RoundStart; round: number }
    | { type: MatchEventType.PlayerJoin; playerId: string; displayName: string; team: TeamId }
    | { type: MatchEventType.PlayerLeave; playerId: string; reason: string }
    | { type: MatchEventType.Spawn; playerId: string; position: Vec3 }
    | {
        type: MatchEventType.Shot;
        playerId: string;
        weaponId: string;
        origin: Vec3;
        direction: Vec3;
        seed: number;
        pellets: number;
      }
    | {
        type: MatchEventType.Hit;
        attackerId: string;
        victimId: string;
        damage: number;
        zone: HitZone;
        weaponId: string;
        distance: number;
      }
    | {
        type: MatchEventType.Kill;
        killerId: string | null;
        victimId: string;
        weaponId: string | null;
        zone: HitZone;
        distance: number;
        assistIds: string[];
        streak: number;
        multiKill: number;
      }
    | { type: MatchEventType.Death; playerId: string; cause: string }
    | { type: MatchEventType.SkillUsed; playerId: string; skillId: string; position: Vec3 }
    | { type: MatchEventType.ObjectiveCapture; objectiveId: string; team: TeamId }
    | { type: MatchEventType.VehicleEnter; playerId: string; vehicleId: number }
    | { type: MatchEventType.VehicleDestroy; vehicleId: number; killerId: string | null }
    | { type: MatchEventType.GlassBreak; brushId: number; position: Vec3 }
    | { type: MatchEventType.SecretFound; playerId: string; secretId: string }
    | { type: MatchEventType.RoundEnd; round: number; winningTeam: TeamId }
    | {
        type: MatchEventType.MatchEnd;
        winningTeam: TeamId;
        winningPlayerId: string | null;
        durationMs: number;
      }
  );

/**
 * Bounded recorder. A long match generates thousands of events; the cap keeps
 * memory predictable and drops the oldest, which are the least interesting for
 * a post-match report.
 */
export class MatchRecorder {
  private readonly events: RingBuffer<MatchEvent>;
  private count = 0;

  constructor(capacity = 20_000) {
    this.events = new RingBuffer<MatchEvent>(capacity);
  }

  record(event: MatchEvent): void {
    this.events.push(event);
    this.count++;
  }

  all(): MatchEvent[] {
    return this.events.toArray();
  }

  /** Events of one type — used by the post-match summary. */
  ofType<T extends MatchEventType>(type: T): Extract<MatchEvent, { type: T }>[] {
    return this.events.toArray().filter((e): e is Extract<MatchEvent, { type: T }> => e.type === type);
  }

  /** Every event involving a player, for a personal match report. */
  forPlayer(playerId: string): MatchEvent[] {
    return this.events.toArray().filter((e) => {
      const record = e as unknown as Record<string, unknown>;
      return (
        record.playerId === playerId ||
        record.attackerId === playerId ||
        record.victimId === playerId ||
        record.killerId === playerId
      );
    });
  }

  /** Total events recorded, including any dropped by the cap. */
  get totalRecorded(): number {
    return this.count;
  }

  get retained(): number {
    return this.events.length;
  }

  /**
   * Serialize for storage. The shape is deliberately plain JSON so a replay
   * viewer never needs to import server code.
   */
  serialize(header: { matchId: string; mapId: string; modeId: string; seed: number }): string {
    return JSON.stringify({ version: 1, ...header, events: this.all() });
  }
}
