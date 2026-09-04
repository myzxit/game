/**
 * Matchmaking.
 *
 * Skill-based, with a search band that widens over time so a queue never
 * deadlocks waiting for a perfect match. Parties queue as a unit and are never
 * split across teams. Once enough players are found, teams are balanced by
 * rating with parties kept intact.
 */

import {
  clamp,
  createLogger,
  ErrorCode,
  fail,
  getGameMode,
  mapsForMode,
  mixSeeds,
  ok,
  rankFromPoints,
  Rng,
  TeamId,
  type GameModeConfig,
  type Result,
} from '@titan/shared';

const log = createLogger('Matchmaking');

export interface QueueTicket {
  /** Party id, or `solo:<playerId>` for an ungrouped player. */
  id: string;
  playerIds: string[];
  modeId: string;
  /** Average skill rating of the group. */
  rating: number;
  preferredMapIds: string[];
  queuedAt: number;
}

export interface MatchProposal {
  modeId: string;
  mapId: string;
  seed: number;
  /** Team assignment; for FFA everyone is TeamId.None. */
  teams: Map<string, TeamId>;
  playerIds: string[];
  tickets: QueueTicket[];
  averageRating: number;
}

export interface QueueStatus {
  inQueue: boolean;
  modeId: string | null;
  queuedMs: number;
  playersFound: number;
  playersNeeded: number;
  estimatedWaitMs: number;
}

/** How far apart two ratings may be, as a function of time in queue. */
function searchBand(queuedMs: number): number {
  // Starts tight (±150) and widens by 100 every 5s, capped so a lonely queue
  // eventually matches anyone rather than never starting.
  return Math.min(150 + Math.floor(queuedMs / 5000) * 100, 5000);
}

export class MatchmakingService {
  private readonly queues = new Map<string, QueueTicket[]>();
  private readonly ticketByPlayer = new Map<string, string>();
  /** Rolling average time-to-match per mode, for the wait estimate. */
  private readonly recentWaits = new Map<string, number[]>();

  constructor(private readonly seedSource = () => Date.now() >>> 0) {}

  /** Rating used for matchmaking. Ranked uses RP; casual uses a softened RP. */
  static ratingFor(rankPoints: number, ranked: boolean): number {
    if (ranked) return rankPoints;
    // In casual, compress the spread so a high-ranked player can still find a
    // game quickly without stomping a lobby of beginners outright.
    return 1000 + (rankPoints - 1000) * 0.45;
  }

  enqueue(ticket: QueueTicket): Result<void> {
    const mode = getGameMode(ticket.modeId);
    if (!mode) return fail(ErrorCode.NotFound, `unknown mode ${ticket.modeId}`);
    if (ticket.playerIds.length === 0) return fail(ErrorCode.Validation, 'empty ticket');
    if (ticket.playerIds.length > mode.teamSize) {
      return fail(ErrorCode.Validation, `party larger than a team in ${mode.id}`);
    }

    for (const playerId of ticket.playerIds) {
      const existing = this.ticketByPlayer.get(playerId);
      if (existing) this.dequeueTicket(existing);
    }

    const queue = this.queues.get(ticket.modeId) ?? [];
    queue.push(ticket);
    this.queues.set(ticket.modeId, queue);
    for (const playerId of ticket.playerIds) this.ticketByPlayer.set(playerId, ticket.id);

    log.info('queued', { ticketId: ticket.id, mode: ticket.modeId, size: ticket.playerIds.length });
    return ok(undefined);
  }

  dequeuePlayer(playerId: string): void {
    const ticketId = this.ticketByPlayer.get(playerId);
    if (ticketId) this.dequeueTicket(ticketId);
  }

  dequeueTicket(ticketId: string): void {
    for (const [modeId, queue] of this.queues) {
      const index = queue.findIndex((t) => t.id === ticketId);
      if (index < 0) continue;
      const [ticket] = queue.splice(index, 1);
      if (ticket) for (const p of ticket.playerIds) this.ticketByPlayer.delete(p);
      if (queue.length === 0) this.queues.delete(modeId);
      return;
    }
  }

  status(playerId: string, now = Date.now()): QueueStatus {
    const ticketId = this.ticketByPlayer.get(playerId);
    if (!ticketId) {
      return {
        inQueue: false,
        modeId: null,
        queuedMs: 0,
        playersFound: 0,
        playersNeeded: 0,
        estimatedWaitMs: 0,
      };
    }

    for (const [modeId, queue] of this.queues) {
      const ticket = queue.find((t) => t.id === ticketId);
      if (!ticket) continue;
      const mode = getGameMode(modeId)!;
      const queuedMs = now - ticket.queuedAt;
      const compatible = this.compatibleTickets(queue, ticket, queuedMs, now);
      const found = compatible.reduce((a, t) => a + t.playerIds.length, 0);
      return {
        inQueue: true,
        modeId,
        queuedMs,
        playersFound: found,
        playersNeeded: mode.minPlayers,
        estimatedWaitMs: this.estimateWait(modeId),
      };
    }

    return {
      inQueue: false,
      modeId: null,
      queuedMs: 0,
      playersFound: 0,
      playersNeeded: 0,
      estimatedWaitMs: 0,
    };
  }

  private compatibleTickets(
    queue: QueueTicket[],
    anchor: QueueTicket,
    anchorQueuedMs: number,
    now: number,
  ): QueueTicket[] {
    return queue.filter((t) => {
      if (t.id === anchor.id) return true;
      // Use the *wider* of the two bands, so a long-waiting player pulls in
      // fresh arrivals rather than both sides waiting on each other.
      const band = Math.max(searchBand(anchorQueuedMs), searchBand(now - t.queuedAt));
      return Math.abs(t.rating - anchor.rating) <= band;
    });
  }

