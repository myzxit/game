/**
 * NPC interaction and dialogue.
 *
 * Dialogue is a graph walk with server-side gating: an option that requires a
 * quest or an undiscovered secret is filtered out before the node is sent, so
 * the client cannot see (or pick) an option it hasn't earned.
 *
 * Talking to an NPC never grants anything by itself — it opens a *service*,
 * and that service does its own validation.
 */

import {
  ErrorCode,
  NpcService as NpcServiceKind,
  NPCS,
  ObjectiveType,
  createLogger,
  fail,
  getDialogueNode,
  getNpc,
  ok,
  v3dist,
  type DialogueNode,
  type NpcDefinition,
  type Result,
  type Vec3,
} from '@titan/shared';
import type { PlayerProfile } from '../data/schema.js';
import type { QuestService } from './QuestService.js';

const log = createLogger('Npc');

/** How close a player must be to interact. */
const INTERACT_RANGE = 4.0;

export interface DialogueView {
  npcId: string;
  nodeId: string;
  textKey: string;
  options: { textKey: string; index: number; opensService: string | null }[];
}

interface ActiveConversation {
  npcId: string;
  nodeId: string;
  startedAt: number;
}

export class NpcService {
  private readonly conversations = new Map<string, ActiveConversation>();
  /** Where each NPC stands, from the hub map. */
  private readonly positions = new Map<string, Vec3>();

  constructor(private readonly quests: QuestService) {}

  /** Register NPC anchors when the hub world loads. */
  registerPositions(spawns: { npcId: string; at: Vec3 }[]): void {
    for (const spawn of spawns) this.positions.set(spawn.npcId, spawn.at);
  }

  /** Is this option visible to this player? */
  private isOptionAvailable(
    profile: PlayerProfile,
    option: DialogueNode['options'][number],
  ): boolean {
    if (option.requiresSecretId && !profile.discoveredSecretIds.includes(option.requiresSecretId)) {
      return false;
    }
    if (option.requiresQuestId) {
      const entry = profile.quests.find((q) => q.questId === option.requiresQuestId);
      if (!entry) return false;
      if (option.requiresQuestComplete && !entry.completed) return false;
    }
    return true;
  }

  private viewFor(npc: NpcDefinition, node: DialogueNode, profile: PlayerProfile): DialogueView {
    const options = node.options
      // Keep the original index so the client's choice maps back correctly
      // after filtering.
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => this.isOptionAvailable(profile, option))
      .map(({ option, index }) => ({
        textKey: option.textKey,
        index,
        opensService: option.opensService ?? null,
      }));

    return { npcId: npc.id, nodeId: node.id, textKey: node.textKey, options };
  }

  /**
   * Begin a conversation.
   * `playerPosition` is the server's authoritative position, not the client's.
   */
  talk(
    profile: PlayerProfile,
    npcId: string,
    playerPosition: Vec3 | null,
    now = Date.now(),
  ): Result<DialogueView> {
    const npc = getNpc(npcId);
    if (!npc) return fail(ErrorCode.NotFound, `unknown npc ${npcId}`);
    if (npc.hidden && !profile.discoveredSecretIds.includes(npcId)) {
      return fail(ErrorCode.NotFound, `npc ${npcId} is not available`);
    }

    // Range check against the server's own idea of where the player is.
    const anchor = this.positions.get(npcId);
    if (anchor && playerPosition && v3dist(anchor, playerPosition) > INTERACT_RANGE) {
      return fail(ErrorCode.Forbidden, `too far from ${npcId}`);
    }

    const node = getDialogueNode(npc, npc.rootNodeId);
    if (!node) return fail(ErrorCode.NotFound, `npc ${npcId} has no root node`);

    this.conversations.set(profile.id, { npcId, nodeId: node.id, startedAt: now });
    return ok(this.viewFor(npc, node, profile));
  }

  /**
   * Choose an option.
   * Returns the next view, or null when the conversation ends.
   */
  choose(
    profile: PlayerProfile,
    npcId: string,
    nodeId: string,
    optionIndex: number,
    now = Date.now(),
  ): Result<{ view: DialogueView | null; opensService: NpcServiceKind | null }> {
    const active = this.conversations.get(profile.id);
    // The client must be answering the node we actually sent it — this blocks
    // jumping straight to a gated node by guessing its id.
    if (!active || active.npcId !== npcId || active.nodeId !== nodeId) {
      return fail(ErrorCode.Conflict, 'dialogue state mismatch');
    }

    const npc = getNpc(npcId);
    if (!npc) return fail(ErrorCode.NotFound, `unknown npc ${npcId}`);
    const node = getDialogueNode(npc, nodeId);
    if (!node) return fail(ErrorCode.NotFound, `unknown node ${nodeId}`);

    const option = node.options[optionIndex];
    if (!option) return fail(ErrorCode.Validation, `no option ${optionIndex}`);
    if (!this.isOptionAvailable(profile, option)) {
      return fail(ErrorCode.Forbidden, 'option not available');
    }

    if (option.completesTalk) {
      this.quests.track(profile, { type: ObjectiveType.TalkToNpc, target: npcId }, now);
    }

    if (option.next === null) {
      this.conversations.delete(profile.id);
      return ok({ view: null, opensService: option.opensService ?? null });
    }

    const next = getDialogueNode(npc, option.next);
    if (!next) {
      this.conversations.delete(profile.id);
      return ok({ view: null, opensService: option.opensService ?? null });
    }

    this.conversations.set(profile.id, { npcId, nodeId: next.id, startedAt: active.startedAt });
    return ok({
      view: this.viewFor(npc, next, profile),
      opensService: option.opensService ?? null,
    });
  }

  endConversation(playerId: string): void {
    this.conversations.delete(playerId);
  }

  /**
   * Interact with a secret anchor (a hidden button or panel).
   * Returns true when this reveals something new.
   */
  triggerSecret(
    profile: PlayerProfile,
    secretId: string,
    unlocksQuestId: string | null,
    anchorPosition: Vec3 | null,
    playerPosition: Vec3 | null,
    now = Date.now(),
  ): Result<boolean> {
    if (anchorPosition && playerPosition && v3dist(anchorPosition, playerPosition) > INTERACT_RANGE) {
      return fail(ErrorCode.Forbidden, 'too far from the anchor');
    }

    const discovered = this.quests.discoverSecret(profile, secretId, unlocksQuestId, now);
    if (discovered) {
      this.quests.track(
        profile,
        { type: ObjectiveType.PressSecretButton, target: secretId },
        now,
      );
      log.info('secret triggered', { playerId: profile.id, secretId });
    }
    return ok(discovered);
  }

  /** NPCs visible to this player, for the hub UI. */
  visibleNpcs(profile: PlayerProfile): NpcDefinition[] {
    return NPCS.filter((n) => !n.hidden || profile.discoveredSecretIds.includes(n.id));
  }
}
