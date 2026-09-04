/**
 * Structured logging with levels and scopes.
 *
 * Rule of the project: the player never sees a raw error. Detailed diagnostics
 * go here; user-facing text comes from the localization layer. See
 * `core/errors.ts` for the paired user-message mapping.
 */

export enum LogLevel {
  Debug = 10,
  Info = 20,
  Warn = 30,
  Error = 40,
  Silent = 100,
}

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
  timestamp: number;
}

export type LogSink = (record: LogRecord) => void;

const LEVEL_NAME: Record<number, string> = {
  [LogLevel.Debug]: 'DEBUG',
  [LogLevel.Info]: 'INFO ',
  [LogLevel.Warn]: 'WARN ',
  [LogLevel.Error]: 'ERROR',
};

/** Ring buffer of recent records — powers the in-game dev console and crash reports. */
class LogHistory {
  private readonly buffer: LogRecord[] = [];
  constructor(private readonly capacity: number) {}

  push(record: LogRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }

  recent(count = 100): LogRecord[] {
    return this.buffer.slice(-count);
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

class LogManager {
  level: LogLevel = LogLevel.Info;
  readonly history = new LogHistory(500);
  private readonly sinks: LogSink[] = [];

  addSink(sink: LogSink): () => void {
    this.sinks.push(sink);
    return () => {
      const i = this.sinks.indexOf(sink);
      if (i >= 0) this.sinks.splice(i, 1);
    };
  }

  emit(record: LogRecord): void {
    if (record.level < this.level) return;
    this.history.push(record);
    for (const sink of this.sinks) {
      try {
        sink(record);
      } catch {
        // A failing sink must never take down the game loop.
      }
    }
  }
}

export const logManager = new LogManager();

/** Default console sink. Kept separate so tests can silence output. */
export const consoleSink: LogSink = (r) => {
  const time = new Date(r.timestamp).toISOString().slice(11, 23);
  const line = `[${time}] ${LEVEL_NAME[r.level] ?? r.level} [${r.scope}] ${r.message}`;
  if (r.level >= LogLevel.Error) console.error(line, r.data ?? '');
  else if (r.level >= LogLevel.Warn) console.warn(line, r.data ?? '');
  else console.log(line, r.data ?? '');
};

export class Logger {
  constructor(private readonly scope: string) {}

  child(subScope: string): Logger {
    return new Logger(`${this.scope}:${subScope}`);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    logManager.emit({ level, scope: this.scope, message, data, timestamp: Date.now() });
  }

  debug(message: string, data?: unknown): void {
    this.log(LogLevel.Debug, message, data);
  }
  info(message: string, data?: unknown): void {
    this.log(LogLevel.Info, message, data);
  }
  warn(message: string, data?: unknown): void {
    this.log(LogLevel.Warn, message, data);
  }
  error(message: string, data?: unknown): void {
    this.log(LogLevel.Error, message, data);
  }
}

export const createLogger = (scope: string): Logger => new Logger(scope);

/** Enable console output. Called from server main() and client bootstrap. */
export function enableConsoleLogging(level: LogLevel = LogLevel.Info): () => void {
  logManager.level = level;
  return logManager.addSink(consoleSink);
}
