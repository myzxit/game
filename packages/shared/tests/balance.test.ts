/**
 * Balance guard rails.
 *
 * These tests encode design rules that must survive future content additions:
 * no weapon may dominate at every range, every attachment must cost something,
 * and no purchasable item may carry a gameplay stat (the structural reason the
 * game cannot become pay-to-win).
 *
 * A failure here is a design regression, not a broken build.
 */

import { describe, it, expect } from 'vitest';
import {
  WEAPONS,
  ATTACHMENTS,
  CHARACTERS,
  SKILLS,
  ITEMS,
  CRATE_TABLES,
  GAME_MODES,
  MAPS,
  hasDrawback,
  timeToKill,
  damageAtRange,
  resolveWeapon,
  getItem,
  getWeapon,
  getAttachment,
  getCharacter,
  getSkill,
  getQuest,
  ALL_QUESTS,
  ACHIEVEMENTS,
  LEVEL_REWARDS,
  WeaponClass,
  ItemCategory,
  Rarity,
  RARITY_ORDER,
  volumesToBrushes,
  CollisionWorld,
  MAX_HEALTH,
  ZoneTag,
  DAILY_QUEST_POOL,
  WEEKLY_QUEST_POOL,
} from '../src/index.js';

describe('weapons — every weapon has a role and a weakness', () => {
  it('has a unique id and a balance note explaining its role', () => {
    const ids = new Set<string>();
    for (const w of WEAPONS) {
      expect(ids.has(w.id), `duplicate weapon id ${w.id}`).toBe(false);
      ids.add(w.id);
      expect(w.balanceNote.length, `${w.id} needs a balance note`).toBeGreaterThan(30);
    }
  });

  it('no weapon has the fastest time-to-kill at close, mid AND long range', () => {
    const ranges = [5, 30, 70];
    const winners = ranges.map((r) => {
      let best: { id: string; ttk: number } | null = null;
      for (const w of WEAPONS) {
        if (w.class === WeaponClass.Melee) continue;
        const resolved = resolveWeapon(w.id)!;
        const ttk = timeToKill(resolved, r, MAX_HEALTH);
        if (!Number.isFinite(ttk)) continue;
        if (!best || ttk < best.ttk) best = { id: w.id, ttk };
      }
      return best!.id;
    });

    // The same weapon must not win every bracket.
    expect(new Set(winners).size, `one weapon dominates all ranges: ${winners.join(', ')}`).toBeGreaterThan(1);
  });

  it('close-range weapons genuinely fall off at range', () => {
    for (const w of WEAPONS) {
      if (w.class !== WeaponClass.SMG && w.class !== WeaponClass.Shotgun) continue;
      const near = damageAtRange(w, 5);
      const far = damageAtRange(w, 45);
      expect(far, `${w.id} does not fall off`).toBeLessThan(near * 0.6);
    }
  });

  it('long-range weapons pay for their damage with handling', () => {
    const median = WEAPONS.reduce((a, w) => a + w.adsTimeMs, 0) / WEAPONS.length;
    for (const w of WEAPONS) {
      if (w.class !== WeaponClass.Sniper && w.class !== WeaponClass.Marksman) continue;
      expect(w.adsTimeMs, `${w.id} aims too fast for its damage`).toBeGreaterThan(median);
      expect(w.mobility, `${w.id} is too mobile for its damage`).toBeLessThan(1.0);
    }
  });

  it('the highest-mobility weapons are the weakest at range', () => {
    const sorted = [...WEAPONS].sort((a, b) => b.mobility - a.mobility);
    const mostMobile = sorted[0]!;
    const rifleRange = damageAtRange(resolveWeapon('tr9_sentinel')!, 40);
    expect(damageAtRange(mostMobile, 40)).toBeLessThanOrEqual(rifleRange);
  });

  it('no weapon can kill a full-health target instantly beyond close range', () => {
    for (const w of WEAPONS) {
      const resolved = resolveWeapon(w.id)!;
      const perShot = damageAtRange(resolved, 25) * resolved.pellets * resolved.headshotMultiplier;
      if (w.class === WeaponClass.Sniper) continue; // snipers are meant to one-shot headshots
      expect(perShot, `${w.id} one-shots at 25m`).toBeLessThan(MAX_HEALTH * 1.6);
    }
  });

  it('has sane stat ranges', () => {
    for (const w of WEAPONS) {
      expect(w.damage, `${w.id} damage`).toBeGreaterThan(0);
      expect(w.fireRate, `${w.id} fireRate`).toBeGreaterThan(0);
      expect(w.headshotMultiplier, `${w.id} headshot`).toBeGreaterThanOrEqual(1);
      expect(w.damageFalloffEnd).toBeGreaterThanOrEqual(w.damageFalloffStart);
      expect(w.reloadEmptyTimeMs).toBeGreaterThanOrEqual(w.reloadTimeMs);
      expect(w.minDamageScale).toBeGreaterThanOrEqual(0);
      expect(w.minDamageScale).toBeLessThanOrEqual(1);
      expect(w.mobility).toBeGreaterThan(0.5);
      expect(w.mobility).toBeLessThan(1.5);
    }
  });

  it('covers every weapon class', () => {
    const classes = new Set(WEAPONS.map((w) => w.class));
    for (const c of Object.values(WeaponClass)) {
      expect(classes.has(c), `no weapon of class ${c}`).toBe(true);
    }
  });
});

