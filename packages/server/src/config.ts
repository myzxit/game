/**
 * Server configuration.
 *
 * Read from the environment so the same build runs in development, testing and
 * production without a rebuild — the difference between environments is
 * configuration, not code (see docs/OPERATIONS.md).
 */

import { COMBAT_MAP_IDS, HUB_MAP_ID, LogLevel } from '@titan/shared';

export type Environment = 'development' | 'testing' | 'production';

export interface ServerConfig {
  environment: Environment;
  host: string;
  port: number;
  region: string;
  /** Directory for player saves. */
  dataDirectory: string;
  /** Use an in-memory store instead of the disk (local experiments, tests). */
  ephemeral: boolean;
  logLevel: LogLevel;
  /** Developer tools are never enabled in production. */
  devTools: boolean;
  preloadMaps: string[];
}

function readEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const LEVELS: Record<string, LogLevel> = {
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
  silent: LogLevel.Silent,
};

export function loadConfig(): ServerConfig {
  const environment = readEnv('TITAN_ENV', 'development') as Environment;
  const isProduction = environment === 'production';

  return {
    environment,
    host: readEnv('TITAN_HOST', '0.0.0.0'),
    port: readInt('TITAN_PORT', 8080),
    region: readEnv('TITAN_REGION', 'local'),
    dataDirectory: readEnv('TITAN_DATA_DIR', './data/profiles'),
    ephemeral: readBool('TITAN_EPHEMERAL', false),
    logLevel: LEVELS[readEnv('TITAN_LOG_LEVEL', isProduction ? 'info' : 'debug')] ?? LogLevel.Info,
    // Hard rule: developer tools cannot be switched on in a production build,
    // regardless of what the environment says.
    devTools: isProduction ? false : readBool('TITAN_DEV_TOOLS', true),
    preloadMaps: [...COMBAT_MAP_IDS, HUB_MAP_ID],
  };
}

export function describeConfig(config: ServerConfig): Record<string, unknown> {
  return {
    environment: config.environment,
    host: config.host,
    port: config.port,
    region: config.region,
    ephemeral: config.ephemeral,
    devTools: config.devTools,
    maps: config.preloadMaps.length,
  };
}
