/**
 * Sessions and reconnection.
 *
 * A session token identifies a returning player. When a socket drops we keep
 * the session (and their match slot) alive for RECONNECT_GRACE_MS, so a brief
 * network blip does not cost the player their match, their streak or their
 * end-of-match rewards.
 *
 * Tokens are random 256-bit values from the platform CSPRNG. They are bearer
 * credentials, so they are never logged and never sent to anyone but their
 * owner.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RECONNECT_GRACE_MS, createLogger } from '@titan/shared';

const log = createLogger('Sessions');

export interface Session {
  playerId: string;
  token: string;
  displayName: string;
  createdAt: number;
  lastSeenAt: number;
  /** Set while the socket is gone but the session is still resumable. */
  disconnectedAt: number | null;
  /** Match the player was in, so a reconnect can put them back. */
  matchId: string | null;
  locale: string;
}

export class SessionRegistry {
  private readonly byToken = new Map<string, Session>();
  private readonly byPlayer = new Map<string, Session>();
  private nextPlayerNumber = 1;

  /** Create a session for a brand-new player. */
  create(displayName: string, locale: string, now = Date.now()): Session {
    const playerId = `p${this.nextPlayerNumber++}_${randomBytes(4).toString('hex')}`;
    const session: Session = {
      playerId,
      token: randomBytes(32).toString('base64url'),
      displayName,
      createdAt: now,
      lastSeenAt: now,
      disconnectedAt: null,
      matchId: null,
      locale,
    };
    this.byToken.set(session.token, session);
    this.byPlayer.set(playerId, session);
    log.info('session created', { playerId });
    return session;
  }

  /**
   * Resume a session from a token.
   * Returns null for an unknown or expired token; the caller then creates a
   * fresh session rather than failing the connection.
   */
  resume(token: string, now = Date.now()): Session | null {
    const session = this.lookup(token);
    if (!session) return null;

    if (session.disconnectedAt !== null && now - session.disconnectedAt > RECONNECT_GRACE_MS) {
      // Expired. Drop it so a stale token can't be replayed later.
      this.destroy(session.playerId);
      return null;
    }

    session.disconnectedAt = null;
    session.lastSeenAt = now;
    log.info('session resumed', { playerId: session.playerId, matchId: session.matchId });
    return session;
  }

  /**
   * Constant-time token lookup.
   *
   * A plain map lookup leaks timing information about how much of a guessed
   * token matched. With 256 bits of entropy that is not a practical attack, but
   * comparing in constant time costs nothing here and removes the question.
   */
  private lookup(token: string): Session | null {
    const candidate = this.byToken.get(token);
    if (!candidate) return null;
    const a = Buffer.from(token);
    const b = Buffer.from(candidate.token);
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? candidate : null;
  }

  get(playerId: string): Session | null {
    return this.byPlayer.get(playerId) ?? null;
  }

  /** Mark the socket gone; the session stays resumable for the grace window. */
  disconnect(playerId: string, now = Date.now()): Session | null {
    const session = this.byPlayer.get(playerId);
    if (!session) return null;
    session.disconnectedAt = now;
    session.lastSeenAt = now;
    return session;
  }

  setMatch(playerId: string, matchId: string | null): void {
    const session = this.byPlayer.get(playerId);
    if (session) session.matchId = matchId;
  }

  destroy(playerId: string): void {
    const session = this.byPlayer.get(playerId);
    if (!session) return;
    this.byToken.delete(session.token);
    this.byPlayer.delete(playerId);
  }

  /** Drop sessions whose grace period has expired. */
  prune(now = Date.now()): string[] {
    const expired: string[] = [];
    for (const session of Array.from(this.byPlayer.values())) {
      if (session.disconnectedAt === null) continue;
      if (now - session.disconnectedAt <= RECONNECT_GRACE_MS) continue;
      expired.push(session.playerId);
      this.destroy(session.playerId);
    }
    if (expired.length > 0) log.info('sessions expired', { count: expired.length });
    return expired;
  }

  get activeCount(): number {
    return Array.from(this.byPlayer.values()).filter((s) => s.disconnectedAt === null).length;
  }

  get totalCount(): number {
    return this.byPlayer.size;
  }
}
