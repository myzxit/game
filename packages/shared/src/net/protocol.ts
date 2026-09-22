/**
 * Wire protocol.
 *
 * Every message the client can send is listed in `ClientMessage`, and every
 * one has a validator in `net/validation.ts`. The server rejects anything that
 * doesn't validate — that list *is* the trust boundary.
 *
 * Transport is JSON over WebSocket. That is a deliberate trade: it costs
 * bandwidth versus a binary format, but it keeps the protocol inspectable and
 * removes a whole class of desync bugs. `net/serialization.ts` quantises
 * snapshot floats, which recovers most of the size difference.
 */

import type { Vec3 } from '../core/math.js';
import type { PlayerInput } from '../sim/movement.js';
import type { Loadout } from '../config/loadout.js';
import {
  type HitZone,
  type MatchPhase,
  type MovementState,
  type PlayerId,
  type Rarity,
  type SurfaceMaterial,
  type TeamId,
  type Currency,
} from '../types/domain.js';

export { PROTOCOL_VERSION } from '../core/constants.js';

// ==========================================================================
// Client -> Server
// ==========================================================================

export enum ClientMessageType {
  Handshake = 'handshake',
  Ping = 'ping',
  Input = 'input',
  RequestRespawn = 'request_respawn',
  SwitchWeapon = 'switch_weapon',
  UseSkill = 'use_skill',
  Interact = 'interact',
  SetLoadout = 'set_loadout',
  ChatMessage = 'chat',

  // Matchmaking / party
  QueueJoin = 'queue_join',
  QueueLeave = 'queue_leave',
  PartyCreate = 'party_create',
  PartyJoin = 'party_join',
  PartyLeave = 'party_leave',
  PartyKick = 'party_kick',
  PartySetReady = 'party_set_ready',
  LeaveMatch = 'leave_match',

  // Meta
  ShopPurchase = 'shop_purchase',
  OpenCrate = 'open_crate',
  EquipItem = 'equip_item',
  ClaimQuestReward = 'claim_quest_reward',
  ClaimLoginReward = 'claim_login_reward',
  ClaimSeasonReward = 'claim_season_reward',
  TalkToNpc = 'talk_to_npc',
  DialogueChoice = 'dialogue_choice',
  SaveSettings = 'save_settings',
  ReportPlayer = 'report_player',
  BlockPlayer = 'block_player',
  RequestLeaderboard = 'request_leaderboard',
  RequestProfile = 'request_profile',
  SpectateTarget = 'spectate_target',
  EnterVehicle = 'enter_vehicle',
  ExitVehicle = 'exit_vehicle',
  VehicleInput = 'vehicle_input',

  /**
   * Developer tools. Accepted only by a server running with dev tools
   * enabled, which a production build cannot be; anything else answers with
   * an error and a suspicious-request flag.
   */
  DevCommand = 'dev_command',
  AckSnapshot = 'ack_snapshot',
}

export interface ClientHandshake {
  type: ClientMessageType.Handshake;
  protocolVersion: number;
  /** Display name for a new profile; ignored when resuming a session. */
  displayName: string;
  /** Opaque token from a previous session, enabling reconnect. */
  sessionToken: string | null;
  locale: string;
}

export interface ClientPing {
  type: ClientMessageType.Ping;
  clientTimeMs: number;
}

export interface ClientInputMessage {
  type: ClientMessageType.Input;
  /** Batched to tolerate packet loss; the server de-duplicates by sequence. */
  inputs: PlayerInput[];
  /** Latest snapshot the client has applied — drives delta compression. */
  lastAckedSnapshot: number;
}

export interface ClientSwitchWeapon {
  type: ClientMessageType.SwitchWeapon;
  /** 0 = primary, 1 = secondary, 2 = melee. */
  slot: number;
}

export interface ClientUseSkill {
  type: ClientMessageType.UseSkill;
  /** Aim direction at the moment of activation. */
  aimYaw: number;
  aimPitch: number;
}

