/**
 * One client connection.
 *
 * Owns the socket, the per-connection rate limiter, and the mapping to a
 * session. Every inbound frame passes through: size check -> bandwidth check ->
 * JSON decode -> schema validation -> rate limit -> handler. A failure at any
 * stage is recorded and the frame is dropped; only a repeated or clearly
 * malicious failure closes the connection.
 */

import type { WebSocket } from 'ws';
import {
  ClientMessageType,
  ErrorCode,
  MAX_PACKET_BYTES,
  ServerMessageType,
  createLogger,
  decode,
  encode,
  validateClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '@titan/shared';
import { ConnectionRateLimiter } from '../anticheat/RateLimiter.js';
import type { Session } from './SessionRegistry.js';

const log = createLogger('Connection');

export type MessageHandler = (connection: Connection, message: ClientMessage) => void;

export class Connection {
  /** Set once the handshake completes. */
  session: Session | null = null;

  readonly limiter = new ConnectionRateLimiter();
  readonly connectedAt = Date.now();

  /** Latest measured round-trip time. */
  roundTripMs = 60;
  lastHeartbeatAt = Date.now();

  /** Consecutive protocol failures; a run of these closes the connection. */
  private protocolFailures = 0;
  private closed = false;

  /** Bytes sent/received, for the server status report. */
  bytesSent = 0;
  bytesReceived = 0;

  constructor(
    readonly id: string,
    private readonly socket: WebSocket,
    private readonly handler: MessageHandler,
    private readonly onProtocolViolation: (connection: Connection, detail: string, suspicious: boolean) => void,
  ) {
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => this.onMessage(data));
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', (error: Error) => {
      // A socket error is normal (a client closed a laptop lid); log at debug.
      log.debug('socket error', { connectionId: this.id, error: error.message });
      this.closed = true;
    });
  }

  get playerId(): string | null {
    return this.session?.playerId ?? null;
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN;
  }

  get isAuthenticated(): boolean {
    return this.session !== null;
  }

  private onMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
    if (this.closed) return;

    const raw = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as Buffer).toString('utf8');

    this.bytesReceived += raw.length;

    if (raw.length > MAX_PACKET_BYTES) {
      this.fail('packet too large', true);
      return;
    }
    if (!this.limiter.allowBytes(raw.length)) {
      this.fail('bandwidth limit exceeded', true);
      return;
    }

    const decoded = decode(raw);
    if (decoded === null) {
      this.fail('malformed JSON', true);
      return;
    }

    const validated = validateClientMessage(decoded);
    if (!validated.ok) {
      this.fail(validated.reason, validated.suspicious);
      // Tell the client *why*, so a legitimate version mismatch is actionable
      // rather than a silent disconnect.
      if (validated.reason.startsWith('protocol mismatch')) {
        this.sendError(ErrorCode.Validation, 'error.protocol_mismatch', true);
      }
      return;
    }

    const message = validated.value;

    // Everything except the handshake requires an authenticated session.
    if (!this.isAuthenticated && message.type !== ClientMessageType.Handshake) {
      this.fail('message before handshake', true);
      return;
    }

    if (!this.limiter.allow(message.type)) {
      // Rate limiting is not a protocol violation — a laggy client can burst —
      // so this drops the message and tells the client, without a strike.
      this.sendError(ErrorCode.RateLimited, 'error.rate_limited', false, message.type);
      return;
    }

    this.protocolFailures = 0;
    this.lastHeartbeatAt = Date.now();

    try {
      this.handler(this, message);
    } catch (error) {
      // A handler bug must never take down the server or the connection.
      log.error('handler threw', {
        connectionId: this.id,
        playerId: this.playerId,
        type: message.type,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.sendError(ErrorCode.Unknown, 'error.unknown', false, message.type);
    }
  }

  private fail(detail: string, suspicious: boolean): void {
    this.protocolFailures++;
    this.onProtocolViolation(this, detail, suspicious);

    // A burst of malformed frames is either a broken client or an attack;
    // either way there is nothing useful to do but disconnect.
    if (this.protocolFailures >= 10) {
      log.warn('closing connection after repeated protocol failures', {
        connectionId: this.id,
        playerId: this.playerId,
        detail,
      });
      this.close(1008, 'protocol');
    }
  }

  send(message: ServerMessage): void {
    if (!this.isOpen) return;
    try {
      const payload = encode(message);
      this.bytesSent += payload.length;
      this.socket.send(payload);
    } catch (error) {
      log.debug('send failed', {
        connectionId: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  sendError(code: ErrorCode, messageKey: string, fatal: boolean, inResponseTo?: string): void {
    this.send({
      type: ServerMessageType.Error,
      code,
      messageKey,
      fatal,
      inResponseTo,
    });
    if (fatal) this.close(1008, code);
  }

  close(code = 1000, reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      // Already gone; nothing to do.
    }
  }

  /** Has this connection gone quiet for longer than the timeout? */
  isStale(now: number, timeoutMs: number): boolean {
    return now - this.lastHeartbeatAt > timeoutMs;
  }
}
