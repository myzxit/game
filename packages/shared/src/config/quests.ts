/**
 * Quests, dailies, weeklies, secret quests and achievements.
 *
 * Everything is expressed as (objective type, target, count) so the quest
 * engine is a single generic progress tracker rather than bespoke code per
 * quest. Adding a quest is a data edit.
 */

import { Currency } from '../types/domain.js';

/** What a quest objective counts. Combat events are emitted by the match. */
export enum ObjectiveType {
  Kill = 'kill',
  KillWithWeapon = 'kill_with_weapon',
  KillWithWeaponClass = 'kill_with_weapon_class',
  Headshot = 'headshot',
  KillStreak = 'kill_streak',
  MultiKill = 'multi_kill',
  Assist = 'assist',
  DealDamage = 'deal_damage',
  WinMatch = 'win_match',
  PlayMatch = 'play_match',
  PlayMode = 'play_mode',
  CaptureObjective = 'capture_objective',
  UseSkill = 'use_skill',
  SkillKill = 'skill_kill',
  CollectItem = 'collect_item',
  VisitZone = 'visit_zone',
  TalkToNpc = 'talk_to_npc',
  UseVehicle = 'use_vehicle',
  VehicleDistance = 'vehicle_distance',
  ReachRank = 'reach_rank',
  ReachLevel = 'reach_level',
  OpenCrate = 'open_crate',
  PressSecretButton = 'press_secret_button',
  SurviveRound = 'survive_round',
  LongShot = 'long_shot',
  ReviveOrSave = 'revive_or_save',
}

export interface QuestObjective {
  type: ObjectiveType;
  /** Weapon id, map id, mode id, zone id, npc id... depending on `type`. */
  target?: string;
  count: number;
  /** Extra constraint, e.g. minimum distance for LongShot. */
  threshold?: number;
  descriptionKey: string;
}

export interface QuestReward {
  xp: number;
  currency: { currency: Currency; amount: number }[];
  itemIds: string[];
  /** Season XP (battle-pass style progression). */
  seasonXp: number;
}

export enum QuestKind {
  Daily = 'daily',
  Weekly = 'weekly',
  Story = 'story',
  Secret = 'secret',
  Event = 'event',
}

export interface QuestDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  kind: QuestKind;
  objectives: QuestObjective[];
  reward: QuestReward;
  /** 1 = easy, 2 = medium, 3 = hard. Dailies roll a mix. */
  difficulty: 1 | 2 | 3;
  unlockLevel: number;
  /** Quest that must be completed first (story chains, secret follow-ups). */
  requiresQuestId?: string;
  /** Secret quests stay invisible in the quest log until discovered. */
  hidden?: boolean;
  /** NPC that gives/turns in this quest, if any. */
  npcId?: string;
  eventId?: string;
}

const reward = (xp: number, coins: number, seasonXp = 0, itemIds: string[] = [], cores = 0): QuestReward => ({
  xp,
  currency: [
    { currency: Currency.Coins, amount: coins },
    ...(cores > 0 ? [{ currency: Currency.Cores, amount: cores }] : []),
  ],
  itemIds,
  seasonXp,
});

