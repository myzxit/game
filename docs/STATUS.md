# Implementation status

The point of this document is to be accurate rather than flattering. Anything
marked **Working** has been run and observed working. Anything marked **Partial**
or **Not implemented** is exactly that, and is not claimed anywhere else in the
repository as finished.

Last verified, all in one sweep:

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | 193/193 |
| `npm run qa:e2e` (dev bundle) | 26/26 steps |
| `npm run qa:e2e` (release bundle) | 16/16 steps, 4 skipped |
| `npm run qa:server` | 13/13 checks |

The skipped steps need the dev-only diagnostics hook (and, for the vehicle
board test, the dev-only teleport), which genuinely are not present in a
release bundle. They report as *skipped* rather than passing vacuously.

## How to check these claims yourself

```bash
npm install
npm run build
npm test                      # 193 unit tests

npm run dev:server            # terminal 1
npm run dev:client            # terminal 2
npm run qa:e2e                # terminal 3: two real Chromium clients
npm run qa:server             # protocol-level: economy, security, reconnect
```

## The two limitations that matter most

1. **No authored assets.** Every model, texture, animation and sound is
   generated procedurally at runtime. This is reported at boot, shown in the dev
   panel, and specified in full in [ASSETS.md](ASSETS.md). It is the single
   largest gap between this and a commercial build.
2. **No payment provider.** Premium currency cannot be purchased and premium
   season rewards cannot be claimed, because there is no real payment API here
   and faking a successful purchase would be worse than not having one. See
   [MONETIZATION.md](MONETIZATION.md).

## Core systems

| System | Status | Notes |
| --- | --- | --- |
| Deterministic shared simulation | Working | `stepMovement` / `stepWeapon` are pure functions in `@titan/shared`, imported by both the client's prediction loop and the server's authoritative loop. This is what makes prediction correct by construction rather than by matching two implementations. |
| Client prediction + reconciliation | Working | Measured live: prediction error 0.000–0.32m under software rendering at ~4fps. |
| Entity interpolation | Working | Renders 100ms in the past, capped extrapolation, short-way angle interpolation. |
| Lag compensation | Working | Rewinds hitboxes to `now - (halfRtt + interpolationDelay)`, bounded by `MAX_REWIND_MS` so peeker's advantage cannot be amplified. |
| Delta snapshots | Working | 0 resyncs over 725 snapshots in a live match; vehicles ride in every snapshot in full. Quantised positions (cm) and angles (1/1000 rad). |
| Reconnection | Working | Session tokens with a grace window; match state is restored, not restarted. |
| Collision | Working | AABB world with a uniform grid. Deliberately not a triangle mesh, so client and server produce identical results. |

## Combat

| System | Status | Notes |
| --- | --- | --- |
| Firing, ADS, reload, swap, ammo, mags | Working | |
| Recoil, spread, first-shot accuracy | Working | Seeded RNG, so the client predicts the same spread the server computes. |
| Hitscan and projectile weapons | Working | Projectiles are swept, so they cannot tunnel. |
| Hit zones, headshots, damage falloff, penetration | Working | |
| Kills, assists, killfeed, streaks, multikills | Working | |
| Death, respawn, spawn protection, team damage rules | Working | |
| Skills (4 categories, cooldown/energy/upgrades) | Working | 6 skills across 5 characters. |
| Fall damage, stamina | Working | |

## Content

All content is original to this project. No map, character, weapon, skin, name
or design is taken from any existing game.