export interface ClientInteract {
  type: ClientMessageType.Interact;
  /** What the client believes it is interacting with; the server re-checks. */
  targetKind: 'npc' | 'secret' | 'vehicle' | 'objective' | 'pickup';
  targetId: string;
}

export interface ClientSetLoadout {
  type: ClientMessageType.SetLoadout;
  loadout: Loadout;
}

export interface ClientChat {
  type: ClientMessageType.ChatMessage;
  channel: 'team' | 'all' | 'party';
  text: string;
}

export interface ClientQueueJoin {
  type: ClientMessageType.QueueJoin;
  modeId: string;
  /** Preferred maps; empty = any. */
  mapIds: string[];
}

export interface ClientQueueLeave {
  type: ClientMessageType.QueueLeave;
}

export interface ClientPartyCreate {
  type: ClientMessageType.PartyCreate;
}
export interface ClientPartyJoin {
  type: ClientMessageType.PartyJoin;
  code: string;
}
export interface ClientPartyLeave {
  type: ClientMessageType.PartyLeave;
}
export interface ClientPartyKick {
  type: ClientMessageType.PartyKick;
  playerId: PlayerId;
}
export interface ClientPartySetReady {
  type: ClientMessageType.PartySetReady;
  ready: boolean;
}
export interface ClientLeaveMatch {
  type: ClientMessageType.LeaveMatch;
}
export interface ClientRequestRespawn {
  type: ClientMessageType.RequestRespawn;
}

export interface ClientShopPurchase {
  type: ClientMessageType.ShopPurchase;
  itemId: string;
  /** Section the client believes the price came from; server re-derives it. */
  section: string;
}
export interface ClientOpenCrate {
  type: ClientMessageType.OpenCrate;
  crateId: string;
}
export interface ClientEquipItem {
  type: ClientMessageType.EquipItem;
  itemId: string;
  /** Which slot to equip into; server validates compatibility. */
  slot: string;
}
export interface ClientClaimQuestReward {
  type: ClientMessageType.ClaimQuestReward;
  questId: string;
}
export interface ClientClaimLoginReward {
  type: ClientMessageType.ClaimLoginReward;
}
export interface ClientClaimSeasonReward {
  type: ClientMessageType.ClaimSeasonReward;
  seasonId: string;
  level: number;
}
export interface ClientTalkToNpc {
  type: ClientMessageType.TalkToNpc;
  npcId: string;
}
export interface ClientDialogueChoice {
  type: ClientMessageType.DialogueChoice;
  npcId: string;
  nodeId: string;
  optionIndex: number;
}
export interface ClientSaveSettings {
  type: ClientMessageType.SaveSettings;
  settings: Record<string, unknown>;
}
export interface ClientReportPlayer {
  type: ClientMessageType.ReportPlayer;
  playerId: PlayerId;
  reason: 'cheating' | 'abuse' | 'exploit' | 'other';
  details: string;
}
export interface ClientBlockPlayer {
  type: ClientMessageType.BlockPlayer;
  playerId: PlayerId;
  blocked: boolean;
}
export interface ClientRequestLeaderboard {
  type: ClientMessageType.RequestLeaderboard;
  board: 'rank' | 'kills' | 'wins' | 'score';
  seasonId: string | null;
}
export interface ClientRequestProfile {
  type: ClientMessageType.RequestProfile;
  playerId: PlayerId;
}
export interface ClientSpectateTarget {
  type: ClientMessageType.SpectateTarget;
  /** null = free camera. */
  playerId: PlayerId | null;
}
export interface ClientEnterVehicle {
  type: ClientMessageType.EnterVehicle;
  vehicleId: number;
}
export interface ClientExitVehicle {
  type: ClientMessageType.ExitVehicle;
}
export type DevCommand =
  | { kind: 'teleport'; x: number; y: number; z: number }
  | { kind: 'give_coins'; amount: number }
  | { kind: 'set_health'; health: number };

export interface ClientDevCommand {
  type: ClientMessageType.DevCommand;
  command: DevCommand;
}