// ------------------------------------------------------------- Dailies ----
// The daily pool. Three are rolled per UTC day, seeded by (playerId, dayIndex),
// so every player gets a stable but personal set.
export const DAILY_QUEST_POOL: readonly QuestDefinition[] = [
  {
    id: 'daily_eliminations',
    nameKey: 'quest.daily_eliminations.name',
    descriptionKey: 'quest.daily_eliminations.desc',
    kind: QuestKind.Daily,
    difficulty: 1,
    unlockLevel: 1,
    objectives: [{ type: ObjectiveType.Kill, count: 15, descriptionKey: 'objective.kill' }],
    reward: reward(500, 250, 200),
  },
  {
    id: 'daily_headhunter',
    nameKey: 'quest.daily_headhunter.name',
    descriptionKey: 'quest.daily_headhunter.desc',
    kind: QuestKind.Daily,
    difficulty: 2,
    unlockLevel: 1,
    objectives: [{ type: ObjectiveType.Headshot, count: 8, descriptionKey: 'objective.headshot' }],
    reward: reward(700, 350, 250),
  },
  {
    id: 'daily_rifleman',
    nameKey: 'quest.daily_rifleman.name',
    descriptionKey: 'quest.daily_rifleman.desc',
    kind: QuestKind.Daily,
    difficulty: 1,
    unlockLevel: 1,
    objectives: [
      { type: ObjectiveType.KillWithWeaponClass, target: 'assault_rifle', count: 10, descriptionKey: 'objective.kill_class' },
    ],
    reward: reward(500, 250, 200),
  },
  {
    id: 'daily_closequarters',
    nameKey: 'quest.daily_closequarters.name',
    descriptionKey: 'quest.daily_closequarters.desc',
    kind: QuestKind.Daily,
    difficulty: 2,
    unlockLevel: 1,
    objectives: [
      { type: ObjectiveType.KillWithWeaponClass, target: 'smg', count: 8, descriptionKey: 'objective.kill_class' },
      { type: ObjectiveType.KillWithWeaponClass, target: 'shotgun', count: 4, descriptionKey: 'objective.kill_class' },
    ],
    reward: reward(750, 380, 250),
  },
  {
    id: 'daily_marksman',
    nameKey: 'quest.daily_marksman.name',
    descriptionKey: 'quest.daily_marksman.desc',
    kind: QuestKind.Daily,
    difficulty: 3,
    unlockLevel: 12,
    objectives: [
      { type: ObjectiveType.LongShot, count: 5, threshold: 45, descriptionKey: 'objective.long_shot' },
    ],
    reward: reward(1000, 500, 350),
  },
  {
    id: 'daily_victor',
    nameKey: 'quest.daily_victor.name',
    descriptionKey: 'quest.daily_victor.desc',
    kind: QuestKind.Daily,
    difficulty: 2,
    unlockLevel: 1,
    objectives: [{ type: ObjectiveType.WinMatch, count: 2, descriptionKey: 'objective.win' }],
    reward: reward(800, 400, 300),
  },
  {
    id: 'daily_operator',
    nameKey: 'quest.daily_operator.name',
    descriptionKey: 'quest.daily_operator.desc',
    kind: QuestKind.Daily,
    difficulty: 1,
    unlockLevel: 1,
    objectives: [{ type: ObjectiveType.UseSkill, count: 12, descriptionKey: 'objective.use_skill' }],
    reward: reward(450, 220, 180),
  },
  {
    id: 'daily_support',
    nameKey: 'quest.daily_support.name',
    descriptionKey: 'quest.daily_support.desc',
    kind: QuestKind.Daily,
    difficulty: 1,
    unlockLevel: 1,
    objectives: [{ type: ObjectiveType.Assist, count: 10, descriptionKey: 'objective.assist' }],
    reward: reward(450, 220, 180),
  },
  {
    id: 'daily_objective',
    nameKey: 'quest.daily_objective.name',
    descriptionKey: 'quest.daily_objective.desc',
    kind: QuestKind.Daily,
    difficulty: 2,
    unlockLevel: 3,
    objectives: [{ type: ObjectiveType.CaptureObjective, count: 4, descriptionKey: 'objective.capture' }],
    reward: reward(700, 350, 250),
  },
  {
    id: 'daily_driver',
    nameKey: 'quest.daily_driver.name',
    descriptionKey: 'quest.daily_driver.desc',
    kind: QuestKind.Daily,
    difficulty: 1,
    unlockLevel: 5,
    objectives: [
      { type: ObjectiveType.VehicleDistance, count: 800, descriptionKey: 'objective.vehicle_distance' },
    ],
    reward: reward(450, 250, 180),
  },
  {
    id: 'daily_streak',
    nameKey: 'quest.daily_streak.name',
    descriptionKey: 'quest.daily_streak.desc',
    kind: QuestKind.Daily,
    difficulty: 3,
    unlockLevel: 8,
    objectives: [{ type: ObjectiveType.KillStreak, count: 1, threshold: 5, descriptionKey: 'objective.streak' }],
    reward: reward(1000, 500, 350),
  },
  {
    id: 'daily_damage',
    nameKey: 'quest.daily_damage.name',
    descriptionKey: 'quest.daily_damage.desc',
    kind: QuestKind.Daily,
    difficulty: 2,
    unlockLevel: 1,
    objectives: [{ type: ObjectiveType.DealDamage, count: 4000, descriptionKey: 'objective.damage' }],
    reward: reward(650, 320, 240),
  },
];

