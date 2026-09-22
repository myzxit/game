/**
 * Leaderboards.
 *
 * Kept in memory and rebuilt from the profile store on startup, then updated
 * incrementally as matches end. Boards are capped so a large player base
 * doesn't grow unboundedly in RAM; a player outside the top N still sees their
 * own position, which is computed separately.
 */

import { createLogger, rankFromPoints } from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { ProfileStore } from '../data/ProfileStore.js';

const log = createLogger('Leaderboard');

export type BoardId = 'rank' | 'kills' | 'wins' | 'score';

export interface BoardEntry {
  playerId: string;
  displayName: string;
  value: number;
  tierId?: string;
}

const BOARD_LIMIT = 500;

export class LeaderboardService {
  private readonly boards = new Map<BoardId, BoardEntry[]>();
  /** Every known player's values, so a rank can be computed outside the top N. */
  private readonly values = new Map<string, Record<BoardId, number>>();
  private readonly names = new Map<string, string>();

  constructor(private readonly store: ProfileStore) {
    for (const id of ['rank', 'kills', 'wins', 'score'] as BoardId[]) {
      this.boards.set(id, []);
    }
  }

  /** Load every stored profile once at startup. */
  async rebuild(): Promise<void> {
    const ids = await this.store.list();
    let loaded = 0;
    for (const id of ids) {
      const result = await this.store.load(id);
      if (!result.ok || !result.value) continue;
      this.upsert(result.value);
      loaded++;
    }
    log.info('leaderboards rebuilt', { profiles: loaded });
  }

  /** Record or refresh a player's entries. */
  upsert(profile: PlayerProfile): void {
    this.names.set(profile.id, profile.displayName);
    this.values.set(profile.id, {
      rank: profile.rankPoints,
      kills: profile.stats.kills,
      wins: profile.stats.wins,
      score: profile.stats.bestScore,
    });

    for (const board of this.boards.keys()) this.reinsert(board, profile.id);
  }

  private reinsert(board: BoardId, playerId: string): void {
    const list = this.boards.get(board)!;
    const value = this.values.get(playerId)?.[board] ?? 0;
    const displayName = this.names.get(playerId) ?? 'Operator';

    const existing = list.findIndex((e) => e.playerId === playerId);
    if (existing >= 0) list.splice(existing, 1);

    const entry: BoardEntry = {
      playerId,
      displayName,
      value,
      tierId: board === 'rank' ? rankFromPoints(value).tier.id : undefined,
    };

    // Binary-search the insertion point rather than re-sorting the whole board.
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid]!.value >= value) low = mid + 1;
      else high = mid;
    }
    list.splice(low, 0, entry);

    if (list.length > BOARD_LIMIT) list.length = BOARD_LIMIT;
  }

  top(board: BoardId, limit = 100): (BoardEntry & { rank: number })[] {
    const list = this.boards.get(board) ?? [];
    return list.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));
  }

  /**
   * A player's position. Players outside the retained board get a position
   * derived from how many known players beat them, which is exact for everyone
   * we've seen and a floor for the rest.
   */
  positionOf(board: BoardId, playerId: string): { rank: number; value: number } | null {
    const value = this.values.get(playerId)?.[board];
    if (value === undefined) return null;

    const list = this.boards.get(board) ?? [];
    const index = list.findIndex((e) => e.playerId === playerId);
    if (index >= 0) return { rank: index + 1, value };

    let better = 0;
    for (const v of this.values.values()) if (v[board] > value) better++;
    return { rank: better + 1, value };
  }

  get trackedPlayers(): number {
    return this.values.size;
  }
}
