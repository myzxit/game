# Content

All content in this project is original. No map, character, weapon, skin, name,
model, animation, sound, logo or UI design is taken from any existing game.

Content is data, not code. Everything below lives in
`packages/shared/src/config/`, and adding to it is a data edit plus localization
keys.

## Weapons

11 weapons across 8 classes. Every weapon carries a `balanceNote` that names
**both** its role and its weakness — if you cannot write the weakness, the
weapon is not balanced yet.

Tunable per weapon: damage, fire rate, magazine size, reload time, range,
accuracy, recoil, spread, mobility, ADS speed, headshot multiplier,
projectile-or-hitscan, ammo and reserve ammo.

### The balance rules are tests

- **No weapon is fastest to kill at every range.** A weapon that dominated at
  all ranges would fail the suite.
- **Every attachment has a real drawback.** The check covers every stat an
  attachment can move, in both directions — an attachment that only improved
  things fails.

These are assertions in `balance.test.ts`, not aspirations in a design document.

## Attachments

14 attachments. Each trades something for what it gives: a grip that steadies
recoil costs ADS movement speed, a barrel that extends range costs handling, and
so on.

An attachment illegal for a weapon is silently ignored by `resolveWeapon` rather
than rejected, so a malformed loadout degrades to a working one instead of
crashing or granting an advantage.

## Characters and skills

5 characters, 6 skills across four categories (attack, defense, movement,
special), each with cooldown, energy cost, effect, animation, VFX, sound and
upgrade tiers.

Character stat swings are deliberately small and always paired with a cost.
Dash and slide scale with the character only — never with the weapon — so a
player carrying a heavy weapon keeps an escape option.

## Maps

3 maps, built from a `MapBuilder` that composes walls with doorways and glass
window bands, rooms, stairs, catwalks with bullet-passthrough railings, crate
stacks, barriers, conduits and signage.

| Map | Role |
| --- | --- |
| Foundry Reach | Industrial. Three lanes, a tunnel flank, rooftop parkour, a secret vault. |
| Neon Quarter | Rainy night market. Sunken plaza, elevated walkway, flooded alley flank, a secret backroom. |
| Titan Hub | Social lobby. NPC counters, firing range, mezzanine, a hidden panel. |

Each combat map provides spawn / main / side / flank routes, long / mid / close
engagement ranges, cover, high and low ground, interiors and exteriors, and a
secret area. Map edges are dressed with backdrop layers (distant buildings,
mountains, roads, poles, antennas, sky) with LOD, so the playable area never
ends in visible emptiness.

Surfaces use 12 materials, each with its own impact sound, footstep sound,
impact VFX and penetration loss.

## Game modes

5 modes behind an extensible `GameMode` interface: team deathmatch, free-for-all,
objective, elimination, and ranked (which extends elimination).

Adding a mode means implementing the interface and registering it. The match
loop does not know about specific modes.

## Items and crates

29 cosmetic items across 6 rarities. **No item can carry a gameplay stat** —
the type has no field for one. See [MONETIZATION.md](MONETIZATION.md).

3 crate tables with published weights summing to 1, pity floors, and duplicate
conversion. The rates shown to the player are read from the same table the
server rolls against.

## Quests

| Kind | Count | Notes |
| --- | --- | --- |
| Daily pool | 12 | Deterministic daily roll from a seeded RNG. |
| Weekly pool | 5 | Deterministic weekly roll. |
| Story | 5 | |
| Secret | 4 | **Not shown in the quest list before discovery.** |
| Achievements | 11 | |

All quest kinds are driven by one generic tracker consuming `QuestEvent`s, so a
new objective type does not require new tracking code.

Claims mark themselves claimed *before* paying out, so a crash mid-claim cannot
pay twice.

## NPCs

5 NPCs with gated dialogue graphs (shop, quest, mission, tutorial, reward,
event, secret roles). Dialogue option gating is evaluated **server-side** and
matched by node id — a client cannot select an option it was not offered.

## Vehicles

1 vehicle (scout buggy): two seats, fast, fragile, unarmed. Boarding, driving
and dismounting work end to end; the driver sees it interpolated 100ms behind
and it has no engine sound yet. See
[STATUS.md](STATUS.md#vehicles--working-with-two-honest-caveats).

## Progression

- XP curve with level rewards (idempotent grants).
- 9 rank tiers with promotion and demotion, Elo-style: performance scales the
  magnitude of a rank change but never its sign.
- 1 season defined.
- 28-day login attendance table.

## Adding content

1. Add the definition to the relevant file in `config/`.
2. Add its Korean and English strings to `ko.ts` and `en.ts`.
3. Run `npm test`.

The balance and localization tests will report a dominant weapon, an attachment
with no drawback, or a missing string before it reaches a player.
