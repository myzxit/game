# PROJECT TITAN

An original multiplayer FPS: authoritative Node server + WebGL (Three.js) client,
written in TypeScript. Built to run on low-spec hardware and to be operated and
updated over time.

**Status:** in development. See `docs/STATUS.md` for an honest, per-system
breakdown of what is implemented, what is partial, and what is not built.

## Quick start

```bash
npm install
npm run build          # typecheck + build all packages
npm test               # run the full test suite
npm run dev:server     # authoritative game server
npm run dev:client     # client dev server (open the printed URL)
```

## Layout

```
packages/shared   simulation, content config, protocol — imported by both sides
packages/server   authoritative game server: netcode, matches, meta services
packages/client   WebGL client: rendering, prediction, UI, audio, VFX
docs/             design, assets, operations
```

The `shared` package is the reason prediction works: the client and the server
run byte-identical movement and weapon simulation code.
