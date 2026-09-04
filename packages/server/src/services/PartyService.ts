/**
 * Parties.
 *
 * A party is a lobby-level grouping that queues as a unit. Leadership transfers
 * automatically when the leader leaves, and a member who disconnects keeps
 * their slot for the reconnect grace window rather than being kicked — dropping
 * someone's friend because their wifi blipped is a bad experience.
 */

import {
  createLogger,
  ErrorCode,
  fail,
  MAX_PARTY_SIZE,
  ok,
  Rng,
  type Result,
} from '@titan/shared';

const log = createLogger('Party');

export interface PartyMember {
  playerId: string;
  displayName: string;
  level: number;
  ready: boolean;
  online: boolean;
  /** When they went offline, for the grace period. */
  offlineSince: number | null;
}

export interface Party {
  id: string;
  code: string;
  leaderId: string;
  members: PartyMember[];
  createdAt: number;
  /** Set while the party is in the matchmaking queue. */
  queuedModeId: string | null;
}

/** Unambiguous alphabet: no O/0, I/1, so codes can be read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class PartyService {
  private readonly parties = new Map<string, Party>();
  private readonly byCode = new Map<string, string>();
  private readonly byPlayer = new Map<string, string>();
  private nextId = 1;
  private rng: Rng;

  constructor(seed = Date.now() >>> 0) {
    this.rng = new Rng(seed);
  }

  private generateCode(): string {
    // Retry on collision rather than assuming uniqueness.
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[this.rng.int(0, CODE_ALPHABET.length - 1)];
      if (!this.byCode.has(code)) return code;
    }
    // Fall back to something guaranteed unique.
    return `P${this.nextId}${this.rng.int(1000, 9999)}`;
  }

  partyOf(playerId: string): Party | null {
    const id = this.byPlayer.get(playerId);
    return id ? this.parties.get(id) ?? null : null;
  }

  get(partyId: string): Party | null {
    return this.parties.get(partyId) ?? null;
  }

  create(playerId: string, displayName: string, level: number, now = Date.now()): Result<Party> {
    const existing = this.partyOf(playerId);
    if (existing) {
      // Already in a party: creating again is a no-op rather than an error, so
      // a double-click can't strand the player.
      return ok(existing);
    }

    const id = `party_${this.nextId++}`;
    const code = this.generateCode();
    const party: Party = {
      id,
      code,
      leaderId: playerId,
      members: [{ playerId, displayName, level, ready: false, online: true, offlineSince: null }],
      createdAt: now,
      queuedModeId: null,
    };

    this.parties.set(id, party);
    this.byCode.set(code, id);
    this.byPlayer.set(playerId, id);
    log.info('party created', { partyId: id, leaderId: playerId });
    return ok(party);
  }

  joinByCode(
    code: string,
    playerId: string,
    displayName: string,
    level: number,
  ): Result<Party> {
    const partyId = this.byCode.get(code.toUpperCase());
    if (!partyId) return fail(ErrorCode.NotFound, `no party with code ${code}`);
    const party = this.parties.get(partyId);
    if (!party) return fail(ErrorCode.NotFound, `party ${partyId} is gone`);

    const already = party.members.find((m) => m.playerId === playerId);
    if (already) {
      already.online = true;
      already.offlineSince = null;
      return ok(party);
    }

    if (party.members.length >= MAX_PARTY_SIZE) {
      return fail(ErrorCode.PartyFull, `party ${partyId} is full`);
    }

    // Leaving the previous party is implicit — a player is only ever in one.
    this.leave(playerId);

    party.members.push({ playerId, displayName, level, ready: false, online: true, offlineSince: null });
    this.byPlayer.set(playerId, party.id);
    log.info('party joined', { partyId: party.id, playerId });
    return ok(party);
  }

  leave(playerId: string): Party | null {
    const party = this.partyOf(playerId);
    if (!party) return null;

    party.members = party.members.filter((m) => m.playerId !== playerId);
    this.byPlayer.delete(playerId);

    if (party.members.length === 0) {
      this.disband(party.id);
      return null;
    }

    if (party.leaderId === playerId) {
      // Promote the longest-standing online member, else the first member.
      const next = party.members.find((m) => m.online) ?? party.members[0]!;
      party.leaderId = next.playerId;
      log.info('party leadership transferred', { partyId: party.id, to: next.playerId });
    }

    return party;
  }

  kick(leaderId: string, targetId: string): Result<Party> {
    const party = this.partyOf(leaderId);
    if (!party) return fail(ErrorCode.NotFound, 'not in a party');
    if (party.leaderId !== leaderId) return fail(ErrorCode.NotPartyLeader, 'only the leader can kick');
    if (targetId === leaderId) return fail(ErrorCode.Validation, 'cannot kick yourself');
    if (!party.members.some((m) => m.playerId === targetId)) {
      return fail(ErrorCode.NotFound, `${targetId} is not in this party`);
    }

    this.leave(targetId);
    const updated = this.parties.get(party.id);
    return updated ? ok(updated) : fail(ErrorCode.NotFound, 'party disbanded');
  }

  setReady(playerId: string, ready: boolean): Result<Party> {
    const party = this.partyOf(playerId);
    if (!party) return fail(ErrorCode.NotFound, 'not in a party');
    const member = party.members.find((m) => m.playerId === playerId);
    if (!member) return fail(ErrorCode.NotFound, 'not a member');
    member.ready = ready;
    return ok(party);
  }

  /** Mark a member offline without removing them, for the reconnect window. */
  setOnline(playerId: string, online: boolean, now = Date.now()): Party | null {
    const party = this.partyOf(playerId);
    if (!party) return null;
    const member = party.members.find((m) => m.playerId === playerId);
    if (!member) return null;
    member.online = online;
    member.offlineSince = online ? null : now;
    if (!online) member.ready = false;
    return party;
  }

  /** Drop members who have been offline past the grace window. */
  pruneOffline(graceMs: number, now = Date.now()): string[] {
    const removed: string[] = [];
    for (const party of Array.from(this.parties.values())) {
      for (const member of party.members.slice()) {
        if (member.online || member.offlineSince === null) continue;
        if (now - member.offlineSince < graceMs) continue;
        this.leave(member.playerId);
        removed.push(member.playerId);
      }
    }
    return removed;
  }

  disband(partyId: string): void {
    const party = this.parties.get(partyId);
    if (!party) return;
    for (const m of party.members) this.byPlayer.delete(m.playerId);
    this.byCode.delete(party.code);
    this.parties.delete(partyId);
    log.info('party disbanded', { partyId });
  }

  /** Everyone who should be pushed a party update. */
  memberIds(partyId: string): string[] {
    return this.parties.get(partyId)?.members.map((m) => m.playerId) ?? [];
  }

  /** True when every online member is ready. */
  allReady(party: Party): boolean {
    const online = party.members.filter((m) => m.online);
    return online.length > 0 && online.every((m) => m.ready);
  }

  setQueued(partyId: string, modeId: string | null): void {
    const party = this.parties.get(partyId);
    if (party) party.queuedModeId = modeId;
  }

  get count(): number {
    return this.parties.size;
  }
}
