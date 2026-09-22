/**
 * Quests, dailies, weeklies, secrets and achievements.
 *
 * One generic tracker rather than per-quest code: gameplay emits typed
 * `QuestEvent`s, and every active objective whose type and target match
 * advances. Adding a quest is a data edit in `config/quests.ts`.
 *
 * Daily and weekly sets are *rolled deterministically* from (playerId, period),
 * so a player gets a stable personal set for the day without the server storing
 * a schedule, and re-rolling on reconnect is impossible.
 */

import {
  ACHIEVEMENTS,
  createLogger,
  Currency,
  DAILY_QUEST_COUNT,
  DAILY_QUEST_POOL,
  ErrorCode,
  fail,
  getAchievement,
  getQuest,
  hashString,
  levelFromTotalXp,
  mixSeeds,
  ObjectiveType,
  ok,
  QuestKind,
  Rng,
  SECRET_QUESTS,
  STORY_QUESTS,
  utcDayIndex,
  utcWeekIndex,
  WEEKLY_QUEST_COUNT,
  WEEKLY_QUEST_POOL,
  type QuestDefinition,
  type QuestObjective,
  type Result,
} from '@titan/shared';
import type { PlayerProfile, QuestProgress } from '../data/schema.js';
import type { EconomyService } from './EconomyService.js';
import type { InventoryService } from './InventoryService.js';
import type { ProfileService } from './ProfileService.js';
import type { ProgressionService } from './ProgressionService.js';

const log = createLogger('Quests');

/** A gameplay occurrence that quests can count. */
export interface QuestEvent {
  type: ObjectiveType;
  /** Weapon id, weapon class, mode id, zone id, npc id, secret id… */
  target?: string;
  /** How much to add. Defaults to 1. */
  amount?: number;
  /** Compared against an objective's `threshold` (streak length, distance…). */
  value?: number;
}

export interface QuestCompletion {
  questId: string;
  kind: QuestKind;
  nameKey: string;
}

export interface ClaimResult {
  questId: string;
  xp: number;
  coins: number;
  cores: number;
  seasonXp: number;
  itemsGranted: string[];
}