describe('attachments — every attachment is a trade-off', () => {
  it('each attachment carries at least one drawback', () => {
    for (const a of ATTACHMENTS) {
      expect(hasDrawback(a), `${a.id} is a pure upgrade`).toBe(true);
    }
  });

  it('no attachment changes a stat by more than 50%', () => {
    for (const a of ATTACHMENTS) {
      for (const [key, value] of Object.entries(a.modifiers)) {
        if (key === 'magazineSizeAdd' || key === 'adsFovAdd') continue;
        const v = value as number;
        expect(v, `${a.id}.${key} too strong`).toBeGreaterThan(0.5);
        expect(v, `${a.id}.${key} too strong`).toBeLessThan(1.5);
      }
    }
  });

  it('an attached weapon never becomes strictly better than the base in every respect', () => {
    for (const w of WEAPONS) {
      for (const a of ATTACHMENTS) {
        if (!w.attachmentSlots.includes(a.slot)) continue;
        const modded = resolveWeapon(w.id, { [a.slot]: a.id })!;
        // Compare across every stat an attachment is able to move, so a
        // drawback in any one of them counts. Missing a stat here would let a
        // pure upgrade slip through.
        const higherIsBetter: [number, number][] = [
          [modded.damage, w.damage],
          [modded.fireRate, w.fireRate],
          [modded.magazineSize, w.magazineSize],
          [modded.mobility, w.mobility],
          [modded.adsMoveMultiplier, w.adsMoveMultiplier],
          [modded.damageFalloffStart, w.damageFalloffStart],
          [modded.damageFalloffEnd, w.damageFalloffEnd],
          [modded.recoil.recovery, w.recoil.recovery],
        ];
        const lowerIsBetter: [number, number][] = [
          [modded.reloadTimeMs, w.reloadTimeMs],
          [modded.adsTimeMs, w.adsTimeMs],
          [modded.equipTimeMs, w.equipTimeMs],
          [modded.recoil.vertical, w.recoil.vertical],
          [modded.recoil.horizontal, w.recoil.horizontal],
          [modded.spread.base, w.spread.base],
          [modded.spread.perShot, w.spread.perShot],
        ];

        const strictlyBetter =
          higherIsBetter.every(([m, b]) => m >= b) && lowerIsBetter.every(([m, b]) => m <= b);
        expect(strictlyBetter, `${a.id} on ${w.id} is strictly better`).toBe(false);
      }
    }
  });
});

