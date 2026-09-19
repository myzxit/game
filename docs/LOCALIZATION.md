# Localization

## Korean is the primary language

Korean is the source language, not a translation of English. 749 keys, with
English registered as its fallback at full parity.

```
ko  →  en  →  (raw key)
en  →  (raw key)
```

## No hardcoded UI strings

Every user-visible string goes through `t()`. Nothing in the UI layer contains
literal display text.

This is enforced rather than trusted: a test asserts that **ko and en define
exactly the same key set**, and that every key referenced by content
definitions (weapons, attachments, characters, items, quests, NPCs, maps, ranks)
actually exists in both tables. A content addition that forgets its strings
fails the suite instead of shipping a blank label.

## A missing key returns the key

`t('some.missing.key')` returns `some.missing.key` — visibly wrong text, not a
silent empty string and not a crash. That is deliberate: a gap should be obvious
to whoever is looking at the screen in QA, and harmless to the player if one
ever escapes.

## Parameters

```ts
t('inventory.item_count', { count: 12 })   // "12개 보유"
```

Interpolation is `{name}`. Parameters are substituted, never evaluated.

## Planned languages

`PLANNED_LOCALES` declares Japanese and Chinese as planned. **Their string
tables do not exist.** They are listed as planned rather than registered with
partial or machine-translated content, so the language selector cannot offer a
language that would render half in Korean.

Adding one is a data change: add `ja.ts`, call `registerLocale` with a fallback,
and the parity test will immediately report every key still missing.

## Guidance for translators

- Korean is the reference text. Translate from `ko.ts`, not from `en.ts`.
- Keep parameter placeholders exactly as written; they are matched by name.
- UI space is tight in the HUD and menu tabs. Prefer the shorter phrasing where
  both are accurate.
- Weapon, character, map and skin names are original to this project. Transliterate
  rather than translate them, and never substitute a name from an existing game.
