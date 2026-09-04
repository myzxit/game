/**
 * NPCs — the hub's service characters plus one hidden one.
 *
 * NPCs are pure data: a dialogue tree, a service they expose, and an anchor in
 * the hub map. The server validates every service interaction, so talking to
 * the shopkeeper is not what grants an item — the ShopService is.
 */

export enum NpcService {
  None = 'none',
  Shop = 'shop',
  Quests = 'quests',
  Tutorial = 'tutorial',
  Rewards = 'rewards',
  Loadout = 'loadout',
  Secret = 'secret',
}

export interface DialogueNode {
  id: string;
  textKey: string;
  /** Options shown to the player; empty = end of conversation. */
  options: {
    textKey: string;
    /** Node to go to; null closes the dialogue. */
    next: string | null;
    /** Opens a service panel when chosen. */
    opensService?: NpcService;
    /** Only shown when this quest is active/complete. */
    requiresQuestId?: string;
    requiresQuestComplete?: boolean;
    /** Only shown once this secret has been discovered. */
    requiresSecretId?: string;
    /** Marks a quest objective of type TalkToNpc as satisfied. */
    completesTalk?: boolean;
  }[];
}

export interface NpcDefinition {
  id: string;
  nameKey: string;
  roleKey: string;
  service: NpcService;
  /** Root dialogue node id. */
  rootNodeId: string;
  dialogue: DialogueNode[];
  /** Quests this NPC offers. */
  questIds: string[];
  /** Appearance keys — see docs/ASSETS.md for the model spec. */
  modelKey: string;
  accentColor: number;
  idleAnimationKey: string;
  /** Hidden NPCs only appear once their secret is discovered. */
  hidden: boolean;
}