export interface ClientVehicleInput {
  type: ClientMessageType.VehicleInput;
  throttle: number;
  steer: number;
  brake: boolean;
  deltaMs: number;
  sequence: number;
}
export interface ClientAckSnapshot {
  type: ClientMessageType.AckSnapshot;
  snapshotId: number;
}

export type ClientMessage =
  | ClientHandshake
  | ClientPing
  | ClientInputMessage
  | ClientSwitchWeapon
  | ClientUseSkill
  | ClientInteract
  | ClientSetLoadout
  | ClientChat
  | ClientQueueJoin
  | ClientQueueLeave
  | ClientPartyCreate
  | ClientPartyJoin
  | ClientPartyLeave
  | ClientPartyKick
  | ClientPartySetReady
  | ClientLeaveMatch
  | ClientRequestRespawn
  | ClientShopPurchase
  | ClientOpenCrate
  | ClientEquipItem
  | ClientClaimQuestReward
  | ClientClaimLoginReward
  | ClientClaimSeasonReward
  | ClientTalkToNpc
  | ClientDialogueChoice
  | ClientSaveSettings
  | ClientReportPlayer
  | ClientBlockPlayer
  | ClientRequestLeaderboard
  | ClientRequestProfile
  | ClientSpectateTarget
  | ClientEnterVehicle
  | ClientExitVehicle
  | ClientVehicleInput
  | ClientDevCommand
  | ClientAckSnapshot;

// ==========================================================================
// Server -> Client
// ==========================================================================

export enum ServerMessageType {
  HandshakeAck = 'handshake_ack',
  Pong = 'pong',
  Error = 'error',
  ProfileSync = 'profile_sync',
  Snapshot = 'snapshot',
  MatchJoined = 'match_joined',
  MatchState = 'match_state',
  MatchEnded = 'match_ended',
  QueueUpdate = 'queue_update',
  PartyUpdate = 'party_update',
  CombatEvent = 'combat_event',
  KillFeed = 'kill_feed',
  Notification = 'notification',
  QuestUpdate = 'quest_update',
  InventoryUpdate = 'inventory_update',
  ShopUpdate = 'shop_update',
  CurrencyUpdate = 'currency_update',
  ProgressionUpdate = 'progression_update',
  CrateResult = 'crate_result',
  DialogueState = 'dialogue_state',
  Leaderboard = 'leaderboard',
  PlayerProfile = 'player_profile',
  ChatMessage = 'chat',
  ServerStatus = 'server_status',
  SecretDiscovered = 'secret_discovered',
}

export interface ServerHandshakeAck {
  type: ServerMessageType.HandshakeAck;
  protocolVersion: number;
  playerId: PlayerId;
  /** Store this and send it back to resume after a disconnect. */
  sessionToken: string;
  serverTimeMs: number;
  tickRate: number;
  /** True when this handshake resumed an existing session. */
  resumed: boolean;
  /** Set when the resumed session was still in a live match. */
  activeMatchId: string | null;
}

export interface ServerPong {
  type: ServerMessageType.Pong;
  clientTimeMs: number;
  serverTimeMs: number;
}

export interface ServerError {
  type: ServerMessageType.Error;
  code: string;
  messageKey: string;
  params?: Record<string, string | number>;
  /** The client message this is a response to, when known. */
  inResponseTo?: string;
  /** Fatal errors close the connection. */
  fatal: boolean;
}

/** Compact per-player state inside a snapshot. */
export interface PlayerSnapshot {
  id: PlayerId;
  /** Quantised: position in cm, angles in 1/1000 rad. See serialization.ts. */
  pos: [number, number, number];
  vel: [number, number, number];
  yaw: number;
  pitch: number;
  health: number;
  shield: number;
  team: TeamId;
  state: MovementState;
  height: number;
  /** Currently held weapon id. */
  weaponId: string;
  /** 0..100 ADS progress, used to drive remote-player aim pose. */
  ads: number;
  alive: boolean;
  /** Bitflags: 1=firing, 2=reloading, 4=spawnProtected, 8=phased, 16=inVehicle. */
  flags: number;
  characterId: string;
  skinId: string | null;
  displayName: string;
  score: number;
  kills: number;
  deaths: number;
  ping: number;
}