// ------------------------------------------------------------ Weeklies ----
export const WEEKLY_QUEST_POOL: readonly QuestDefinition[] = [
  {
    id: 'weekly_campaigner',
    nameKey: 'quest.weekly_campaigner.name',
    descriptionKey: 'quest.weekly_campaigner.desc',
    kind: QuestKind.Weekly,
    difficulty: 2,
    unlockLevel: 1,
    objectives: [{ type: ObjectiveType.PlayMatch, count: 20, descriptionKey: 'objective.play' }],
    reward: reward(3000, 1500, 1200, ['crate_standard']),
  },
  {
    id: 'weekly_champion',
    nameKey: 'quest.weekly_champion.name',
    descriptionKey: 'quest.weekly_champion.desc',
    kind: QuestKind.Weekly,
    difficulty: 3,
    unlockLevel: 1,
    objectives: [{ type: ObjectiveType.WinMatch, count: 10, descriptionKey: 'objective.win' }],
    reward: reward(4500, 2200, 1600, ['crate_standard']),
  },
  {
    id: 'weekly_arsenal',
    nameKey: 'quest.weekly_arsenal.name',
    descriptionKey: 'quest.weekly_arsenal.desc',
    kind: QuestKind.Weekly,
    difficulty: 3,
    unlockLevel: 10,
    objectives: [
      { type: ObjectiveType.KillWithWeaponClass, target: 'assault_rifle', count: 25, descriptionKey: 'objective.kill_class' },
      { type: ObjectiveType.KillWithWeaponClass, target: 'smg', count: 25, descriptionKey: 'objective.kill_class' },
      { type: ObjectiveType.KillWithWeaponClass, target: 'sniper', count: 15, descriptionKey: 'objective.kill_class' },
    ],
    reward: reward(5000, 2500, 1800, ['crate_premium']),
  },
  {
    id: 'weekly_headhunter',
    nameKey: 'quest.weekly_headhunter.name',
    descriptionKey: 'quest.weekly_headhunter.desc',
    kind: QuestKind.Weekly,
    difficulty: 3,
    unlockLevel: 5,
    objectives: [{ type: ObjectiveType.Headshot, count: 60, descriptionKey: 'objective.headshot' }],
    reward: reward(4000, 2000, 1500),
  },
  {
    id: 'weekly_explorer',
    nameKey: 'quest.weekly_explorer.name',
    descriptionKey: 'quest.weekly_explorer.desc',
    kind: QuestKind.Weekly,
    difficulty: 1,
    unlockLevel: 1,
    objectives: [
      { type: ObjectiveType.VisitZone, target: 'rooftops', count: 1, descriptionKey: 'objective.visit' },
      { type: ObjectiveType.VisitZone, target: 'tunnel', count: 1, descriptionKey: 'objective.visit' },
      { type: ObjectiveType.VisitZone, target: 'alley', count: 1, descriptionKey: 'objective.visit' },
    ],
    reward: reward(2500, 1200, 1000),
  },
];

// -------------------------------------------------------------- Story -----
// A short onboarding chain that teaches each system in order.
export const STORY_QUESTS: readonly QuestDefinition[] = [
  {
    id: 'story_first_steps',
    nameKey: 'quest.story_first_steps.name',
    descriptionKey: 'quest.story_first_steps.desc',
    kind: QuestKind.Story,
    difficulty: 1,
    unlockLevel: 1,
    npcId: 'npc_instructor',
    objectives: [{ type: ObjectiveType.PlayMatch, count: 1, descriptionKey: 'objective.play' }],
    reward: reward(400, 500, 0),
  },
  {
    id: 'story_first_blood',
    nameKey: 'quest.story_first_blood.name',
    descriptionKey: 'quest.story_first_blood.desc',
    kind: QuestKind.Story,
    difficulty: 1,
    unlockLevel: 1,
    requiresQuestId: 'story_first_steps',
    npcId: 'npc_instructor',
    objectives: [{ type: ObjectiveType.Kill, count: 5, descriptionKey: 'objective.kill' }],
    reward: reward(500, 600, 0),
  },
  {
    id: 'story_quartermaster',
    nameKey: 'quest.story_quartermaster.name',
    descriptionKey: 'quest.story_quartermaster.desc',
    kind: QuestKind.Story,
    difficulty: 1,
    unlockLevel: 1,
    requiresQuestId: 'story_first_blood',
    npcId: 'npc_quartermaster',
    objectives: [
      { type: ObjectiveType.TalkToNpc, target: 'npc_quartermaster', count: 1, descriptionKey: 'objective.talk' },
    ],
    reward: reward(300, 800, 0, ['optic_reflex']),
  },
  {
    id: 'story_specialist',
    nameKey: 'quest.story_specialist.name',
    descriptionKey: 'quest.story_specialist.desc',
    kind: QuestKind.Story,
    difficulty: 2,
    unlockLevel: 1,
    requiresQuestId: 'story_quartermaster',
    npcId: 'npc_instructor',
    objectives: [{ type: ObjectiveType.SkillKill, count: 3, descriptionKey: 'objective.skill_kill' }],
    reward: reward(800, 900, 0),
  },
  {
    id: 'story_proving_ground',
    nameKey: 'quest.story_proving_ground.name',
    descriptionKey: 'quest.story_proving_ground.desc',
    kind: QuestKind.Story,
    difficulty: 2,
    unlockLevel: 1,
    requiresQuestId: 'story_specialist',
    npcId: 'npc_dispatcher',
    objectives: [{ type: ObjectiveType.WinMatch, count: 1, descriptionKey: 'objective.win' }],
    reward: reward(1200, 1200, 0, ['crate_standard']),
  },
];

