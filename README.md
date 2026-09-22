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

## Verifying it actually runs

```bash
npm run dev:server     # terminal 1
npm run dev:client     # terminal 2
npm run qa:e2e         # terminal 3: two real Chromium clients against the real server
npm run qa:server      # protocol-level checks: economy, security, reconnect
```

The end-to-end run drives two browsers through boot, login, every menu tab,
matchmaking, spawn, combat HUD, client prediction, remote-entity interpolation
and delta-snapshot reconstruction. Set `QA_CLIENT_URL` to point it at a release
bundle instead of the dev server; the steps that need the dev-only diagnostics
hook then report as *skipped* rather than silently passing.

## Documentation

| Document | What it covers |
| --- | --- |
| [STATUS.md](docs/STATUS.md) | Per-system status: working, partial, not implemented. Start here. |
| [ASSETS.md](docs/ASSETS.md) | Why no authored art or audio ships, and the full spec a real asset pack must meet. |
| [CONTENT.md](docs/CONTENT.md) | Weapons, maps, modes, quests, items, and how to add more. |
| [MONETIZATION.md](docs/MONETIZATION.md) | No payment provider, and why pay-to-win is structurally impossible here. |
| [OPERATIONS.md](docs/OPERATIONS.md) | Running the server, builds, saves, monitoring. |
| [LOCALIZATION.md](docs/LOCALIZATION.md) | Korean-first strings, fallback chain, adding a language. |

Two limitations are worth knowing before reading anything else: **this build
ships no authored art or audio** (everything is generated procedurally at
runtime), and **there is no payment provider**, so premium purchases are refused
rather than faked. Both are documented above rather than hidden.