| Content | Count | Status |
| --- | --- | --- |
| Weapons | 11 across 8 classes | Working. Each carries a `balanceNote` naming its role *and* its weakness. |
| Attachments | 14 | Working. Every one has a real drawback, enforced by a test. |
| Characters | 5 | Working. Stat swings are small and always paired with a cost. |
| Maps | 3 | Working. Foundry Reach, Neon Quarter, Titan Hub (social//tutorial). |
| Game modes | 5 | Working, behind an extensible `GameMode` interface. |
| Cosmetic items | 29 | Working. None carries a gameplay stat — structurally, not by policy. |
| Crates | 3 tables | Working, with published rates, pity, and duplicate conversion. |
| Quests | 12 daily pool, 5 weekly pool, 5 story, 4 secret | Working. Secrets stay hidden until discovered. |
| Achievements | 11 | Working. |
| NPCs | 5 | Working, with server-gated dialogue graphs. |
| Vehicles | 1 (scout buggy) | Working — board, drive, ride along, dismount; see notes below. |
| Rank tiers | 9, 1 season | Working. |
| Login rewards | 28-day table | Working. |

## Meta and progression

| System | Status | Notes |
| --- | --- | --- |
| XP, levels, level rewards | Working | Reward grants are idempotent. |
| Rank, promotion/demotion, leaderboards | Working | Elo-style; performance scales magnitude but never sign. |
| Economy, shop, rotation, purchase | Working | Prices are re-derived server-side on purchase; a failed grant refunds. |
| Inventory, loadouts | Working | A malformed loadout is repaired, not rejected. |
| Quests, dailies, weeklies, secrets | Working | Deterministic daily/weekly rolls from a seeded RNG. |
| Party, matchmaking | Working | Search band widens so queues cannot deadlock; parties are never split. |
| Social: friends, profile, block, report, mute | Working | Reports store the minimum information, 30-day retention. |
| Persistence | Working | Atomic write (temp → fsync → rotate → rename), retry with backoff, `.bak` fallback, versioned schema with forward migrations. Refuses to overwrite an unreadable save rather than silently wiping progress. |

## Client

| System | Status | Notes |
| --- | --- | --- |
| Rendering | Working | Merged geometry per material + instanced props. 26–51 draw calls on a full map. |
| HUD, menus, all meta screens | Working | Verified rendering in a real browser. |
| Settings (graphics / audio / controls / gameplay) | Working | Low preset reduces decoration but never gameplay legibility. |
| Localization | Working | Korean primary, 749 keys, English fallback at full parity (enforced by test). Japanese and Chinese are declared as planned and deliberately absent rather than half-filled. |
| Accessibility | Working | Camera shake, motion reduction, text scale, subtitles, colourblind palettes, high contrast, flash reduction. |
| Audio | Working | Procedural synthesis, HRTF panning, distance filtering, voice budget. |
| Keyboard + mouse | Working | Verified in a real browser. |
| Gamepad | **Partial** | Implemented against the Gamepad API but **never tested on real hardware** — there is no controller attached to this machine. Treat as unverified. |
| Touch / virtual joystick | **Partial** | Implemented but **never tested on a real touch device.** Treat as unverified. |

## Known gaps

### Vehicles — working, with two honest caveats

Server side: vehicles spawn from map data; boarding, driving on both combat
maps, seat contention, occupant sync, damage, destruction and the wire format
are simulated authoritatively and covered by 8 tests. Proximity is validated
server-side, so a client cannot board across the map. Measured live: 0 to
17.9 m/s in one second (the definition's 14 m/s²), 48 damage on hitting a wall
at that speed, exactly as the collision-damage formula says.

Two of the three vehicle pads originally sat inside solid geometry (a crate
stack, a building wall) and the third faced a wall two metres ahead; the buggy
"worked" but crawled at 0.07 m/s. `maps.test.ts` now sweeps every pad's
footprint and its forward run-up against the collision world, so a map edit
cannot reintroduce that silently.

Client side: vehicles arrive in every snapshot, are rendered procedurally (body,
roll cage, seats, four spinning wheels, headlights, damage scorching), show a
localized board/dismount prompt within range, and route W/S/A/D into drive
input while seated with the camera riding in the seat. The browser E2E boards,
drives and dismounts a real buggy through the real interact key.

Caveats:

- **The driver sees the vehicle 100ms in the past.** Vehicles are interpolated
  on the same delayed clock as remote players; there is no client-side vehicle
  prediction. Driving feels slightly laggy compared to on-foot movement, which
  *is* predicted. Adding vehicle prediction is a contained piece of work
  (the server's `driveVehicle` is deterministic) but is not done.
- **No engine audio.** The buggy's definition names an engine sound; no
  synthesis recipe exists for it yet, so it is silent. Its balance note promises
  a loud engine — that promise is currently unmet.

### Replay — groundwork only

Match events (start, spawn, shot, hit, kill, death, objective, end) are recorded
in a structured, replayable form. There is **no playback implementation**. The
recording exists so replay can be added without changing the match loop; calling
it a replay system today would be a lie.

### Anti-cheat — bounded by design

The anti-cheat is a *server-side plausibility checker*. It never inspects the
player's machine, never scans processes, never installs a driver and never
deletes anything — per the explicit requirement that it must not endanger a
player's legitimate software or system.

What it does: makes speed, teleport, fire-rate, infinite-ammo and reach cheats
*impossible* rather than merely detectable, because the server owns the
simulation. Plus type/range/permission validation, rate limiting per message
class, a byte-rate cap, and sequence-replay rejection.

What it explicitly **cannot** do: catch a cheat that only ever produces
plausible inputs — a subtle aimbot with human-like error will not be caught by
this, and no amount of server-side checking alone would catch it. Flags go to an
operator review queue; nothing auto-bans.

### Spectating

Spectating after death works as a camera mode. It is presentation-only — the
client already receives every player's snapshot — which also means it currently
has no server-side enforcement of *whom* a dead player may spectate. In a
competitive release that should be restricted to teammates.

### Developer tools

`dev_command` (teleport, give coins, set health) is a real protocol message,
rate-limited like any action. The server honours it only when started with dev
tools on; `config.ts` forces that flag off in a production build regardless of
environment variables, and a release server answers it with a Forbidden error
plus a suspicious-request mark, since a stock client never sends it. The
browser E2E uses the teleport to reach a vehicle pad; that is the only test-time
use, and nothing else in the game depends on it.

### Tests

175 unit tests plus the browser E2E. Not covered by automated tests: the
renderer's visual output (verified by screenshot inspection instead), audio
output, gamepad, touch, and vehicle handling feel (only its mechanics).

## Not attempted

These were in scope but are honestly not present, rather than stubbed to look
present:

- Authored 3D models, textures, animations and audio (see ASSETS.md).
- A real payment integration (see MONETIZATION.md).
- Replay playback.
- Client-side vehicle prediction and engine audio (vehicles themselves work).
- Japanese and Chinese localization (declared as planned; the string tables do
  not exist).
