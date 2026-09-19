/**
 * Client entry point.
 */

import './ui/styles.css';
import { createLogger } from '@titan/shared';
import { Game } from './core/Game.js';

const log = createLogger('Boot');

/**
 * Resolve the server URL.
 *
 * In development the client is served by Vite on a different port from the game
 * server, so default to the standard server port on the same host. In
 * production the two are normally behind one origin, so use it directly.
 */
function resolveServerUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;

  const configured = import.meta.env?.VITE_TITAN_SERVER as string | undefined;
  if (configured) return configured;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const isDevServer = location.port === '5173' || location.port === '4173';
  const host = isDevServer ? `${location.hostname}:8080` : location.host;
  return `${protocol}//${host}`;
}

function showFatal(message: string): void {
  const root = document.getElementById('ui-root');
  if (!root) return;
  root.innerHTML = `
    <div style="position:fixed;inset:0;display:grid;place-items:center;background:#05070c;
                pointer-events:auto;padding:24px;text-align:center">
      <div style="max-width:34rem">
        <div style="font-size:0.8rem;letter-spacing:0.4em;color:#5a6b85;margin-bottom:1.5rem">
          PROJECT TITAN
        </div>
        <p style="color:#e8edf5;line-height:1.8">${message}</p>
        <button onclick="location.reload()"
                style="margin-top:1.5rem;padding:0.7rem 1.4rem;background:#3f8ce8;border:none;
                       border-radius:4px;color:#04101f;cursor:pointer;font:inherit">
          다시 시도 / Retry
        </button>
      </div>
    </div>`;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');

  if (!canvas || !uiRoot) {
    showFatal('페이지를 초기화하지 못했습니다. / Failed to initialise the page.');
    return;
  }

  // WebGL is a hard requirement; fail with an explanation rather than a blank
  // screen or a stack trace.
  const probe = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!probe) {
    showFatal(
      '이 브라우저에서 WebGL을 사용할 수 없습니다. 하드웨어 가속을 켜거나 다른 브라우저를 사용해 주세요.<br><br>' +
        'WebGL is unavailable in this browser. Enable hardware acceleration or try another browser.',
    );
    return;
  }

  const serverUrl = resolveServerUrl();
  log.info('starting client', { serverUrl });

  let game: Game;
  try {
    game = new Game(canvas, uiRoot, serverUrl);
  } catch (error) {
    log.error('failed to construct the game', { error: String(error) });
    showFatal('게임을 시작하지 못했습니다. / The game failed to start.');
    return;
  }

  // An error inside the frame loop must not leave the player looking at a
  // frozen screen with no explanation.
  window.addEventListener('error', (event) => {
    log.error('uncaught error', { message: event.message, source: event.filename });
  });
  window.addEventListener('unhandledrejection', (event) => {
    log.error('unhandled rejection', { reason: String(event.reason) });
  });

  await game.start();

  // Expose for the developer console in dev builds only.
  if (import.meta.env?.DEV) {
    (window as unknown as { titan: Game }).titan = game;
  }
}

void main();
