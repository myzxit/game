# Operations

## Running the server

```bash
npm run build
node packages/server/dist/main.js
```

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TITAN_ENV` | `development` | `development`, `testing` or `production`. |
| `TITAN_HOST` | `0.0.0.0` | Bind address. |
| `TITAN_PORT` | `8080` | Listen port. |
| `TITAN_REGION` | `local` | Region label, reported to clients for server selection. |
| `TITAN_DATA_DIR` | `./data/profiles` | Where player profiles are stored. |
| `TITAN_EPHEMERAL` | `false` | Keep profiles in memory only. For tests. |
| `TITAN_LOG_LEVEL` | `debug` (dev), `info` (prod) | `error`, `warn`, `info` or `debug`. |
| `TITAN_DEV_TOOLS` | `true` in dev | Developer tools. **Forced off when `TITAN_ENV=production`, and cannot be switched back on.** |

### Developer tools are not reachable in a release build

```ts
devTools: isProduction ? false : readBool('TITAN_DEV_TOOLS', true)
```

The environment variable is only consulted outside production. Setting
`TITAN_DEV_TOOLS=true` on a production server does nothing. The same applies on
the client: the diagnostics hook (`window.titan`) and the performance panel are
compiled out of a release bundle by `import.meta.env.DEV`, so a player cannot
open a console and reach the game object.

This is why four steps of the browser E2E report as *skipped* rather than passed
when run against a release bundle — the hook they need genuinely is not there.

The same flag gates the `dev_command` protocol message (teleport, give coins,
set health). A production server refuses it with `error.forbidden` and marks
the sender as suspicious. Dev-granted coins go through the normal economy path,
so they appear in the audit ledger like any other grant.

## Builds

| Build | Command | Characteristics |
| --- | --- | --- |
| Development | `npm run dev:server` / `npm run dev:client` | Dev tools on, debug logging, source maps, diagnostics hook exposed. |
| Testing | `TITAN_ENV=testing` | Dev tools available, info logging, ephemeral storage option for clean runs. |
| Production | `TITAN_ENV=production` + `npm run build` | Dev tools forced off, info logging, no diagnostics hook. |

## Saves

Profiles are written atomically:

1. Write to a temp file.
2. `fsync` it, so the bytes are actually on disk rather than in a cache.
3. Rotate the existing file to `.bak`.
4. `rename` the temp file into place (atomic on POSIX).

A write that fails is retried with exponential backoff. A read falls back to
`.bak` if the primary is unreadable.

**If both copies are unreadable, the server refuses to load that profile rather
than creating a fresh one.** That is intentional: silently replacing a corrupt
save with an empty one destroys a player's progress and looks like a successful
login. A refusal is visible and recoverable; a silent reset is neither.

On shutdown (SIGINT/SIGTERM) all dirty profiles are flushed before exit.

### Schema migrations

`SAVE_SCHEMA_VERSION` is the current version. `MIGRATIONS` is keyed by source
version and applied forward in sequence. After migration, `repair()` fills and
clamps every field and guarantees an ownership floor, so a profile from an old
build or a partially-written file becomes valid rather than throwing.

## Monitoring

The server logs at four levels (error / warning / info / debug). Worth watching:

- `anticheat` flags — these go to an operator review queue and **never
  auto-ban**. A flag is a prompt to look, not a verdict.
- Save write failures and retries.
- Matchmaking queue times — the search band widens over time, so a rising time
  means population, not a deadlock.
- Reconnect rates.

`AnalyticsService` records **aggregates only**. It does not collect personal
data beyond what the account already requires. Reports store the minimum
information needed to action them, with 30-day retention.

## Scaling notes

The server is a single authoritative process running matches in-process at 64Hz
with 20Hz snapshots. Practical limits before it needs sharding:

- Each match runs its own fixed-step loop. Match count per process is CPU-bound.
- Profiles are file-backed. A real deployment should put `ProfileStore` behind a
  database; the interface exists for exactly that substitution, and
  `MemoryProfileStore` shows the second implementation.

## Content updates

Weapons, attachments, characters, skills, maps, modes, items, crates, quests,
NPCs, vehicles and audio are all data in `packages/shared/src/config/`. Adding
content is a data edit plus its localization keys — the balance and localization
tests will tell you immediately if the addition breaks a rule (a dominant
weapon, an attachment with no drawback, a missing string).
