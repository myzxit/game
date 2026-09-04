/**
 * Player profile schema and migrations.
 *
 * The saved shape is versioned. `migrate()` walks an old profile forward one
 * version at a time, so a save written by any previous build still loads. This
 * is the difference between "we can ship an update" and "we wipe everyone's
 * progress".
 */

import {
  SAVE_SCHEMA_VERSION,
  Currency,
  DEFAULT_LOADOUT,
  ECONOMY,
  STARTER_WEAPON_IDS,
  DEFAULT_CHARACTER_ID,
  cloneLoadout,
  type Loadout,
} from '@titan/shared';

export interface QuestProgress {
  questId: string;
  /** One entry per objective. */
  progress: number[];
  completed: boolean;
  claimed: boolean;
  /** Secret quests are hidden until this flips. */
  discovered: boolean;
  /** UTC day/week index this instance was rolled for. */
  periodIndex: number;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  assists: number;
  wins: number;
  losses: number;
  headshots: number;
  damageDealt: number;
  shotsFired: number;
  shotsHit: number;
  playtimeMs: number;
  matchesPlayed: number;
  bestStreak: number;
  bestScore: number;
  /** kills per weapon id — powers the "favourite weapon" stat. */
  weaponKills: Record<string, number>;
  /** matches played per mode id. */
  modeMatches: Record<string, number>;
  vehicleDistance: number;
  skillUses: Record<string, number>;
}

export interface PlayerProfile {
  version: number;
  id: string;
  displayName: string;
  createdAt: number;
  lastSeenAt: number;

  /** Progression. */
  totalXp: number;
  rankPoints: number;
  /** Ranked placement matches remaining before a rank is shown. */
  placementsRemaining: number;
  seasonId: string | null;
  seasonXp: number;
  claimedSeasonLevels: number[];
  claimedLevelRewards: number[];

  /** Economy. */
  currencies: Record<Currency, number>;
  /** Coins earned from matches today — enforces the daily cap. */
  dailyCoinsEarned: number;
  dailyCoinsDayIndex: number;

  /** Ownership. */
  ownedWeaponIds: string[];
  ownedAttachmentIds: string[];
  ownedCharacterIds: string[];
  ownedItemIds: string[];
  unlockedTitleIds: string[];
  equippedTitleId: string | null;
  loadout: Loadout;

  /** Quests and achievements. */
  quests: QuestProgress[];
  achievementProgress: Record<string, number>;
  unlockedAchievementIds: string[];
  discoveredSecretIds: string[];
  /** Crate opens since the last item at or above the pity rarity, per crate. */
  cratePity: Record<string, number>;

  /** Login streak. */
  loginStreak: number;
  lastLoginDayIndex: number;
  claimedLoginDayIndex: number;

  /** Social. */
  friendIds: string[];
  blockedIds: string[];

  /** Client settings, stored opaquely (validated for size/shape on ingest). */
  settings: Record<string, unknown>;

  stats: PlayerStats;

  /** Anti-cheat strike count; purely informational for operators. */
  strikes: number;
}

export function emptyStats(): PlayerStats {
  return {
    kills: 0,
    deaths: 0,
    assists: 0,
    wins: 0,
    losses: 0,
    headshots: 0,
    damageDealt: 0,
    shotsFired: 0,
    shotsHit: 0,
    playtimeMs: 0,
    matchesPlayed: 0,
    bestStreak: 0,
    bestScore: 0,
    weaponKills: {},
    modeMatches: {},
    vehicleDistance: 0,
    skillUses: {},
  };
}

export function createProfile(id: string, displayName: string, now: number): PlayerProfile {
  return {
    version: SAVE_SCHEMA_VERSION,
    id,
    displayName,
    createdAt: now,
    lastSeenAt: now,

    totalXp: 0,
    rankPoints: 0,
    placementsRemaining: 5,
    seasonId: null,
    seasonXp: 0,
    claimedSeasonLevels: [],
    claimedLevelRewards: [],

    currencies: {
      [Currency.Coins]: ECONOMY.startingCoins,
      [Currency.Cores]: ECONOMY.startingCores,
    },
    dailyCoinsEarned: 0,
    dailyCoinsDayIndex: 0,

    // New players own the free weapons and the baseline character outright, so
    // the first match is never gated behind a shop visit.
    ownedWeaponIds: [...STARTER_WEAPON_IDS],
    ownedAttachmentIds: [],
    ownedCharacterIds: [DEFAULT_CHARACTER_ID],
    ownedItemIds: [],
    unlockedTitleIds: [],
    equippedTitleId: null,
    loadout: cloneLoadout(DEFAULT_LOADOUT),

    quests: [],
    achievementProgress: {},
    unlockedAchievementIds: [],
    discoveredSecretIds: [],
    cratePity: {},

    loginStreak: 0,
    lastLoginDayIndex: -1,
    claimedLoginDayIndex: -1,

    friendIds: [],
    blockedIds: [],

    settings: {},
    stats: emptyStats(),
    strikes: 0,
  };
}