  /**
   * Try to form matches. Called on a timer by the server.
   * Returns every proposal that could be formed this pass.
   */
  tick(now = Date.now()): MatchProposal[] {
    const proposals: MatchProposal[] = [];

    for (const [modeId, queue] of Array.from(this.queues.entries())) {
      const mode = getGameMode(modeId);
      if (!mode) continue;

      // Oldest first, so nobody starves.
      queue.sort((a, b) => a.queuedAt - b.queuedAt);

      let progress = true;
      while (progress) {
        progress = false;
        const anchor = queue[0];
        if (!anchor) break;

        const pool = this.compatibleTickets(queue, anchor, now - anchor.queuedAt, now);
        const selected = this.selectTickets(pool, mode);
        if (!selected) break;

        const proposal = this.buildProposal(selected, mode, now);
        proposals.push(proposal);

        for (const t of selected) this.dequeueTicket(t.id);
        this.recordWait(modeId, now - anchor.queuedAt);
        progress = true;
      }
    }

    return proposals;
  }

  /**
   * Greedily pick tickets until the lobby is big enough.
   * Returns null when there aren't enough players yet.
   */
  private selectTickets(pool: QueueTicket[], mode: GameModeConfig): QueueTicket[] | null {
    const sorted = [...pool].sort((a, b) => a.queuedAt - b.queuedAt);
    const chosen: QueueTicket[] = [];
    let count = 0;

    for (const ticket of sorted) {
      if (count + ticket.playerIds.length > mode.maxPlayers) continue;
      chosen.push(ticket);
      count += ticket.playerIds.length;
      if (count >= mode.maxPlayers) break;
    }

    if (count < mode.minPlayers) return null;

    // Team modes need an even split; drop the newest ticket until it works.
    if (mode.teamBased) {
      while (chosen.length > 0 && count % 2 !== 0) {
        const removed = chosen.pop()!;
        count -= removed.playerIds.length;
      }
      if (count < mode.minPlayers) return null;
    }

    return chosen;
  }

  /** Assign teams, balancing by rating while keeping parties together. */
  private buildProposal(
    tickets: QueueTicket[],
    mode: GameModeConfig,
    now: number,
  ): MatchProposal {
    const teams = new Map<string, TeamId>();
    const playerIds = tickets.flatMap((t) => t.playerIds);
    const totalRating = tickets.reduce((a, t) => a + t.rating * t.playerIds.length, 0);
    const averageRating = playerIds.length > 0 ? totalRating / playerIds.length : 0;

    if (!mode.teamBased) {
      for (const id of playerIds) teams.set(id, TeamId.None);
    } else {
      // Largest-first greedy assignment: place each party on whichever team is
      // currently weaker, which keeps both size and rating close.
      const ordered = [...tickets].sort(
        (a, b) => b.playerIds.length - a.playerIds.length || b.rating - a.rating,
      );
      let alphaCount = 0;
      let bravoCount = 0;
      let alphaRating = 0;
      let bravoRating = 0;
      const half = Math.ceil(playerIds.length / 2);

      for (const ticket of ordered) {
        const size = ticket.playerIds.length;
        const alphaFull = alphaCount + size > half;
        const bravoFull = bravoCount + size > half;

        let team: TeamId;
        if (alphaFull && !bravoFull) team = TeamId.Bravo;
        else if (bravoFull && !alphaFull) team = TeamId.Alpha;
        else team = alphaRating <= bravoRating ? TeamId.Alpha : TeamId.Bravo;

        for (const p of ticket.playerIds) teams.set(p, team);
        if (team === TeamId.Alpha) {
          alphaCount += size;
          alphaRating += ticket.rating * size;
        } else {
          bravoCount += size;
          bravoRating += ticket.rating * size;
        }
      }
    }

    // Map choice: prefer something the lobby asked for, else any legal map.
    const legal = mapsForMode(mode.id).filter(
      (m) => mode.mapPool.length === 0 || mode.mapPool.includes(m.id),
    );
    const preferred = legal.filter((m) =>
      tickets.some((t) => t.preferredMapIds.includes(m.id)),
    );
    const candidates = preferred.length > 0 ? preferred : legal;

    const seed = mixSeeds(this.seedSource(), now >>> 0, playerIds.length);
    const rng = new Rng(seed);
    const mapId = candidates.length > 0 ? rng.pick(candidates).id : 'foundry_reach';

    log.info('match formed', {
      mode: mode.id,
      mapId,
      players: playerIds.length,
      averageRating: Math.round(averageRating),
    });

    return { modeId: mode.id, mapId, seed, teams, playerIds, tickets, averageRating };
  }

  private recordWait(modeId: string, waitMs: number): void {
    const waits = this.recentWaits.get(modeId) ?? [];
    waits.push(waitMs);
    if (waits.length > 20) waits.shift();
    this.recentWaits.set(modeId, waits);
  }

  private estimateWait(modeId: string): number {
    const waits = this.recentWaits.get(modeId);
    if (!waits || waits.length === 0) return 30_000;
    return Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);
  }

  /** How many players are waiting, per mode. Shown on the mode-select screen. */
  queueSizes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [modeId, queue] of this.queues) {
      out[modeId] = queue.reduce((a, t) => a + t.playerIds.length, 0);
    }
    return out;
  }

  get totalQueued(): number {
    return this.ticketByPlayer.size;
  }

  static ratingFromProfile(rankPoints: number, ranked: boolean): number {
    return MatchmakingService.ratingFor(rankPoints, ranked);
  }

  /** Human-readable tier for the queue UI. */
  static tierLabel(rankPoints: number): string {
    return rankFromPoints(rankPoints).tier.nameKey;
  }
}

export { clamp };