describe('characters and skills', () => {
  it('no character is a straight upgrade over Vanguard', () => {
    const baseline = getCharacter('vanguard')!;
    for (const c of CHARACTERS) {
      if (c.id === baseline.id) continue;
      const strictlyBetter =
        c.moveSpeedMultiplier >= baseline.moveSpeedMultiplier &&
        c.healthBonus >= baseline.healthBonus &&
        c.shieldBonus >= baseline.shieldBonus &&
        (c.moveSpeedMultiplier > baseline.moveSpeedMultiplier ||
          c.healthBonus > baseline.healthBonus ||
          c.shieldBonus > baseline.shieldBonus);
      expect(strictlyBetter, `${c.id} is strictly better than vanguard`).toBe(false);
    }
  });

  it('character health/shield bonuses stay small', () => {
    for (const c of CHARACTERS) {
      expect(Math.abs(c.healthBonus), `${c.id} health swing too large`).toBeLessThanOrEqual(15);
      expect(Math.abs(c.shieldBonus), `${c.id} shield swing too large`).toBeLessThanOrEqual(25);
      expect(c.moveSpeedMultiplier).toBeGreaterThan(0.85);
      expect(c.moveSpeedMultiplier).toBeLessThan(1.15);
    }
  });

  it('every character references a real default skill', () => {
    for (const c of CHARACTERS) {
      expect(getSkill(c.defaultSkillId), `${c.id} references missing skill`).toBeDefined();
    }
  });

  it('no skill can kill a full-health target on its own', () => {
    for (const s of SKILLS) {
      const damage = s.params.damage ?? 0;
      expect(damage, `${s.id} can solo-kill`).toBeLessThan(MAX_HEALTH);
    }
  });

  it('every skill has a real cooldown and upgrades that stay modest', () => {
    for (const s of SKILLS) {
      expect(s.cooldownMs, `${s.id} cooldown`).toBeGreaterThanOrEqual(5000);
      for (const up of s.upgrades) {
        for (const [key, mult] of Object.entries(up.modifiers)) {
          expect(mult, `${s.id} tier ${up.tier} ${key}`).toBeGreaterThan(0.7);
          expect(mult, `${s.id} tier ${up.tier} ${key}`).toBeLessThan(1.3);
        }
      }
    }
  });
});