// --------------------------------------------------------------- migrations

type Migration = (p: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations are keyed by the version they upgrade *from*.
 * Each one must be idempotent-safe and must never throw on unexpected input —
 * a corrupt field is repaired, not fatal.
 */
const MIGRATIONS: Record<number, Migration> = {
  // v1 -> v2: split the single `ownedIds` array into typed ownership lists and
  // introduced the second currency.
  1: (p) => {
    const owned = Array.isArray(p.ownedIds) ? (p.ownedIds as string[]) : [];
    return {
      ...p,
      version: 2,
      ownedWeaponIds: p.ownedWeaponIds ?? owned,
      ownedAttachmentIds: p.ownedAttachmentIds ?? [],
      ownedCharacterIds: p.ownedCharacterIds ?? [DEFAULT_CHARACTER_ID],
      ownedItemIds: p.ownedItemIds ?? [],
      currencies:
        typeof p.currencies === 'object' && p.currencies !== null
          ? p.currencies
          : { [Currency.Coins]: typeof p.coins === 'number' ? p.coins : 0, [Currency.Cores]: 0 },
    };
  },

  // v2 -> v3: added seasons, secret discovery, crate pity and the daily coin cap.
  2: (p) => ({
    ...p,
    version: 3,
    seasonId: p.seasonId ?? null,
    seasonXp: typeof p.seasonXp === 'number' ? p.seasonXp : 0,
    claimedSeasonLevels: Array.isArray(p.claimedSeasonLevels) ? p.claimedSeasonLevels : [],
    claimedLevelRewards: Array.isArray(p.claimedLevelRewards) ? p.claimedLevelRewards : [],
    discoveredSecretIds: Array.isArray(p.discoveredSecretIds) ? p.discoveredSecretIds : [],
    cratePity: typeof p.cratePity === 'object' && p.cratePity !== null ? p.cratePity : {},
    dailyCoinsEarned: typeof p.dailyCoinsEarned === 'number' ? p.dailyCoinsEarned : 0,
    dailyCoinsDayIndex: typeof p.dailyCoinsDayIndex === 'number' ? p.dailyCoinsDayIndex : 0,
    placementsRemaining: typeof p.placementsRemaining === 'number' ? p.placementsRemaining : 5,
    strikes: typeof p.strikes === 'number' ? p.strikes : 0,
  }),
};

export interface MigrationResult {
  profile: PlayerProfile;
  /** Versions the profile was walked through. Logged for operator visibility. */
  applied: number[];
  /** True when fields had to be repaired because they were missing or corrupt. */
  repaired: boolean;
}

/**
 * Walk a stored profile up to the current schema version and repair anything
 * missing. Returns a profile that is guaranteed structurally valid.
 */
export function migrate(raw: unknown, fallbackId: string, now: number): MigrationResult {
  const applied: number[] = [];

  if (typeof raw !== 'object' || raw === null) {
    return { profile: createProfile(fallbackId, 'Operator', now), applied, repaired: true };
  }

  let p = { ...(raw as Record<string, unknown>) };
  let version = typeof p.version === 'number' ? p.version : 1;

  while (version < SAVE_SCHEMA_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      // No path forward from this version — start clean rather than load a
      // profile we cannot reason about.
      return { profile: createProfile(fallbackId, 'Operator', now), applied, repaired: true };
    }
    p = migration(p);
    applied.push(version);
    const next = typeof p.version === 'number' ? p.version : version + 1;
    if (next <= version) break; // guard against a migration that fails to advance
    version = next;
  }

  const { profile, repaired } = repair(p, fallbackId, now);
  return { profile, applied, repaired: repaired || applied.length > 0 };
}