/** Only sent to the owning client; contains information others must not see. */
export interface LocalPlayerState {
  /** Last input sequence the server has processed — the reconciliation anchor. */
  lastProcessedInput: number;
  position: Vec3;
  velocity: Vec3;
  health: number;
  shield: number;
  stamina: number;
  ammoInMag: number;
  reserveAmmo: number;
  weaponSlot: number;
  weaponPhase: string;
  weaponPhaseTimeMs: number;
  spread: number;
  skillCooldownMs: number;
  skillEnergy: number;
  alive: boolean;
  respawnInMs: number;
  spawnProtectedMs: number;
  /** Server's authoritative view angles after recoil — the client blends to these. */
  recoilPitch: number;
  recoilYaw: number;
  vehicleId: number | null;
}

/**
 * One vehicle's authoritative state.
 *
 * Carried in full on every snapshot rather than delta-compressed: a map holds
 * one or two vehicles, so the whole list is smaller than a single player delta,
 * and it lets the client interpolate vehicles on the same clock as players.
 */
export interface VehicleSnapshot {
  id: number;
  defId: string;
  pos: [number, number, number];
  yaw: number;
  /** Forward speed in m/s; negative is reverse. */
  speed: number;
  health: number;
  driverId: PlayerId | null;
  passengerIds: PlayerId[];
  destroyed: boolean;
}

export interface ServerSnapshot {
  type: ServerMessageType.Snapshot;
  id: number;
  serverTimeMs: number;
  tick: number;
  /** Snapshot id this is a delta against; -1 = full snapshot. */
  baseId: number;
  players: PlayerSnapshot[];
  /** Ids present in the base snapshot but gone now. */
  removed: PlayerId[];
  local: LocalPlayerState;
  projectiles: { id: number; pos: [number, number, number]; weaponId: string }[];
  vehicles: VehicleSnapshot[];
  /** Transient world changes: broken glass, deployed barriers. */
  worldEvents: WorldEvent[];
}

export interface WorldEvent {
  kind: 'glass_break' | 'barrier_deploy' | 'barrier_destroy' | 'explosion' | 'scan_pulse';
  at: [number, number, number];
  /** Meaning depends on `kind`: radius, brush id, owner id... */
  value: number;
  ownerId?: PlayerId;
}

export interface ServerMatchJoined {
  type: ServerMessageType.MatchJoined;
  matchId: string;
  modeId: string;
  mapId: string;
  team: TeamId;
  /** Deterministic seed for all match randomness. */
  seed: number;
  serverTimeMs: number;
  players: PlayerSnapshot[];
}

export interface ServerMatchState {
  type: ServerMessageType.MatchState;
  phase: MatchPhase;
  timeRemainingMs: number;
  scores: Record<string, number>;
  round: number;
  roundsWon: Record<string, number>;
  objectives: {
    id: string;
    owner: TeamId;
    /** 0..1 capture progress by the contesting team. */
    progress: number;
    contested: boolean;
  }[];
  /** Alive counts per team, for Elimination's HUD. */
  aliveCount: Record<string, number>;
}

export interface MatchResultPlayer {
  playerId: PlayerId;
  displayName: string;
  team: TeamId;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  headshots: number;
  score: number;
  bestStreak: number;
  accuracy: number;
  xpEarned: number;
  coinsEarned: number;
  rankDelta: number;
  mvp: boolean;
}

export interface ServerMatchEnded {
  type: ServerMessageType.MatchEnded;
  matchId: string;
  winningTeam: TeamId | null;
  /** For FFA. */
  winningPlayerId: PlayerId | null;
  results: MatchResultPlayer[];
  durationMs: number;
}

