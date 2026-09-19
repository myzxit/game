import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Point at source so the client and server share one copy of the
      // simulation. This is what keeps prediction and authority identical.
      '@titan/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Three.js is large and changes rarely; splitting it keeps the game
        // bundle small enough to re-download quickly on an update.
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