// ------------------------------------------------------------- Secrets ----
// Hidden until discovered. The quest log shows "???" placeholders only after
// the first step is triggered, so finding them is genuinely a discovery.
export const SECRET_QUESTS: readonly QuestDefinition[] = [
  {
    id: 'secret_foundry_vault',
    nameKey: 'quest.secret_foundry_vault.name',
    descriptionKey: 'quest.secret_foundry_vault.desc',
    kind: QuestKind.Secret,
    difficulty: 3,
    unlockLevel: 1,
    hidden: true,
    objectives: [
      { type: ObjectiveType.VisitZone, target: 'vault', count: 1, descriptionKey: 'objective.find_vault' },
      { type: ObjectiveType.PressSecretButton, target: 'vault_terminal', count: 1, descriptionKey: 'objective.terminal' },
    ],
    reward: reward(2500, 3000, 800, ['charm_foundry']),
  },
  {
    id: 'secret_quarter_backroom',
    nameKey: 'quest.secret_quarter_backroom.name',
    descriptionKey: 'quest.secret_quarter_backroom.desc',
    kind: QuestKind.Secret,
    difficulty: 3,
    unlockLevel: 1,
    hidden: true,
    objectives: [
      { type: ObjectiveType.VisitZone, target: 'backroom', count: 1, descriptionKey: 'objective.find_backroom' },
      { type: ObjectiveType.PressSecretButton, target: 'backroom_terminal', count: 1, descriptionKey: 'objective.terminal' },
    ],
    reward: reward(2500, 3000, 800, ['skin_weapon_voidglass']),
  },
  {
    id: 'secret_hub_signal',
    nameKey: 'quest.secret_hub_signal.name',
    descriptionKey: 'quest.secret_hub_signal.desc',
    kind: QuestKind.Secret,
    difficulty: 2,
    unlockLevel: 1,
    hidden: true,
    npcId: 'npc_archivist',
    objectives: [
      { type: ObjectiveType.PressSecretButton, target: 'hub_panel', count: 1, descriptionKey: 'objective.panel' },
      { type: ObjectiveType.TalkToNpc, target: 'npc_archivist', count: 1, descriptionKey: 'objective.talk' },
    ],
    reward: reward(1500, 2000, 500),
  },
  {
    id: 'secret_archivist_chain',
    nameKey: 'quest.secret_archivist_chain.name',
    descriptionKey: 'quest.secret_archivist_chain.desc',
    kind: QuestKind.Secret,
    difficulty: 3,
    unlockLevel: 1,
    hidden: true,
    requiresQuestId: 'secret_hub_signal',
    npcId: 'npc_archivist',
    objectives: [
      { type: ObjectiveType.VisitZone, target: 'vault', count: 1, descriptionKey: 'objective.find_vault' },
      { type: ObjectiveType.VisitZone, target: 'backroom', count: 1, descriptionKey: 'objective.find_backroom' },
      { type: ObjectiveType.LongShot, count: 1, threshold: 90, descriptionKey: 'objective.long_shot' },
    ],
    reward: reward(6000, 8000, 2000, ['title.archivist', 'crate_legendary']),
  },
];

export const ALL_QUESTS: readonly QuestDefinition[] = [
  ...DAILY_QUEST_POOL,
  ...WEEKLY_QUEST_POOL,
  ...STORY_QUESTS,
  ...SECRET_QUESTS,
];

const QUEST_BY_ID = new Map(ALL_QUESTS.map((q) => [q.id, q]));
export const getQuest = (id: string): QuestDefinition | undefined => QUEST_BY_ID.get(id);

