/**
 * Server entry point.
 */

import { createLogger, enableConsoleLogging } from '@titan/shared';
import { GameServer } from './net/GameServer.js';
import { FileProfileStore, MemoryProfileStore, type ProfileStore } from './data/ProfileStore.js';
import { describeConfig, loadConfig } from './config.js';

const log = createLogger('Main');

async function main(): Promise<void> {
  const config = loadConfig();
  enableConsoleLogging(config.logLevel);
  log.info('starting PROJECT TITAN server', describeConfig(config));

  let store: ProfileStore;
  if (config.ephemeral) {
    log.warn('running with an in-memory profile store — progress will not persist');
    store = new MemoryProfileStore();
  } else {
    const fileStore = new FileProfileStore(config.dataDirectory);
    await fileStore.init();
    store = fileStore;
  }

  const server = new GameServer({
    port: config.port,
    host: config.host,
    region: config.region,
    store,
    preloadMaps: config.preloadMaps,
    devTools: config.devTools,
  });

  await server.start();

  // Graceful shutdown: flush every dirty profile before exiting, so a deploy
  // never costs a player their last match.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown requested', { signal });
    try {
      await server.stop();
    } catch (error) {
      log.error('error during shutdown', { error: String(error) });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // An unhandled error must be logged loudly, but it must not silently leave
  // the process running in an unknown state.
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', { message: error.message, stack: error.stack });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
  });
}

main().catch((error) => {
  console.error('fatal startup error', error);
  process.exit(1);
});
