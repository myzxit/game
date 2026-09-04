/**
 * Localization guard rails.
 *
 * The English bundle is the fallback for every other language, so a key missing
 * there renders as a raw key in the UI. These tests keep the bundles in sync and
 * make sure every content definition points at a string that actually exists.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ko,
  en,
  t,
  tp,
  setLocale,
  getLocale,
  availableLocales,
  formatDuration,
  formatNumber,
  DEFAULT_LOCALE,
  WEAPONS,
  ATTACHMENTS,
  CHARACTERS,
  SKILLS,
  ITEMS,
  MAPS,
  GAME_MODES,
  NPCS,
  VEHICLES,
  ALL_QUESTS,
  ACHIEVEMENTS,
  RANK_TIERS,
  Rarity,
} from '../src/index.js';

beforeEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe('locale bundles', () => {
  it('Korean is the default and both bundles are registered', () => {
    expect(DEFAULT_LOCALE).toBe('ko');
    const ids = availableLocales().map((l) => l.id);
    expect(ids).toContain('ko');
    expect(ids).toContain('en');
  });

  it('every Korean key exists in English (the fallback chain)', () => {
    const missing = Object.keys(ko).filter((k) => !(k in en));
    expect(missing, `missing English strings: ${missing.slice(0, 20).join(', ')}`).toEqual([]);
  });

  it('every English key exists in Korean', () => {
    const missing = Object.keys(en).filter((k) => !(k in ko));
    expect(missing, `missing Korean strings: ${missing.slice(0, 20).join(', ')}`).toEqual([]);
  });

  it('placeholders match between the two languages', () => {
    const placeholders = (s: string): string[] =>
      (s.match(/\{(\w+)\}/g) ?? []).sort();

    for (const key of Object.keys(ko)) {
      const a = placeholders(ko[key]!);
      const b = placeholders(en[key] ?? '');
      expect(a, `placeholder mismatch for ${key}`).toEqual(b);
    }
  });

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(ko)) {
      expect(value.length, `empty ko string: ${key}`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, `empty en string: ${key}`).toBeGreaterThan(0);
    }
  });
});

describe('t()', () => {
  it('returns the localized string', () => {
    expect(t('common.ok')).toBe(ko['common.ok']);
    setLocale('en');
    expect(t('common.ok')).toBe(en['common.ok']);
  });

  it('interpolates parameters', () => {
    setLocale('en');
    expect(t('common.level_required', { level: 12 })).toBe('Requires level 12');
  });

  it('leaves unknown placeholders untouched rather than blanking them', () => {
    setLocale('en');
    expect(t('common.level_required', {})).toContain('{level}');
  });

  it('returns the key itself when a string is missing, so gaps are visible', () => {
    expect(t('this.key.does.not.exist')).toBe('this.key.does.not.exist');
  });

  it('falls back from Korean to English', () => {
    // A key present only in English must still resolve when the locale is ko.
    const enOnlyKey = '__test_en_only__';
    en[enOnlyKey] = 'fallback value';
    try {
      setLocale('ko');
      expect(t(enOnlyKey)).toBe('fallback value');
    } finally {
      delete en[enOnlyKey];
    }
  });

  it('setLocale rejects an unregistered locale and keeps the current one', () => {
    setLocale('ko');
    expect(setLocale('ja')).toBe(false);
    expect(getLocale()).toBe('ko');
  });

  it('tp falls back to the singular key when no plural form exists', () => {
    setLocale('en');
    expect(tp('result.kills', 3)).toBe(en['result.kills']);
  });
});

describe('formatting', () => {
  it('formats durations as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('formats numbers with separators', () => {
    setLocale('en');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('content strings exist', () => {
  const expectKey = (key: string, owner: string) => {
    expect(key in ko, `${owner} references missing ko key: ${key}`).toBe(true);
  };

  it('weapons', () => {
    for (const w of WEAPONS) {
      expectKey(w.nameKey, w.id);
      expectKey(w.descriptionKey, w.id);
      expectKey(`weapon.class.${w.class}`, w.id);
    }
  });

  it('attachments', () => {
    for (const a of ATTACHMENTS) {
      expectKey(a.nameKey, a.id);
      expectKey(a.descriptionKey, a.id);
      expectKey(`attachment.slot.${a.slot}`, a.id);
    }
  });

  it('characters and skills', () => {
    for (const c of CHARACTERS) {
      expectKey(c.nameKey, c.id);
      expectKey(c.descriptionKey, c.id);
    }
    for (const s of SKILLS) {
      expectKey(s.nameKey, s.id);
      expectKey(s.descriptionKey, s.id);
      expectKey(`skill.category.${s.category}`, s.id);
      for (const up of s.upgrades) expectKey(up.descriptionKey, s.id);
    }
  });

  it('items and rarities', () => {
    for (const i of ITEMS) {
      expectKey(i.nameKey, i.id);
    }
    for (const r of Object.values(Rarity)) {
      expectKey(`rarity.${r}`, 'rarity');
    }
  });

  it('maps, modes and zones', () => {
    for (const m of MAPS) {
      expectKey(m.nameKey, m.id);
      expectKey(m.descriptionKey, m.id);
      for (const z of m.zones) expectKey(z.nameKey, `${m.id}:${z.id}`);
      for (const o of m.objectives) expectKey(o.nameKey, `${m.id}:${o.id}`);
    }
    for (const g of GAME_MODES) {
      expectKey(g.nameKey, g.id);
      expectKey(g.descriptionKey, g.id);
    }
  });

  it('npcs and dialogue', () => {
    for (const n of NPCS) {
      expectKey(n.nameKey, n.id);
      expectKey(n.roleKey, n.id);
      for (const node of n.dialogue) {
        expectKey(node.textKey, `${n.id}:${node.id}`);
        for (const opt of node.options) expectKey(opt.textKey, `${n.id}:${node.id}`);
      }
    }
  });

  it('vehicles', () => {
    for (const v of VEHICLES) {
      expectKey(v.nameKey, v.id);
      expectKey(v.descriptionKey, v.id);
    }
  });

  it('quests, objectives and achievements', () => {
    for (const q of ALL_QUESTS) {
      expectKey(q.nameKey, q.id);
      expectKey(q.descriptionKey, q.id);
      for (const o of q.objectives) expectKey(o.descriptionKey, q.id);
    }
    for (const a of ACHIEVEMENTS) {
      expectKey(a.nameKey, a.id);
      expectKey(a.descriptionKey, a.id);
    }
  });

  it('rank tiers', () => {
    for (const r of RANK_TIERS) expectKey(r.nameKey, r.id);
  });
});

describe('dialogue graph integrity', () => {
  it('every dialogue option points at a node that exists', () => {
    for (const npc of NPCS) {
      const ids = new Set(npc.dialogue.map((d) => d.id));
      expect(ids.has(npc.rootNodeId), `${npc.id} has no root node`).toBe(true);
      for (const node of npc.dialogue) {
        for (const opt of node.options) {
          if (opt.next === null) continue;
          expect(ids.has(opt.next), `${npc.id}:${node.id} -> unknown node ${opt.next}`).toBe(true);
        }
      }
    }
  });

  it('every node is reachable from the root', () => {
    for (const npc of NPCS) {
      const seen = new Set<string>([npc.rootNodeId]);
      const queue = [npc.rootNodeId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        const node = npc.dialogue.find((d) => d.id === id);
        if (!node) continue;
        for (const opt of node.options) {
          if (opt.next && !seen.has(opt.next)) {
            seen.add(opt.next);
            queue.push(opt.next);
          }
        }
      }
      for (const node of npc.dialogue) {
        expect(seen.has(node.id), `${npc.id}:${node.id} is unreachable`).toBe(true);
      }
    }
  });

  it('every conversation can be exited', () => {
    for (const npc of NPCS) {
      const root = npc.dialogue.find((d) => d.id === npc.rootNodeId)!;
      const canExit = root.options.some((o) => o.next === null);
      expect(canExit, `${npc.id} root has no exit`).toBe(true);
    }
  });
});