export const DAILY_QUEST_COUNT = 3;
export const WEEKLY_QUEST_COUNT = 3;

// -------------------------------------------------------- Achievements ----

export interface AchievementDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  objective: QuestObjective;
  reward: QuestReward;
  /** Hidden achievements aren't listed until unlocked. */
  hidden: boolean;
  /** Tiered achievements share a family id. */
  family?: string;
  tier?: number;
}

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  {
    id: 'ach_first_kill',
    nameKey: 'ach.first_kill.name',
    descriptionKey: 'ach.first_kill.desc',
    objective: { type: ObjectiveType.Kill, count: 1, descriptionKey: 'objective.kill' },
    reward: reward(200, 200),
    hidden: false,
  },
  {
    id: 'ach_first_win',
    nameKey: 'ach.first_win.name',
    descriptionKey: 'ach.first_win.desc',
    objective: { type: ObjectiveType.WinMatch, count: 1, descriptionKey: 'objective.win' },
    reward: reward(400, 400),
    hidden: false,
  },
  ...[
    [1, 100, 'ach_kills_1'],
    [2, 1000, 'ach_kills_2'],
    [3, 5000, 'ach_kills_3'],
  ].map(([tier, count, id]) => ({
    id: id as string,
    nameKey: `ach.kills_${tier}.name`,
    descriptionKey: `ach.kills_${tier}.desc`,
    objective: { type: ObjectiveType.Kill, count: count as number, descriptionKey: 'objective.kill' },
    reward: reward((tier as number) * 1000, (tier as number) * 800),
    hidden: false,
    family: 'kills',
    tier: tier as number,
  })),
  {
    id: 'ach_streak_10',
    nameKey: 'ach.streak_10.name',
    descriptionKey: 'ach.streak_10.desc',
    objective: { type: ObjectiveType.KillStreak, count: 1, threshold: 10, descriptionKey: 'objective.streak' },
    reward: reward(2000, 1500),
    hidden: false,
  },
  {
    id: 'ach_level_25',
    nameKey: 'ach.level_25.name',
    descriptionKey: 'ach.level_25.desc',
    objective: { type: ObjectiveType.ReachLevel, count: 25, descriptionKey: 'objective.level' },
    reward: reward(0, 2500),
    hidden: false,
  },
  {
    id: 'ach_rank_gold',
    nameKey: 'ach.rank_gold.name',
    descriptionKey: 'ach.rank_gold.desc',
    objective: { type: ObjectiveType.ReachRank, target: 'gold', count: 1, descriptionKey: 'objective.rank' },
    reward: reward(3000, 3000),
    hidden: false,
  },
  {
    id: 'ach_collector',
    nameKey: 'ach.collector.name',
    descriptionKey: 'ach.collector.desc',
    objective: { type: ObjectiveType.CollectItem, count: 25, descriptionKey: 'objective.collect' },
    reward: reward(2000, 2000),
    hidden: false,
  },
  {
    id: 'ach_secret_finder',
    nameKey: 'ach.secret_finder.name',
    descriptionKey: 'ach.secret_finder.desc',
    objective: { type: ObjectiveType.PressSecretButton, count: 3, descriptionKey: 'objective.terminal' },
    reward: reward(5000, 5000, 0, ['charm_circuit']),
    hidden: true,
  },
  {
    id: 'ach_ghost_route',
    nameKey: 'ach.ghost_route.name',
    descriptionKey: 'ach.ghost_route.desc',
    objective: { type: ObjectiveType.VisitZone, target: 'vault', count: 1, descriptionKey: 'objective.find_vault' },
    reward: reward(1000, 1000),
    hidden: true,
  },
];

const ACH_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
export const getAchievement = (id: string): AchievementDefinition | undefined => ACH_BY_ID.get(id);

// -------------------------------------------------------- Login streak ----

export interface LoginRewardDay {
  day: number;
  coins: number;
  cores: number;
  itemIds: string[];
  xp: number;
}

/** A 28-day cycle. Streak resets if a UTC day is missed. */
export const LOGIN_REWARDS: readonly LoginRewardDay[] = Array.from({ length: 28 }, (_, i) => {
  const day = i + 1;
  const milestone = day % 7 === 0;
  return {
    day,
    coins: milestone ? 800 + day * 20 : 150 + day * 10,
    cores: milestone ? 10 : 0,
    itemIds: day === 28 ? ['crate_premium'] : day === 14 ? ['crate_standard'] : [],
    xp: milestone ? 800 : 200,
  };
});