export class QuestService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly economy: EconomyService,
    private readonly inventory: InventoryService,
    private readonly progression: ProgressionService,
  ) {}

  // ------------------------------------------------------------- rotation --

  /** The three dailies this player has today. Deterministic, not stored. */
  dailySet(profile: PlayerProfile, now = Date.now()): QuestDefinition[] {
    const day = utcDayIndex(now);
    const level = levelFromTotalXp(profile.totalXp).level;
    const eligible = DAILY_QUEST_POOL.filter((q) => level >= q.unlockLevel);
    if (eligible.length === 0) return [];
    const rng = new Rng(mixSeeds(hashString(profile.id), day, 0x0da1));
    return rng.sample(eligible, Math.min(DAILY_QUEST_COUNT, eligible.length));
  }

  weeklySet(profile: PlayerProfile, now = Date.now()): QuestDefinition[] {
    const week = utcWeekIndex(now);
    const level = levelFromTotalXp(profile.totalXp).level;
    const eligible = WEEKLY_QUEST_POOL.filter((q) => level >= q.unlockLevel);
    if (eligible.length === 0) return [];
    const rng = new Rng(mixSeeds(hashString(profile.id), week, 0x0eb1));
    return rng.sample(eligible, Math.min(WEEKLY_QUEST_COUNT, eligible.length));
  }

  /** Story quests whose prerequisite is met and which aren't finished. */
  storySet(profile: PlayerProfile): QuestDefinition[] {
    return STORY_QUESTS.filter((q) => {
      if (q.requiresQuestId && !this.isComplete(profile, q.requiresQuestId)) return false;
      return true;
    });
  }

  /** Secret quests the player has discovered. */
  secretSet(profile: PlayerProfile): QuestDefinition[] {
    return SECRET_QUESTS.filter((q) => {
      const entry = profile.quests.find((e) => e.questId === q.id);
      if (!entry?.discovered) return false;
      if (q.requiresQuestId && !this.isComplete(profile, q.requiresQuestId)) return false;
      return true;
    });
  }

  /**
   * Bring the profile's quest entries in line with the current period.
   * Expired dailies/weeklies are dropped (unclaimed rewards are forfeit, which
   * is why the UI nags about unclaimed contracts); new ones are seeded at zero.
   */
  refresh(profile: PlayerProfile, now = Date.now()): void {
    const day = utcDayIndex(now);
    const week = utcWeekIndex(now);

    const wanted = new Map<string, { def: QuestDefinition; period: number }>();
    for (const q of this.dailySet(profile, now)) wanted.set(q.id, { def: q, period: day });
    for (const q of this.weeklySet(profile, now)) wanted.set(q.id, { def: q, period: week });
    for (const q of this.storySet(profile)) wanted.set(q.id, { def: q, period: 0 });
    for (const q of SECRET_QUESTS) wanted.set(q.id, { def: q, period: 0 });

    // Drop entries that are no longer offered, or belong to a past period.
    profile.quests = profile.quests.filter((entry) => {
      const target = wanted.get(entry.questId);
      if (!target) return false;
      if (target.def.kind === QuestKind.Daily || target.def.kind === QuestKind.Weekly) {
        return entry.periodIndex === target.period;
      }
      return true;
    });

    const existing = new Set(profile.quests.map((q) => q.questId));
    for (const [id, { def, period }] of wanted) {
      if (existing.has(id)) continue;
      profile.quests.push({
        questId: id,
        progress: def.objectives.map(() => 0),
        completed: false,
        claimed: false,
        // Secrets stay hidden until a discovery event reveals them.
        discovered: def.kind !== QuestKind.Secret,
        periodIndex: period,
      });
    }

    this.profiles.markDirty(profile.id);
  }

  private entry(profile: PlayerProfile, questId: string): QuestProgress | undefined {
    return profile.quests.find((q) => q.questId === questId);
  }

  isComplete(profile: PlayerProfile, questId: string): boolean {
    return this.entry(profile, questId)?.completed === true;
  }

  // -------------------------------------------------------------- tracking --

  /** Does this event advance this objective? */
  private matches(objective: QuestObjective, event: QuestEvent): boolean {
    if (objective.type !== event.type) return false;
    if (objective.target !== undefined && objective.target !== event.target) return false;
    // Threshold objectives (streaks, long shots) only count when the event's
    // value clears the bar.
    if (objective.threshold !== undefined) {
      if (event.value === undefined || event.value < objective.threshold) return false;
    }
    return true;
  }

  /**
   * Apply an event to every active quest and achievement.
   * Returns the quests that became complete as a result.
   */
  track(profile: PlayerProfile, event: QuestEvent, now = Date.now()): QuestCompletion[] {
    const completed: QuestCompletion[] = [];
    const amount = Math.max(0, Math.floor(event.amount ?? 1));
    if (amount === 0 && event.value === undefined) return completed;

    for (const entry of profile.quests) {
      if (entry.completed || !entry.discovered) continue;
      const def = getQuest(entry.questId);
      if (!def) continue;
      if (def.requiresQuestId && !this.isComplete(profile, def.requiresQuestId)) continue;

      let changed = false;
      def.objectives.forEach((objective, i) => {
        if (!this.matches(objective, event)) return;
        const current = entry.progress[i] ?? 0;
        if (current >= objective.count) return;
        // A threshold objective is satisfied outright by one qualifying event.
        const add = objective.threshold !== undefined ? objective.count : amount;
        entry.progress[i] = Math.min(objective.count, current + add);
        changed = true;
      });

      if (!changed) continue;

      const allDone = def.objectives.every((o, i) => (entry.progress[i] ?? 0) >= o.count);
      if (allDone) {
        entry.completed = true;
        completed.push({ questId: def.id, kind: def.kind, nameKey: def.nameKey });
        log.info('quest complete', { playerId: profile.id, questId: def.id });
      }
    }

    this.trackAchievements(profile, event, now);
    this.profiles.markDirty(profile.id);
    return completed;
  }

  /** Convenience for emitting several events at once (end of match). */
  trackMany(profile: PlayerProfile, events: QuestEvent[], now = Date.now()): QuestCompletion[] {
    const out: QuestCompletion[] = [];
    for (const e of events) out.push(...this.track(profile, e, now));
    return out;
  }

  // ---------------------------------------------------------- achievements --

  private trackAchievements(profile: PlayerProfile, event: QuestEvent, now: number): string[] {
    const unlocked: string[] = [];
    const amount = Math.max(0, Math.floor(event.amount ?? 1));

    for (const ach of ACHIEVEMENTS) {
      if (profile.unlockedAchievementIds.includes(ach.id)) continue;
      if (!this.matches(ach.objective, event)) continue;

      const current = profile.achievementProgress[ach.id] ?? 0;
      const add = ach.objective.threshold !== undefined ? ach.objective.count : amount;
      const next = Math.min(ach.objective.count, current + add);
      profile.achievementProgress[ach.id] = next;

      if (next >= ach.objective.count) {
        profile.unlockedAchievementIds.push(ach.id);
        unlocked.push(ach.id);
        // Achievements pay out immediately — there is nothing to claim.
        this.payReward(profile, ach.reward, `achievement:${ach.id}`, now);
        log.info('achievement unlocked', { playerId: profile.id, achievementId: ach.id });
      }
    }
    return unlocked;
  }

  /**
   * Achievements that track cumulative lifetime stats rather than live events
   * (total kills, level reached, rank reached). Called after a match.
   */
  syncStatAchievements(profile: PlayerProfile, now = Date.now()): string[] {
    const events: QuestEvent[] = [
      { type: ObjectiveType.ReachLevel, value: levelFromTotalXp(profile.totalXp).level, amount: 0 },
      { type: ObjectiveType.CollectItem, amount: 0, value: this.inventory.collectionSize(profile) },
    ];

    const unlocked: string[] = [];
    for (const ach of ACHIEVEMENTS) {
      if (profile.unlockedAchievementIds.includes(ach.id)) continue;

      let value: number | null = null;
      switch (ach.objective.type) {
        case ObjectiveType.Kill:
          value = profile.stats.kills;
          break;
        case ObjectiveType.WinMatch:
          value = profile.stats.wins;
          break;
        case ObjectiveType.Headshot:
          value = profile.stats.headshots;
          break;
        case ObjectiveType.ReachLevel:
          value = levelFromTotalXp(profile.totalXp).level;
          break;
        case ObjectiveType.CollectItem:
          value = this.inventory.collectionSize(profile);
          break;
        case ObjectiveType.PressSecretButton:
          value = profile.discoveredSecretIds.length;
          break;
        default:
          value = null;
      }
      if (value === null) continue;

      profile.achievementProgress[ach.id] = Math.min(ach.objective.count, value);
      if (value >= ach.objective.count) {
        profile.unlockedAchievementIds.push(ach.id);
        unlocked.push(ach.id);
        this.payReward(profile, ach.reward, `achievement:${ach.id}`, now);
      }
    }
    void events;
    if (unlocked.length > 0) this.profiles.markDirty(profile.id);
    return unlocked;
  }

  // -------------------------------------------------------------- secrets --

  /**
   * Reveal a secret. Discovering a secret makes its quest visible and starts
   * tracking it — before that the quest log shows nothing at all.
   */
  discoverSecret(profile: PlayerProfile, secretId: string, questId: string | null, now = Date.now()): boolean {
    if (profile.discoveredSecretIds.includes(secretId)) return false;
    profile.discoveredSecretIds.push(secretId);

    if (questId) {
      let entry = this.entry(profile, questId);
      if (!entry) {
        const def = getQuest(questId);
        if (def) {
          entry = {
            questId,
            progress: def.objectives.map(() => 0),
            completed: false,
            claimed: false,
            discovered: true,
            periodIndex: 0,
          };
          profile.quests.push(entry);
        }
      } else {
        entry.discovered = true;
      }
    }

    log.info('secret discovered', { playerId: profile.id, secretId, questId });
    this.profiles.markDirty(profile.id);
    return true;
  }

  // --------------------------------------------------------------- claims --

  claim(profile: PlayerProfile, questId: string, now = Date.now()): Result<ClaimResult> {
    const entry = this.entry(profile, questId);
    if (!entry) return fail(ErrorCode.NotFound, `quest ${questId} not active`);
    if (!entry.completed) return fail(ErrorCode.Forbidden, `quest ${questId} is not complete`);
    if (entry.claimed) return fail(ErrorCode.AlreadyOwned, `quest ${questId} already claimed`);

    const def = getQuest(questId);
    if (!def) return fail(ErrorCode.NotFound, `unknown quest ${questId}`);

    // Mark claimed *before* paying out, so a failure mid-payout cannot be
    // retried into a double reward.
    entry.claimed = true;
    const paid = this.payReward(profile, def.reward, `quest:${questId}`, now);
    this.profiles.markDirty(profile.id);

    return ok({ questId, ...paid });
  }

  private payReward(
    profile: PlayerProfile,
    reward: { xp: number; seasonXp: number; itemIds: string[]; currency: { currency: Currency; amount: number }[] },
    reason: string,
    now: number,
  ): { xp: number; coins: number; cores: number; seasonXp: number; itemsGranted: string[] } {
    let coins = 0;
    let cores = 0;
    for (const c of reward.currency) {
      const r = this.economy.grant(profile, c.currency, c.amount, { reason }, now);
      if (!r.ok) continue;
      if (c.currency === Currency.Coins) coins += r.value;
      else cores += r.value;
    }
    const itemsGranted = this.inventory.grantMany(profile, reward.itemIds);
    if (reward.xp > 0 || reward.seasonXp > 0) {
      this.progression.awardXp(profile, { amount: reward.xp, reason, seasonXp: reward.seasonXp }, now);
    }
    return { xp: reward.xp, coins, cores, seasonXp: reward.seasonXp, itemsGranted };
  }

  // ----------------------------------------------------------- presentation --

  /** Quest state for the client, with secrets filtered out until discovered. */
  snapshot(profile: PlayerProfile, now = Date.now()) {
    const quests = profile.quests
      .filter((entry) => {
        const def = getQuest(entry.questId);
        if (!def) return false;
        return def.kind !== QuestKind.Secret || entry.discovered;
      })
      .map((entry) => {
        const def = getQuest(entry.questId)!;
        return {
          id: entry.questId,
          kind: def.kind as string,
          progress: entry.progress.slice(),
          completed: entry.completed,
          claimed: entry.claimed,
          discovered: entry.discovered,
        };
      });

    const day = utcDayIndex(now);
    const week = utcWeekIndex(now);
    return {
      quests,
      dailyResetAtMs: (day + 1) * 86_400_000,
      weeklyResetAtMs: ((week + 1) * 7 - 4) * 86_400_000,
    };
  }

  /** Unclaimed completed quests — used to nag before a daily reset. */
  unclaimedCount(profile: PlayerProfile): number {
    return profile.quests.filter((q) => q.completed && !q.claimed).length;
  }
}

export { getAchievement };