export interface ServerQueueUpdate {
  type: ServerMessageType.QueueUpdate;
  inQueue: boolean;
  modeId: string | null;
  queuedMs: number;
  playersFound: number;
  playersNeeded: number;
  estimatedWaitMs: number;
}

export interface PartyMemberInfo {
  playerId: PlayerId;
  displayName: string;
  level: number;
  ready: boolean;
  isLeader: boolean;
  online: boolean;
}

export interface ServerPartyUpdate {
  type: ServerMessageType.PartyUpdate;
  partyId: string | null;
  code: string | null;
  members: PartyMemberInfo[];
  maxSize: number;
}

/** Immediate combat feedback — sent outside snapshots so it is never delayed. */
export interface ServerCombatEvent {
  type: ServerMessageType.CombatEvent;
  event:
    | { kind: 'hit'; targetId: PlayerId; damage: number; zone: HitZone; lethal: boolean; shieldOnly: boolean }
    | { kind: 'damaged'; attackerId: PlayerId | null; amount: number; fromDirection: [number, number, number] }
    | { kind: 'impact'; at: [number, number, number]; normal: [number, number, number]; material: SurfaceMaterial }
    | { kind: 'shot'; shooterId: PlayerId; origin: [number, number, number]; direction: [number, number, number]; weaponId: string; pellets: number; seed: number }
    | { kind: 'killed'; victimId: PlayerId; killerId: PlayerId | null }
    | { kind: 'respawn'; playerId: PlayerId; at: [number, number, number] }
    | { kind: 'skill'; playerId: PlayerId; skillId: string; at: [number, number, number] }
    | { kind: 'streak'; playerId: PlayerId; count: number }
    | { kind: 'multikill'; playerId: PlayerId; count: number };
}

export interface ServerKillFeed {
  type: ServerMessageType.KillFeed;
  killerId: PlayerId | null;
  killerName: string;
  victimId: PlayerId;
  victimName: string;
  weaponId: string | null;
  headshot: boolean;
  killerTeam: TeamId;
  victimTeam: TeamId;
  assistNames: string[];
}

export interface ServerNotification {
  type: ServerMessageType.Notification;
  level: 'info' | 'success' | 'warning';
  messageKey: string;
  params?: Record<string, string | number>;
  /** Optional icon key for item grants. */
  iconKey?: string;
  durationMs: number;
}

export interface ServerQuestUpdate {
  type: ServerMessageType.QuestUpdate;
  quests: {
    id: string;
    kind: string;
    progress: number[];
    completed: boolean;
    claimed: boolean;
    /** Secret quests only appear here once discovered. */
    discovered: boolean;
  }[];
  dailyResetAtMs: number;
  weeklyResetAtMs: number;
}

export interface ServerInventoryUpdate {
  type: ServerMessageType.InventoryUpdate;
  ownedItemIds: string[];
  ownedWeaponIds: string[];
  ownedAttachmentIds: string[];
  ownedCharacterIds: string[];
  loadout: Loadout;
  equippedTitle: string | null;
}

export interface ServerShopEntry {
  itemId: string;
  section: string;
  currency: Currency;
  price: number;
  basePrice: number;
  discountPercent: number;
  unlockLevel: number;
  owned: boolean;
  purchasable: boolean;
}

export interface ServerShopUpdate {
  type: ServerMessageType.ShopUpdate;
  /** Section id -> entries currently on sale. */
  sections: Record<string, ServerShopEntry[]>;
  /** When the rotating sections next change, as server timestamps. */
  dailyRefreshAtMs: number;
  weeklyRefreshAtMs: number;
}

export interface ServerCurrencyUpdate {
  type: ServerMessageType.CurrencyUpdate;
  balances: Record<Currency, number>;
}

export interface ServerProgressionUpdate {
  type: ServerMessageType.ProgressionUpdate;
  totalXp: number;
  level: number;
  xpIntoLevel: number;
  xpForNext: number;
  rankPoints: number;
  seasonId: string | null;
  seasonXp: number;
  seasonLevel: number;
  /** Set when this update crossed a level boundary — drives the level-up screen. */
  leveledUpTo: number | null;
  rankChanged: { from: string; to: string; promoted: boolean } | null;
}