describe('economy — no pay-to-win', () => {
  it('no catalogue item carries a gameplay stat field', () => {
    const statFields = [
      'damage',
      'fireRate',
      'health',
      'shield',
      'speed',
      'moveSpeed',
      'recoil',
      'spread',
      'cooldown',
      'range',
      'accuracy',
      'armor',
    ];
    for (const item of ITEMS) {
      const keys = Object.keys(item);
      for (const f of statFields) {
        expect(keys.includes(f), `${item.id} exposes a gameplay stat: ${f}`).toBe(false);
      }
      // The visual block is the only place an item may describe itself.
      const visualKeys = Object.keys(item.visual);
      for (const f of statFields) {
        expect(visualKeys.includes(f), `${item.id}.visual exposes ${f}`).toBe(false);
      }
    }
  });

  it('cosmetic categories only', () => {
    const combatCategories = new Set([ItemCategory.Weapon, ItemCategory.Attachment, ItemCategory.Character]);
    for (const item of ITEMS) {
      if (!combatCategories.has(item.category)) continue;
      // Weapons/attachments/characters are defined in their own config files with
      // explicit balance notes; the item catalogue must not shadow them.
      expect(
        getWeapon(item.id) ?? getAttachment(item.id) ?? getCharacter(item.id),
        `${item.id} is a combat item in the cosmetics catalogue`,
      ).toBeDefined();
    }
  });

  it('crate drop rates sum to 1 and are fully published', () => {
    for (const table of CRATE_TABLES) {
      const total = Object.values(table.rarityWeights).reduce((a, b) => a + b, 0);
      expect(total, `${table.crateId} rates do not sum to 1`).toBeCloseTo(1, 6);
      for (const [rarity, weight] of Object.entries(table.rarityWeights)) {
        expect(weight, `${table.crateId} ${rarity} weight`).toBeGreaterThan(0);
        // Every listed rarity must have a duplicate conversion value, so a
        // duplicate never silently gives nothing.
        expect(
          table.duplicateCoins[rarity as Rarity],
          `${table.crateId} missing duplicate value for ${rarity}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('higher rarities are rarer', () => {
    for (const table of CRATE_TABLES) {
      const present = RARITY_ORDER.filter((r) => table.rarityWeights[r] !== undefined);
      for (let i = 1; i < present.length; i++) {
        const prev = table.rarityWeights[present[i - 1]!]!;
        const cur = table.rarityWeights[present[i]!]!;
        expect(cur, `${table.crateId}: ${present[i]} not rarer than ${present[i - 1]}`).toBeLessThanOrEqual(prev);
      }
    }
  });

  it('crate item pools are non-empty for every crate', () => {
    for (const table of CRATE_TABLES) {
      const pool = ITEMS.filter((i) => table.poolCategories.includes(i.category));
      expect(pool.length, `${table.crateId} has an empty pool`).toBeGreaterThan(0);
      // Every rarity the table can roll must have at least one item available.
      for (const rarity of Object.keys(table.rarityWeights) as Rarity[]) {
        const forRarity = pool.filter((i) => i.rarity === rarity);
        expect(forRarity.length, `${table.crateId} can roll ${rarity} but has no such item`).toBeGreaterThan(0);
      }
    }
  });
});

describe('content integrity', () => {
  it('every level reward references a real item', () => {
    for (const reward of LEVEL_REWARDS) {
      for (const id of reward.itemIds) {
        const exists = getItem(id) ?? getWeapon(id) ?? getAttachment(id) ?? getCharacter(id);
        expect(exists, `level ${reward.level} grants unknown item ${id}`).toBeDefined();
      }
    }
  });

  it('every quest reward references a real item', () => {
    for (const q of ALL_QUESTS) {
      for (const id of q.reward.itemIds) {
        const exists = getItem(id) ?? getWeapon(id) ?? getAttachment(id) ?? getCharacter(id);
        expect(exists, `quest ${q.id} grants unknown item ${id}`).toBeDefined();
      }
      expect(q.objectives.length, `quest ${q.id} has no objectives`).toBeGreaterThan(0);
      for (const o of q.objectives) {
        expect(o.count, `quest ${q.id} objective count`).toBeGreaterThan(0);
      }
    }
  });

  it('quest prerequisites reference real quests', () => {
    for (const q of ALL_QUESTS) {
      if (!q.requiresQuestId) continue;
      expect(getQuest(q.requiresQuestId), `quest ${q.id} requires unknown ${q.requiresQuestId}`).toBeDefined();
    }
  });

  it('quest ids are unique', () => {
    const ids = ALL_QUESTS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has enough daily and weekly quests to roll a varied set', () => {
    expect(DAILY_QUEST_POOL.length).toBeGreaterThanOrEqual(6);
    expect(WEEKLY_QUEST_POOL.length).toBeGreaterThanOrEqual(3);
  });

  it('achievement rewards reference real items', () => {
    for (const a of ACHIEVEMENTS) {
      for (const id of a.reward.itemIds) {
        const exists = getItem(id) ?? getWeapon(id) ?? getAttachment(id) ?? getCharacter(id);
        expect(exists, `achievement ${a.id} grants unknown item ${id}`).toBeDefined();
      }
    }
  });

  it('game modes have coherent settings', () => {
    for (const m of GAME_MODES) {
      expect(m.maxPlayers).toBeGreaterThanOrEqual(m.minPlayers);
      if (m.teamBased) expect(m.teamSize * 2).toBeGreaterThanOrEqual(m.maxPlayers);
      if (m.roundBased) {
        expect(m.roundsToWin).toBeGreaterThan(0);
        expect(m.roundTimeSec).toBeGreaterThan(0);
      } else {
        expect(m.scoreLimit > 0 || m.timeLimitSec > 0, `${m.id} has no win condition`).toBe(true);
      }
      if (!m.respawnEnabled) expect(m.roundBased, `${m.id} has no respawn and no rounds`).toBe(true);
    }
  });
});

describe('maps', () => {
  it('every combat map has spawns for both teams and a usable collision world', () => {
    for (const map of MAPS) {
      if (map.id === 'titan_hub') continue;
      const alpha = map.spawns.filter((s) => s.team === 1);
      const bravo = map.spawns.filter((s) => s.team === 2);
      expect(alpha.length, `${map.id} has no Alpha spawns`).toBeGreaterThan(2);
      expect(bravo.length, `${map.id} has no Bravo spawns`).toBeGreaterThan(2);

      const world = new CollisionWorld(volumesToBrushes(map.volumes));
      expect(world.brushCount, `${map.id} has no collision`).toBeGreaterThan(50);
    }
  });

  it('no spawn point is buried inside geometry', () => {
    for (const map of MAPS) {
      const world = new CollisionWorld(volumesToBrushes(map.volumes));
      for (const spawn of map.spawns) {
        const min = { x: spawn.at.x - 0.4, y: spawn.at.y + 0.05, z: spawn.at.z - 0.4 };
        const max = { x: spawn.at.x + 0.4, y: spawn.at.y + 1.75, z: spawn.at.z + 0.4 };
        expect(
          world.overlapsAny(min, max),
          `${map.id} spawn at ${spawn.at.x},${spawn.at.y},${spawn.at.z} is inside geometry`,
        ).toBe(false);
      }
    }
  });

  it('every spawn is inside the map bounds', () => {
    for (const map of MAPS) {
      for (const s of map.spawns) {
        expect(s.at.x).toBeGreaterThanOrEqual(map.bounds.min.x);
        expect(s.at.x).toBeLessThanOrEqual(map.bounds.max.x);
        expect(s.at.z).toBeGreaterThanOrEqual(map.bounds.min.z);
        expect(s.at.z).toBeLessThanOrEqual(map.bounds.max.z);
      }
    }
  });

  it('combat maps provide varied engagement ranges and routes', () => {
    for (const map of MAPS) {
      if (map.id === 'titan_hub') continue;
      const tags = new Set(map.zones.flatMap((z) => z.tags));
      // A map that is all one range is a bad FPS map.
      const rangeTags = [ZoneTag.CloseRange, ZoneTag.MidRange, ZoneTag.LongRange].filter((t) => tags.has(t));
      expect(rangeTags.length, `${map.id} lacks engagement variety`).toBeGreaterThanOrEqual(2);
      expect(tags.has(ZoneTag.HighGround), `${map.id} has no high ground`).toBe(true);
      expect(tags.has(ZoneTag.Secret), `${map.id} has no secret area`).toBe(true);
      expect(map.backdrop.length, `${map.id} has an empty horizon`).toBeGreaterThan(2);
      expect(map.lights.length, `${map.id} has no lighting`).toBeGreaterThan(3);
    }
  });

  it('every objective sits inside the map bounds', () => {
    for (const map of MAPS) {
      for (const o of map.objectives) {
        expect(o.at.x).toBeGreaterThanOrEqual(map.bounds.min.x);
        expect(o.at.x).toBeLessThanOrEqual(map.bounds.max.x);
        expect(o.radius).toBeGreaterThan(0);
      }
    }
  });

  it('every secret anchor maps to a secret quest', () => {
    for (const map of MAPS) {
      for (const s of map.secrets) {
        expect(getQuest(s.unlocksId), `${map.id} secret ${s.id} points at unknown quest`).toBeDefined();
      }
    }
  });
});
