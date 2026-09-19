/**
 * Network client.
 *
 * Owns the socket, the handshake, ping measurement and reconnection. The
 * reconnect path is the important part: the session token is kept so a dropped
 * connection resumes the same player — and, if the drop was brief, the same
 * match — rather than dumping the player back to the menu having lost their
 * progress.
 */

import {
  CONNECTION_TIMEOUT_MS,
  ClientMessageType,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  ServerMessageType,
  clamp,
  createLogger,
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@titan/shared';

const log = createLogger('Net');

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface NetClientEvents {
  onMessage: (message: ServerMessage) => void;
  onStateChange: (state: ConnectionState, detail?: { attempt: number; max: number }) => void;
  onFatal: (messageKey: string) => void;
}

const STORAGE_KEY = 'titan.session.v1';
const MAX_RECONNECT_ATTEMPTS = 6;

export class NetClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';

  private sessionToken: string | null = null;
  private displayName = 'Operator';
  private locale = 'ko';

  playerId: string | null = null;
  /** Server time minus client time, so the client can place server events. */
  serverTimeOffset = 0;
  roundTripMs = 60;

  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastMessageAt = 0;
  /** Outgoing messages buffered while the socket is down. */
  private readonly outbox: ClientMessage[] = [];

  private readonly pingSamples: number[] = [];

  bytesSent = 0;
  bytesReceived = 0;

  constructor(
    private readonly url: string,
    private readonly events: NetClientEvents,
  ) {
    this.sessionToken = this.loadToken();
  }

  private loadToken(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private saveToken(token: string): void {
    this.sessionToken = token;
    try {
      localStorage.setItem(STORAGE_KEY, token);
    } catch {
      // Storage unavailable: the session simply won't survive a page reload.
    }
  }

  /** Forget the session — used by an explicit sign-out. */
  clearSession(): void {
    this.sessionToken = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do.
    }
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get hasStoredSession(): boolean {
    return this.sessionToken !== null;
  }

  private setState(state: ConnectionState, detail?: { attempt: number; max: number }): void {
    if (this.state === state && !detail) return;
    this.state = state;
    this.events.onStateChange(state, detail);
  }

  connect(displayName: string, locale: string): void {
    this.displayName = displayName;
    this.locale = locale;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
    }

    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', {
      attempt: this.reconnectAttempt,
      max: MAX_RECONNECT_ATTEMPTS,
    });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      log.error('could not open socket', { error: String(error) });
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      log.info('socket open', { url: this.url });
      this.setState('handshaking');
      this.lastMessageAt = performance.now();
      this.send({
        type: ClientMessageType.Handshake,
        protocolVersion: PROTOCOL_VERSION,
        displayName: this.displayName,
        sessionToken: this.sessionToken,
        locale: this.locale,
      });
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      this.lastMessageAt = performance.now();
      this.bytesReceived += event.data.length;

      const decoded = decode(event.data);
      if (decoded === null) {
        log.warn('dropped malformed message from server');
        return;
      }
      this.handle(decoded as ServerMessage);
    };

    socket.onerror = () => {
      // The close handler does the real work; onerror carries no detail.
      log.debug('socket error');
    };

    socket.onclose = (event) => {
      log.info('socket closed', { code: event.code, reason: event.reason });
      this.stopHeartbeat();
      // 1000 is a clean close (we asked for it, or the server is shutting
      // down); anything else is worth retrying.
      if (event.code === 1000 && event.reason === 'client') {
        this.setState('idle');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case ServerMessageType.HandshakeAck: {
        this.playerId = message.playerId;
        this.saveToken(message.sessionToken);
        this.serverTimeOffset = message.serverTimeMs - Date.now();
        this.reconnectAttempt = 0;
        this.setState('connected');
        this.startHeartbeat();
        this.flushOutbox();
        log.info('handshake complete', {
          playerId: message.playerId,
          resumed: message.resumed,
          match: message.activeMatchId,
        });
        break;
      }

      case ServerMessageType.Pong: {
        const rtt = performance.now() - message.clientTimeMs;
        this.pingSamples.push(rtt);
        if (this.pingSamples.length > 12) this.pingSamples.shift();
        // Use the median rather than the mean: one delayed packet should not
        // move the estimate that lag compensation depends on.
        const sorted = [...this.pingSamples].sort((a, b) => a - b);
        this.roundTripMs = clamp(sorted[Math.floor(sorted.length / 2)] ?? rtt, 0, 1000);
        // Re-estimate the clock offset, assuming symmetric latency.
        this.serverTimeOffset = message.serverTimeMs + this.roundTripMs / 2 - Date.now();
        break;
      }

      case ServerMessageType.Error: {
        if (message.fatal) {
          log.error('fatal server error', { code: message.code, key: message.messageKey });
          this.events.onFatal(message.messageKey);
          // A protocol mismatch will fail again identically, so don't retry.
          this.reconnectAttempt = MAX_RECONNECT_ATTEMPTS;
        }
        break;
      }

      default:
        break;
    }

    this.events.onMessage(message);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;

    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.setState('failed');
      log.error('giving up on reconnection');
      return;
    }

    this.reconnectAttempt++;
    // Exponential backoff with jitter, so a server restart doesn't get a
    // synchronised stampede from every client at once.
    const base = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 15000);
    const delay = base + Math.random() * 400;

    this.setState('reconnecting', { attempt: this.reconnectAttempt, max: MAX_RECONNECT_ATTEMPTS });
    log.info('reconnecting', { attempt: this.reconnectAttempt, delayMs: Math.round(delay) });

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /** Manual retry, from the reconnect UI. */
  retry(): void {
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.openSocket();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.isConnected) return;

      this.send({ type: ClientMessageType.Ping, clientTimeMs: performance.now() });

      // If the server has gone quiet for longer than the timeout, the socket is
      // dead even though the browser has not noticed yet.
      if (performance.now() - this.lastMessageAt > CONNECTION_TIMEOUT_MS) {
        log.warn('server went quiet — forcing a reconnect');
        this.socket?.close(4000, 'timeout');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send a message.
   *
   * While disconnected, gameplay messages are dropped (they would be stale by
   * the time the socket recovers) but meta actions are buffered, so a purchase
   * made a moment before a blip is not silently lost.
   */
  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      const payload = encode(message);
      this.bytesSent += payload.length;
      this.socket.send(payload);
      return;
    }

    if (this.isBufferable(message.type)) {
      // Bound the buffer: a long outage should not replay hundreds of clicks.
      if (this.outbox.length < 32) this.outbox.push(message);
    }
  }

  private isBufferable(type: string): boolean {
    const transient = new Set<string>([
      ClientMessageType.Input,
      ClientMessageType.VehicleInput,
      ClientMessageType.Ping,
      ClientMessageType.AckSnapshot,
      ClientMessageType.SwitchWeapon,
      ClientMessageType.UseSkill,
    ]);
    return !transient.has(type);
  }

  private flushOutbox(): void {
    const pending = this.outbox.splice(0, this.outbox.length);
    for (const message of pending) this.send(message);
    if (pending.length > 0) log.info('flushed buffered messages', { count: pending.length });
  }

  /** Server time, estimated from the measured clock offset. */
  serverNow(): number {
    return Date.now() + this.serverTimeOffset;
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, 'client');
    this.socket = null;
    this.setState('idle');
  }

  stats(): { ping: number; state: ConnectionState; sent: number; received: number } {
    return {
      ping: Math.round(this.roundTripMs),
      state: this.state,
      sent: this.bytesSent,
      received: this.bytesReceived,
    };
  }
}

/** Quality label for the connection indicator. */
export function pingQuality(ms: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (ms < 45) return 'excellent';
  if (ms < 90) return 'good';
  if (ms < 160) return 'fair';
  return 'poor';
}
