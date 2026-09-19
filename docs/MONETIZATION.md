# Monetization

## There is no payment provider, and nothing pretends otherwise

This build has no integration with any real payment API. That has one concrete
consequence, and the code enforces it rather than working around it:

**Premium currency cannot be purchased, and premium season rewards cannot be
claimed.** `ProgressionService` refuses the premium track because no verified
receipt can exist. `EconomyService` will not grant premium currency without one.

This is deliberate. Implementing a fake "purchase successful" path in a build
with no payment API would produce a system that looks finished, passes a demo,
and is wrong in the one way that matters — it would grant real entitlements for
no real transaction, and the failure would only surface once money was involved.
A refusal is the honest behaviour.

### What a real integration has to supply

The seam is already in place: `PREMIUM_TIERS` in `config/economy.ts` defines the
products, and the grant path takes a receipt. A real integration must provide:

- Server-to-server receipt verification against the platform's API. The client
  must never be the source of truth that a purchase happened.
- Idempotency by transaction id, so a retried or replayed receipt grants once.
- A refund/chargeback path that can revoke an entitlement.
- An audit ledger entry per grant (the ledger already exists in
  `EconomyService`).

Until those exist, the refusal stays.

## No pay-to-win — structurally, not as a promise

The usual way a game promises "no pay-to-win" is a policy statement that a later
content patch quietly breaks. Here it is a structural property with a test
behind it.

**No item in the catalogue can hold a gameplay stat.** The `ItemDefinition`
type has no field for damage, fire rate, health, speed or any other combat
value — only `visual` data, rarity and what slot it applies to. An item that
affected combat could not be represented, let alone sold.

A balance test asserts this directly, so adding a stat field to catalogue items
in order to sell one would fail the test suite rather than ship.

What is sold, therefore, is cosmetic only:

- Weapon and character skins (6 rarities, all original designs)
- Titles
- Crate keys

What is *not* sold and cannot be:

- Weapons, attachments, characters, or skills. These are earned through play.
- XP or rank. Rank points come only from match performance.
- Any stat modifier of any kind.

## Crate probabilities are published, not hidden

`CRATE_TABLES` carries real weights that sum to 1. Those exact numbers are shown
to the player in the reveal UI — the rates displayed are the rates the server
rolled against, read from the same table, not a separately maintained marketing
number that can drift from reality.

Each table also has:

- **Pity**: a guaranteed rarity floor after a defined number of unlucky opens,
  so a player cannot be indefinitely unlucky.
- **Duplicate conversion**: a duplicate becomes currency rather than nothing, so
  an open never produces an empty result.

Crate rolls use the seeded RNG, which means an open is reproducible and
auditable from its seed rather than being an unverifiable claim.

## Earned economy

Coins are granted for match performance, quest completion, level-up, rank-up and
login attendance, with:

- Per-grant caps and a daily cap, so an exploit in any one source is bounded
  rather than unbounded.
- An audit ledger recording every grant and spend.
- All-or-nothing multi-spends, so a partially applied purchase cannot leave a
  player charged for something they did not receive.