export interface ServerCrateResult {
  type: ServerMessageType.CrateResult;
  crateId: string;
  itemId: string;
  rarity: Rarity;
  duplicate: boolean;
  coinsAwarded: number;
  /** Rates actually used for this roll — shown in the reveal UI. */
  rates: Record<string, number>;
}

export interface ServerDialogueState {
  type: ServerMessageType.DialogueState;
  npcId: string;
  nodeId: string | null;
  textKey: string;
  options: { textKey: string; index: number; opensService: string | null }[];
}

export interface ServerLeaderboard {
  type: ServerMessageType.Leaderboard;
  board: string;
  seasonId: string | null;
  entries: {
    rank: number;
    playerId: PlayerId;
    displayName: string;
    value: number;
    tierId?: string;
  }[];
  /** The requesting player's own position, even if outside the top N. */
  selfEntry: { rank: number; value: number } | null;
}

export interface ServerPlayerProfile {
  type: ServerMessageType.PlayerProfile;
  playerId: PlayerId;
  displayName: string;
  level: number;
  rankPoints: number;
  title: string | null;
  stats: {
    kills: number;
    deaths: number;
    assists: number;
    wins: number;
    losses: number;
    headshots: number;
    playtimeMs: number;
    bestStreak: number;
    bestScore: number;
    favoriteWeaponId: string | null;
  };
  achievementIds: string[];
}

export interface ServerChat {
  type: ServerMessageType.ChatMessage;
  channel: string;
  fromId: PlayerId;
  fromName: string;
  text: string;
  team: TeamId;
}

export interface ServerStatus {
  type: ServerMessageType.ServerStatus;
  serverTimeMs: number;
  tickRate: number;
  /** Server-side simulation load, 0..1. */
  load: number;
  playersOnline: number;
  matchesActive: number;
  region: string;
  /** Set when the server is going down; the client shows a warning. */
  shutdownInMs: number | null;
}

export interface ServerSecretDiscovered {
  type: ServerMessageType.SecretDiscovered;
  secretId: string;
  questId: string | null;
  nameKey: string;
}


export interface ServerProfileSync {
  type: ServerMessageType.ProfileSync;
  displayName: string;
  settings: Record<string, unknown>;
  /** Full meta-state on login, so the client can render every menu offline. */
  progression: Omit<ServerProgressionUpdate, 'type' | 'leveledUpTo' | 'rankChanged'>;
  inventory: Omit<ServerInventoryUpdate, 'type'>;
  currencies: Record<Currency, number>;
  stats: ServerPlayerProfile['stats'];
  achievementIds: string[];
  loginStreak: number;
  loginRewardAvailable: boolean;
  discoveredSecretIds: string[];
  unlockedTitleIds: string[];
}

export type ServerMessage =
  | ServerHandshakeAck
  | ServerPong
  | ServerError
  | ServerProfileSync
  | ServerSnapshot
  | ServerMatchJoined
  | ServerMatchState
  | ServerMatchEnded
  | ServerQueueUpdate
  | ServerPartyUpdate
  | ServerCombatEvent
  | ServerKillFeed
  | ServerNotification
  | ServerQuestUpdate
  | ServerInventoryUpdate
  | ServerShopUpdate
  | ServerCurrencyUpdate
  | ServerProgressionUpdate
  | ServerCrateResult
  | ServerDialogueState
  | ServerLeaderboard
  | ServerPlayerProfile
  | ServerChat
  | ServerStatus
  | ServerSecretDiscovered

/** Snapshot player flag bits. */
export const enum SnapshotFlag {
  Firing = 1 << 0,
  Reloading = 1 << 1,
  SpawnProtected = 1 << 2,
  Phased = 1 << 3,
  InVehicle = 1 << 4,
  Aiming = 1 << 5,
  Crouching = 1 << 6,
  Scanned = 1 << 7,
}