export const NPCS: readonly NpcDefinition[] = [
  {
    id: 'npc_quartermaster',
    nameKey: 'npc.quartermaster.name',
    roleKey: 'npc.quartermaster.role',
    service: NpcService.Shop,
    rootNodeId: 'root',
    modelKey: 'model.npc.quartermaster',
    accentColor: 0x4ec97a,
    idleAnimationKey: 'anim.npc.idle_arms_crossed',
    questIds: ['story_quartermaster'],
    hidden: false,
    dialogue: [
      {
        id: 'root',
        textKey: 'dialogue.quartermaster.root',
        options: [
          { textKey: 'dialogue.opt.browse_shop', next: null, opensService: NpcService.Shop, completesTalk: true },
          { textKey: 'dialogue.opt.ask_about_gear', next: 'gear' },
          { textKey: 'dialogue.opt.leave', next: null },
        ],
      },
      {
        id: 'gear',
        textKey: 'dialogue.quartermaster.gear',
        options: [
          { textKey: 'dialogue.opt.ask_attachments', next: 'attachments' },
          { textKey: 'dialogue.opt.back', next: 'root' },
        ],
      },
      {
        id: 'attachments',
        textKey: 'dialogue.quartermaster.attachments',
        options: [{ textKey: 'dialogue.opt.back', next: 'root' }],
      },
    ],
  },
  {
    id: 'npc_armorer',
    nameKey: 'npc.armorer.name',
    roleKey: 'npc.armorer.role',
    service: NpcService.Loadout,
    rootNodeId: 'root',
    modelKey: 'model.npc.armorer',
    accentColor: 0xf0a02a,
    idleAnimationKey: 'anim.npc.idle_working',
    questIds: [],
    hidden: false,
    dialogue: [
      {
        id: 'root',
        textKey: 'dialogue.armorer.root',
        options: [
          { textKey: 'dialogue.opt.open_loadout', next: null, opensService: NpcService.Loadout, completesTalk: true },
          { textKey: 'dialogue.opt.ask_balance', next: 'balance' },
          { textKey: 'dialogue.opt.leave', next: null },
        ],
      },
      {
        id: 'balance',
        textKey: 'dialogue.armorer.balance',
        options: [{ textKey: 'dialogue.opt.back', next: 'root' }],
      },
    ],
  },
  {
    id: 'npc_dispatcher',
    nameKey: 'npc.dispatcher.name',
    roleKey: 'npc.dispatcher.role',
    service: NpcService.Quests,
    rootNodeId: 'root',
    modelKey: 'model.npc.dispatcher',
    accentColor: 0x3f8ce8,
    idleAnimationKey: 'anim.npc.idle_tablet',
    questIds: ['story_proving_ground'],
    hidden: false,
    dialogue: [
      {
        id: 'root',
        textKey: 'dialogue.dispatcher.root',
        options: [
          { textKey: 'dialogue.opt.view_contracts', next: null, opensService: NpcService.Quests, completesTalk: true },
          { textKey: 'dialogue.opt.ask_modes', next: 'modes' },
          { textKey: 'dialogue.opt.leave', next: null },
        ],
      },
      {
        id: 'modes',
        textKey: 'dialogue.dispatcher.modes',
        options: [{ textKey: 'dialogue.opt.back', next: 'root' }],
      },
    ],
  },
  {
    id: 'npc_instructor',
    nameKey: 'npc.instructor.name',
    roleKey: 'npc.instructor.role',
    service: NpcService.Tutorial,
    rootNodeId: 'root',
    modelKey: 'model.npc.instructor',
    accentColor: 0xf0426e,
    idleAnimationKey: 'anim.npc.idle_alert',
    questIds: ['story_first_steps', 'story_first_blood', 'story_specialist'],
    hidden: false,
    dialogue: [
      {
        id: 'root',
        textKey: 'dialogue.instructor.root',
        options: [
          { textKey: 'dialogue.opt.start_tutorial', next: null, opensService: NpcService.Tutorial, completesTalk: true },
          { textKey: 'dialogue.opt.ask_movement', next: 'movement' },
          { textKey: 'dialogue.opt.leave', next: null },
        ],
      },
      {
        id: 'movement',
        textKey: 'dialogue.instructor.movement',
        options: [
          { textKey: 'dialogue.opt.ask_slide', next: 'slide' },
          { textKey: 'dialogue.opt.back', next: 'root' },
        ],
      },
      {
        id: 'slide',
        textKey: 'dialogue.instructor.slide',
        options: [{ textKey: 'dialogue.opt.back', next: 'root' }],
      },
    ],
  },
  {
    id: 'npc_archivist',
    nameKey: 'npc.archivist.name',
    roleKey: 'npc.archivist.role',
    service: NpcService.Secret,
    rootNodeId: 'root',
    modelKey: 'model.npc.archivist',
    accentColor: 0x8a5cff,
    idleAnimationKey: 'anim.npc.idle_reading',
    questIds: ['secret_hub_signal', 'secret_archivist_chain'],
    // Present in the world from the start, but only *responds* once the hidden
    // panel behind the counter has been found — otherwise stays silent.
    hidden: false,
    dialogue: [
      {
        id: 'root',
        textKey: 'dialogue.archivist.root',
        options: [
          {
            textKey: 'dialogue.opt.mention_signal',
            next: 'signal',
            requiresSecretId: 'hub_panel',
            completesTalk: true,
          },
          { textKey: 'dialogue.opt.leave', next: null },
        ],
      },
      {
        id: 'signal',
        textKey: 'dialogue.archivist.signal',
        options: [
          { textKey: 'dialogue.opt.ask_more', next: 'more' },
          { textKey: 'dialogue.opt.back', next: 'root' },
        ],
      },
      {
        id: 'more',
        textKey: 'dialogue.archivist.more',
        options: [
          {
            textKey: 'dialogue.opt.accept_chain',
            next: null,
            requiresQuestId: 'secret_hub_signal',
            requiresQuestComplete: true,
          },
          { textKey: 'dialogue.opt.back', next: 'root' },
        ],
      },
    ],
  },
];

const BY_ID = new Map(NPCS.map((n) => [n.id, n]));
export const getNpc = (id: string): NpcDefinition | undefined => BY_ID.get(id);

export function getDialogueNode(npc: NpcDefinition, nodeId: string): DialogueNode | undefined {
  return npc.dialogue.find((d) => d.id === nodeId);
}