/** Fill in and clamp every field, so downstream code never sees undefined. */
function repair(
  p: Record<string, unknown>,
  fallbackId: string,
  now: number,
): { profile: PlayerProfile; repaired: boolean } {
  let repaired = false;
  const base = createProfile(
    typeof p.id === 'string' && p.id.length > 0 ? p.id : fallbackId,
    typeof p.displayName === 'string' ? p.displayName : 'Operator',
    now,
  );

  const num = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      repaired = true;
      return fallback;
    }
    const clamped = Math.min(max, Math.max(min, v));
    if (clamped !== v) repaired = true;
    return clamped;
  };

  const strArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) {
      repaired = true;
      return [];
    }
    const out = v.filter((x): x is string => typeof x === 'string');
    if (out.length !== v.length) repaired = true;
    return out;
  };

  const numArray = (v: unknown): number[] => {
    if (!Array.isArray(v)) {
      repaired = true;
      return [];
    }
    return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  };

  const record = (v: unknown): Record<string, number> => {
    if (typeof v !== 'object' || v === null) {
      repaired = true;
      return {};
    }
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    }
    return out;
  };

  const storedStats = (typeof p.stats === 'object' && p.stats !== null ? p.stats : {}) as Record<
    string,
    unknown
  >;

  const stats: PlayerStats = {
    ...emptyStats(),
    kills: num(storedStats.kills, 0),
    deaths: num(storedStats.deaths, 0),
    assists: num(storedStats.assists, 0),
    wins: num(storedStats.wins, 0),
    losses: num(storedStats.losses, 0),
    headshots: num(storedStats.headshots, 0),
    damageDealt: num(storedStats.damageDealt, 0),
    shotsFired: num(storedStats.shotsFired, 0),
    shotsHit: num(storedStats.shotsHit, 0),
    playtimeMs: num(storedStats.playtimeMs, 0),
    matchesPlayed: num(storedStats.matchesPlayed, 0),
    bestStreak: num(storedStats.bestStreak, 0),
    bestScore: num(storedStats.bestScore, 0),
    weaponKills: record(storedStats.weaponKills ?? {}),
    modeMatches: record(storedStats.modeMatches ?? {}),
    vehicleDistance: num(storedStats.vehicleDistance, 0),
    skillUses: record(storedStats.skillUses ?? {}),
  };

  const storedCurrencies = (
    typeof p.currencies === 'object' && p.currencies !== null ? p.currencies : {}
  ) as Record<string, unknown>;

  const quests: QuestProgress[] = Array.isArray(p.quests)
    ? (p.quests as unknown[])
        .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
        .map((q) => ({
          questId: typeof q.questId === 'string' ? q.questId : '',
          progress: numArray(q.progress),
          completed: q.completed === true,
          claimed: q.claimed === true,
          discovered: q.discovered !== false,
          periodIndex: typeof q.periodIndex === 'number' ? q.periodIndex : 0,
        }))
        .filter((q) => q.questId.length > 0)
    : [];

  const loadout =
    typeof p.loadout === 'object' && p.loadout !== null
      ? ({ ...base.loadout, ...(p.loadout as object) } as Loadout)
      : base.loadout;

  const profile: PlayerProfile = {
    version: SAVE_SCHEMA_VERSION,
    id: base.id,
    displayName: base.displayName,
    createdAt: num(p.createdAt, now),
    lastSeenAt: num(p.lastSeenAt, now),

    totalXp: num(p.totalXp, 0),
    rankPoints: num(p.rankPoints, 0, 0, 100000),
    placementsRemaining: num(p.placementsRemaining, 5, 0, 20),
    seasonId: typeof p.seasonId === 'string' ? p.seasonId : null,
    seasonXp: num(p.seasonXp, 0),
    claimedSeasonLevels: numArray(p.claimedSeasonLevels ?? []),
    claimedLevelRewards: numArray(p.claimedLevelRewards ?? []),

    currencies: {
      [Currency.Coins]: num(storedCurrencies[Currency.Coins], 0, 0, ECONOMY.maxCoins),
      [Currency.Cores]: num(storedCurrencies[Currency.Cores], 0, 0, ECONOMY.maxCores),
    },
    dailyCoinsEarned: num(p.dailyCoinsEarned, 0),
    dailyCoinsDayIndex: num(p.dailyCoinsDayIndex, 0),

    ownedWeaponIds: strArray(p.ownedWeaponIds ?? base.ownedWeaponIds),
    ownedAttachmentIds: strArray(p.ownedAttachmentIds ?? []),
    ownedCharacterIds: strArray(p.ownedCharacterIds ?? base.ownedCharacterIds),
    ownedItemIds: strArray(p.ownedItemIds ?? []),
    unlockedTitleIds: strArray(p.unlockedTitleIds ?? []),
    equippedTitleId: typeof p.equippedTitleId === 'string' ? p.equippedTitleId : null,
    loadout,

    quests,
    achievementProgress: record(p.achievementProgress ?? {}),
    unlockedAchievementIds: strArray(p.unlockedAchievementIds ?? []),
    discoveredSecretIds: strArray(p.discoveredSecretIds ?? []),
    cratePity: record(p.cratePity ?? {}),

    loginStreak: num(p.loginStreak, 0, 0, 10000),
    lastLoginDayIndex: num(p.lastLoginDayIndex, -1, -1),
    claimedLoginDayIndex: num(p.claimedLoginDayIndex, -1, -1),

    friendIds: strArray(p.friendIds ?? []),
    blockedIds: strArray(p.blockedIds ?? []),

    settings:
      typeof p.settings === 'object' && p.settings !== null
        ? (p.settings as Record<string, unknown>)
        : {},

    stats,
    strikes: num(p.strikes, 0),
  };

  // Ownership floor: a profile must always be able to field a legal loadout,
  // even if the stored lists were emptied by corruption.
  for (const id of STARTER_WEAPON_IDS) {
    if (!profile.ownedWeaponIds.includes(id)) {
      profile.ownedWeaponIds.push(id);
      repaired = true;
    }
  }
  if (!profile.ownedCharacterIds.includes(DEFAULT_CHARACTER_ID)) {
    profile.ownedCharacterIds.push(DEFAULT_CHARACTER_ID);
    repaired = true;
  }

  return { profile, repaired };
}
