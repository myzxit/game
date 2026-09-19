/**
 * The game server.
 *
 * Owns the loop and routes every client message to the service that is allowed
 * to act on it. Nothing here decides game outcomes; it delegates to the match
 * simulation and the meta services, both of which validate independently.
 *
 * Two timers drive everything: the simulation tick (64 Hz) and the snapshot
 * broadcast (20 Hz). Matchmaking, session pruning and autosave run on slower
 * intervals off the same clock.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import {
  ClientMessageType,
  CONNECTION_TIMEOUT_MS,
  Currency,
  ErrorCode,
  HUB_MAP_ID,
  MAX_PARTY_SIZE,
  MatchPhase,
  ObjectiveType,
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL_TICKS,
  ServerMessageType,
  TICK_MS,
  TICK_RATE,
  TeamId,
  activeSeason,
  createLogger,
  getMap,
  getGameMode,
  levelFromTotalXp,
  type ClientMessage,
  type ServerMessage,
  type ServerShopEntry,
} from '@titan/shared';
import { Connection } from './Connection.js';
import { SessionRegistry } from './SessionRegistry.js';
import { MatchInstance, type MatchPlayerSeed } from '../match/MatchInstance.js';
import { SnapshotBuilder } from '../match/SnapshotBuilder.js';
import { createGameMode } from '../gamemodes/index.js';
import { WorldRegistry } from '../world/WorldRegistry.js';
import { AntiCheat } from '../anticheat/AntiCheat.js';
import { ProfileService } from '../services/ProfileService.js';
import { EconomyService } from '../services/EconomyService.js';
import { InventoryService } from '../services/InventoryService.js';
import { ShopService } from '../services/ShopService.js';
import { CrateService } from '../services/CrateService.js';
import { ProgressionService } from '../services/ProgressionService.js';
import { QuestService } from '../services/QuestService.js';
import { LoginRewardService } from '../services/LoginRewardService.js';
import { PartyService } from '../services/PartyService.js';
import { MatchmakingService, type QueueTicket } from '../services/MatchmakingService.js';
import { SocialService } from '../services/SocialService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { AnalyticsService, FunnelStep } from '../services/AnalyticsService.js';
import { NpcService } from '../services/NpcService.js';
import { MatchRewardService } from '../services/MatchRewardService.js';
import type { ProfileStore } from '../data/ProfileStore.js';
import type { PlayerProfile } from '../data/schema.js';

const log = createLogger('GameServer');

export interface GameServerOptions {
  port: number;
  host: string;
  region: string;
  store: ProfileStore;
  /** Preload these maps at startup. */
  preloadMaps: string[];
  /** Enable the developer tools endpoints. Off in production builds. */
  devTools: boolean;
}

interface ActiveMatch {
  instance: MatchInstance;
  snapshots: SnapshotBuilder;
  /** Set once rewards have been paid, so they can't be paid twice. */
  finalized: boolean;
}

export class GameServer {
  private wss: WebSocketServer | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private slowTimer: NodeJS.Timeout | null = null;
  private running = false;
  private tickCount = 0;
  private nextConnectionId = 1;
  private nextMatchNumber = 1;

  private readonly connections = new Map<string, Connection>();
  private readonly connectionByPlayer = new Map<string, Connection>();
  private readonly matches = new Map<string, ActiveMatch>();
  private readonly matchByPlayer = new Map<string, string>();

  readonly sessions = new SessionRegistry();
  readonly worlds = new WorldRegistry();
  readonly antiCheat = new AntiCheat();

  readonly profiles: ProfileService;
  readonly economy: EconomyService;
  readonly inventory: InventoryService;
  readonly shop: ShopService;
  readonly crates: CrateService;
  readonly progression: ProgressionService;
  readonly quests: QuestService;
  readonly loginRewards: LoginRewardService;
  readonly parties = new PartyService();
  readonly matchmaking = new MatchmakingService();
  readonly social: SocialService;
  readonly leaderboards: LeaderboardService;
  readonly analytics = new AnalyticsService();
  readonly npcs: NpcService;
  readonly rewards: MatchRewardService;

  /** Rolling measure of how long a tick takes, as a fraction of the budget. */
  private tickLoad = 0;

  constructor(private readonly options: GameServerOptions) {
    this.profiles = new ProfileService(options.store);
    this.economy = new EconomyService(this.profiles);
    this.inventory = new InventoryService(this.profiles);
    this.shop = new ShopService(this.economy, this.inventory);
    this.progression = new ProgressionService(this.profiles, this.economy, this.inventory);
    this.crates = new CrateService(this.profiles, this.economy, this.inventory);
    this.quests = new QuestService(this.profiles, this.economy, this.inventory, this.progression);
    this.loginRewards = new LoginRewardService(
      this.profiles,
      this.economy,
      this.inventory,
      this.progression,
    );
    this.social = new SocialService(this.profiles);
    this.leaderboards = new LeaderboardService(options.store);
    this.npcs = new NpcService(this.quests);
    this.rewards = new MatchRewardService(
      this.profiles,
      this.economy,
      this.progression,
      this.quests,
      this.analytics,
      this.leaderboards,
    );
  }

  // ============================================================== lifecycle ==

  async start(): Promise<void> {
    if (this.running) return;

    this.worlds.preload(this.options.preloadMaps);
    const hub = getMap(HUB_MAP_ID);
    if (hub) this.npcs.registerPositions(hub.npcSpawns);

    await this.leaderboards.rebuild();
    this.profiles.start();

    this.wss = new WebSocketServer({ port: this.options.port, host: this.options.host });
    this.wss.on('connection', (socket: WebSocket) => this.onConnection(socket));
    this.wss.on('error', (error: Error) => log.error('websocket server error', { error: error.message }));

    this.running = true;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.slowTimer = setInterval(() => this.slowTick(), 1000);

    log.info('server listening', {
      host: this.options.host,
      port: this.options.port,
      region: this.options.region,
      tickRate: TICK_RATE,
      maps: this.worlds.loadedCount,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.tickTimer = null;
    this.slowTimer = null;

    // Give clients a moment to see the shutdown notice.
    for (const connection of this.connections.values()) {
      connection.send({
        type: ServerMessageType.ServerStatus,
        ...this.statusPayload(),
        shutdownInMs: 0,
      });
      connection.close(1001, 'shutdown');
    }

    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });

    await this.profiles.stop();
    log.info('server stopped');
  }

  // ============================================================ connections ==

  private onConnection(socket: WebSocket): void {
    const id = `c${this.nextConnectionId++}`;
    const connection = new Connection(
      id,
      socket,
      (c, message) => this.handleMessage(c, message),
      (c, detail, suspicious) => {
        if (c.playerId) this.antiCheat.reportProtocolViolation(c.playerId, detail, suspicious);
        this.analytics.errorOccurred('protocol');
      },
    );

    this.connections.set(id, connection);
    socket.on('close', () => this.onDisconnect(connection));
    log.debug('connection opened', { connectionId: id });
  }

  private onDisconnect(connection: Connection): void {
    this.connections.delete(connection.id);
    const playerId = connection.playerId;
    if (!playerId) return;

    this.connectionByPlayer.delete(playerId);
    const now = Date.now();

    this.sessions.disconnect(playerId, now);
    this.parties.setOnline(playerId, false, now);
    this.matchmaking.dequeuePlayer(playerId);
    this.social.clearSession(playerId);
    this.npcs.endConversation(playerId);
    this.analytics.recordFunnel(playerId, FunnelStep.Disconnected);
    this.analytics.endSession(playerId);

    // Hold their match slot for the reconnect window rather than removing them.
    const matchId = this.matchByPlayer.get(playerId);
    const match = matchId ? this.matches.get(matchId) : undefined;
    if (match) {
      match.instance.markDisconnected(playerId, now);
      this.analytics.playerLeftEarly(match.instance.modeId);
    }

    void this.profiles.release(playerId, now);
    log.info('player disconnected', { playerId });
  }

  // =============================================================== routing ==

  private handleMessage(connection: Connection, message: ClientMessage): void {
    if (message.type === ClientMessageType.Handshake) {
      void this.handleHandshake(connection, message);
      return;
    }

    const playerId = connection.playerId;
    if (!playerId) return;
    const profile = this.profiles.peek(playerId);
    if (!profile) {
      connection.sendError(ErrorCode.Unavailable, 'error.unavailable', false, message.type);
      return;
    }

    switch (message.type) {
      case ClientMessageType.Ping:
        this.handlePing(connection, message.clientTimeMs);
        break;

      case ClientMessageType.Input: {
        const match = this.matchFor(playerId);
        if (match) {
          // Every input batch piggybacks the client's newest acknowledged
          // snapshot. It goes through the same guarded path as the dedicated
          // AckSnapshot message so the two cannot disagree about the delta base.
          match.snapshots.acknowledge(playerId, message.lastAckedSnapshot);
          match.instance.enqueueInputs(playerId, message.inputs);
        }
        break;
      }

      case ClientMessageType.AckSnapshot: {
        const match = this.matchFor(playerId);
        if (match) match.snapshots.acknowledge(playerId, message.snapshotId);
        break;
      }

      case ClientMessageType.SwitchWeapon:
        this.matchFor(playerId)?.instance.switchWeapon(playerId, message.slot);
        break;

      case ClientMessageType.UseSkill:
        this.matchFor(playerId)?.instance.useSkill(playerId, message.aimYaw, message.aimPitch);
        break;

      case ClientMessageType.RequestRespawn:
        this.matchFor(playerId)?.instance.requestRespawn(playerId);
        break;

      case ClientMessageType.SetLoadout: {
        const applied = this.inventory.applyLoadout(profile, message.loadout);
        this.matchFor(playerId)?.instance.applyLoadout(playerId, applied);
        connection.send(this.inventoryMessage(profile));
        break;
      }

      case ClientMessageType.Interact:
        this.handleInteract(connection, profile, message.targetKind, message.targetId);
        break;

      case ClientMessageType.LeaveMatch:
        this.removeFromMatch(playerId, 'left');
        break;

      case ClientMessageType.QueueJoin:
        this.handleQueueJoin(connection, profile, message.modeId, message.mapIds);
        break;

      case ClientMessageType.QueueLeave:
        this.matchmaking.dequeuePlayer(playerId);
        connection.send({ type: ServerMessageType.QueueUpdate, ...this.matchmaking.status(playerId) });
        break;

      case ClientMessageType.PartyCreate:
      case ClientMessageType.PartyJoin:
      case ClientMessageType.PartyLeave:
      case ClientMessageType.PartyKick:
      case ClientMessageType.PartySetReady:
        this.handleParty(connection, profile, message);
        break;

      case ClientMessageType.ShopPurchase:
        this.handlePurchase(connection, profile, message.itemId, message.section);
        break;

      case ClientMessageType.OpenCrate:
        this.handleCrate(connection, profile, message.crateId);
        break;

      case ClientMessageType.EquipItem: {
        const result = this.inventory.equip(profile, message.itemId, message.slot);
        if (!result.ok) this.sendFailure(connection, result.error, message.type);
        else connection.send(this.inventoryMessage(profile));
        break;
      }

      case ClientMessageType.ClaimQuestReward:
        this.handleQuestClaim(connection, profile, message.questId);
        break;

      case ClientMessageType.ClaimLoginReward:
        this.handleLoginClaim(connection, profile);
        break;

      case ClientMessageType.ClaimSeasonReward: {
        const claimed = this.progression.claimSeasonReward(profile, message.seasonId, message.level);
        if (!claimed) {
          connection.sendError(ErrorCode.Forbidden, 'error.forbidden', false, message.type);
        } else {
          connection.send(this.currencyMessage(profile));
          connection.send(this.inventoryMessage(profile));
          connection.send(this.progressionMessage(profile));
        }
        break;
      }

      case ClientMessageType.TalkToNpc:
        this.handleTalk(connection, profile, message.npcId);
        break;

      case ClientMessageType.DialogueChoice:
        this.handleDialogueChoice(connection, profile, message.npcId, message.nodeId, message.optionIndex);
        break;

      case ClientMessageType.SaveSettings:
        profile.settings = message.settings;
        this.profiles.markDirty(playerId);
        break;

      case ClientMessageType.ReportPlayer: {
        const result = this.social.report(
          playerId,
          message.playerId,
          message.reason,
          message.details,
          this.matchByPlayer.get(playerId) ?? null,
        );
        if (!result.ok) this.sendFailure(connection, result.error, message.type);
        else this.notify(connection, 'success', 'report.submitted');
        break;
      }

      case ClientMessageType.BlockPlayer: {
        const result = this.social.setBlocked(profile, message.playerId, message.blocked);
        if (!result.ok) this.sendFailure(connection, result.error, message.type);
        break;
      }

      case ClientMessageType.RequestLeaderboard:
        connection.send({
          type: ServerMessageType.Leaderboard,
          board: message.board,
          seasonId: message.seasonId,
          entries: this.leaderboards.top(message.board, 100),
          selfEntry: this.leaderboards.positionOf(message.board, playerId),
        });
        break;

      case ClientMessageType.RequestProfile:
        this.handleProfileRequest(connection, message.playerId);
        break;

      case ClientMessageType.ChatMessage:
        this.handleChat(connection, profile, message.channel, message.text);
        break;

      case ClientMessageType.SpectateTarget:
        // Spectating is presentation-only: the client already receives every
        // player's snapshot, so this needs no server state.
        break;

      case ClientMessageType.EnterVehicle:
      case ClientMessageType.ExitVehicle:
      case ClientMessageType.VehicleInput:
        this.handleVehicle(playerId, message);
        break;

      default:
        break;
    }
  }

  // ============================================================= handshake ==

  private async handleHandshake(
    connection: Connection,
    message: Extract<ClientMessage, { type: ClientMessageType.Handshake }>,
  ): Promise<void> {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      connection.sendError(ErrorCode.Validation, 'error.protocol_mismatch', true);
      return;
    }

    const now = Date.now();
    let session = message.sessionToken ? this.sessions.resume(message.sessionToken, now) : null;
    const resumed = session !== null;
    if (!session) session = this.sessions.create(message.displayName, message.locale, now);

    // One connection per player: a second login replaces the first.
    const existing = this.connectionByPlayer.get(session.playerId);
    if (existing && existing !== connection) {
      existing.sendError(ErrorCode.Conflict, 'error.conflict', true);
      existing.close(1000, 'replaced');
    }

    connection.session = session;
    this.connectionByPlayer.set(session.playerId, connection);
    this.antiCheat.begin(session.playerId, now);
    this.analytics.recordFunnel(session.playerId, FunnelStep.Connected);

    const loaded = await this.profiles.acquire(session.playerId, message.displayName, now);
    if (!loaded.ok) {
      // Refusing is correct: overwriting an unreadable save would destroy real
      // progress. The player is told to retry rather than silently reset.
      connection.sendError(ErrorCode.Storage, 'error.storage', true);
      log.error('handshake aborted — profile unreadable', { playerId: session.playerId });
      return;
    }

    const profile = loaded.value;
    if (!resumed) profile.displayName = message.displayName;

    // Bring the profile up to date before the client sees any of it.
    this.profiles.rolloverDaily(profile, now);
    this.progression.syncSeason(profile, now);
    this.inventory.sanitize(profile);
    this.quests.refresh(profile, now);
    const loginState = this.loginRewards.registerLogin(profile, now);
    this.leaderboards.upsert(profile);
    this.analytics.recordFunnel(session.playerId, FunnelStep.ProfileLoaded);

    const activeMatchId = session.matchId;
    const match = activeMatchId ? this.matches.get(activeMatchId) : undefined;
    const rejoined = match ? match.instance.markReconnected(session.playerId) : false;

    connection.send({
      type: ServerMessageType.HandshakeAck,
      protocolVersion: PROTOCOL_VERSION,
      playerId: session.playerId,
      sessionToken: session.token,
      serverTimeMs: now,
      tickRate: TICK_RATE,
      resumed,
      activeMatchId: rejoined ? activeMatchId : null,
    });

    connection.send(this.profileSyncMessage(profile, loginState.rewardAvailable, now));
    connection.send(this.shopMessage(profile, now));
    connection.send({ type: ServerMessageType.QuestUpdate, ...this.quests.snapshot(profile, now) });
    connection.send({ type: ServerMessageType.ServerStatus, ...this.statusPayload(), shutdownInMs: null });
    this.analytics.recordFunnel(session.playerId, FunnelStep.EnteredLobby);

    if (rejoined && match) {
      this.matchByPlayer.set(session.playerId, match.instance.id);
      this.sendMatchJoined(connection, match.instance, session.playerId);
      this.notify(connection, 'success', 'network.session_restored');
    }

    log.info('player connected', { playerId: session.playerId, resumed });
  }

  private handlePing(connection: Connection, clientTimeMs: number): void {
    const now = Date.now();
    connection.send({ type: ServerMessageType.Pong, clientTimeMs, serverTimeMs: now });

    // The client reports its own RTT via successive pings; we estimate from the
    // gap between heartbeats as a cross-check the client cannot inflate.
    const playerId = connection.playerId;
    if (!playerId) return;
    const match = this.matchFor(playerId);
    if (match) match.instance.setPing(playerId, connection.roundTripMs);
  }

  // ========================================================== matchmaking ==

  private handleQueueJoin(
    connection: Connection,
    profile: PlayerProfile,
    modeId: string,
    mapIds: string[],
  ): void {
    const mode = getGameMode(modeId);
    if (!mode) {
      connection.sendError(ErrorCode.NotFound, 'error.not_found', false, 'queue_join');
      return;
    }

    const level = levelFromTotalXp(profile.totalXp).level;
    if (level < mode.unlockLevel) {
      connection.sendError(ErrorCode.LevelRequirement, 'error.level_requirement', false, 'queue_join');
      return;
    }

    const party = this.parties.partyOf(profile.id);
    // Only the leader may queue a party, otherwise members fight over the queue.
    if (party && party.leaderId !== profile.id) {
      connection.sendError(ErrorCode.NotPartyLeader, 'error.not_party_leader', false, 'queue_join');
      return;
    }

    const memberIds = party ? party.members.filter((m) => m.online).map((m) => m.playerId) : [profile.id];
    const ratings = memberIds.map((id) => {
      const p = this.profiles.peek(id);
      return MatchmakingService.ratingFor(p?.rankPoints ?? 0, mode.ranked);
    });
    const averageRating = ratings.reduce((a, b) => a + b, 0) / Math.max(1, ratings.length);

    const ticket: QueueTicket = {
      id: party ? party.id : `solo:${profile.id}`,
      playerIds: memberIds,
      modeId,
      rating: averageRating,
      preferredMapIds: mapIds,
      queuedAt: Date.now(),
    };

    const result = this.matchmaking.enqueue(ticket);
    if (!result.ok) {
      this.sendFailure(connection, result.error, 'queue_join');
      return;
    }

    if (party) this.parties.setQueued(party.id, modeId);
    for (const id of memberIds) {
      this.analytics.recordFunnel(id, FunnelStep.QueuedForMatch);
      this.sendTo(id, { type: ServerMessageType.QueueUpdate, ...this.matchmaking.status(id) });
    }
  }

  private processMatchmaking(now: number): void {
    for (const proposal of this.matchmaking.tick(now)) {
      const world = this.worlds.get(proposal.mapId);
      const mode = createGameMode(proposal.modeId);

      const seeds: MatchPlayerSeed[] = [];
      for (const playerId of proposal.playerIds) {
        const profile = this.profiles.peek(playerId);
        if (!profile) continue;
        seeds.push({
          id: playerId,
          displayName: profile.displayName,
          team: proposal.teams.get(playerId) ?? TeamId.None,
          loadout: this.inventory.sanitize(profile),
          rating: MatchmakingService.ratingFor(profile.rankPoints, mode.config.ranked),
        });
      }

      if (seeds.length < mode.config.minPlayers) {
        // Everyone in the proposal disconnected between forming and starting.
        continue;
      }

      const matchId = `m${this.nextMatchNumber++}`;
      const instance = new MatchInstance({
        id: matchId,
        modeId: proposal.modeId,
        mapId: proposal.mapId,
        seed: proposal.seed,
        world,
        mode,
        antiCheat: this.antiCheat,
        players: seeds,
      });

      this.matches.set(matchId, {
        instance,
        snapshots: new SnapshotBuilder(instance),
        finalized: false,
      });
      this.analytics.matchStarted(proposal.modeId, proposal.mapId);

      for (const seed of seeds) {
        this.matchByPlayer.set(seed.id, matchId);
        this.sessions.setMatch(seed.id, matchId);
        this.analytics.recordFunnel(seed.id, FunnelStep.MatchJoined);
        const connection = this.connectionByPlayer.get(seed.id);
        if (connection) this.sendMatchJoined(connection, instance, seed.id);
      }
    }
  }

  private sendMatchJoined(connection: Connection, match: MatchInstance, playerId: string): void {
    const player = match.players.get(playerId);
    connection.send({
      type: ServerMessageType.MatchJoined,
      matchId: match.id,
      modeId: match.modeId,
      mapId: match.mapId,
      team: player?.team ?? TeamId.None,
      seed: match.seed,
      serverTimeMs: Date.now(),
      players: [],
    });
    connection.send({ type: ServerMessageType.MatchState, ...match.matchStatePayload() });
  }

  // ================================================================= ticks ==

  private tick(): void {
    const started = performance.now();
    const now = Date.now();
    this.tickCount++;

    for (const [matchId, match] of Array.from(this.matches.entries())) {
      match.instance.step(now);

      for (const outbound of match.instance.drainOutbound()) {
        if (outbound.to === null) this.broadcastToMatch(matchId, outbound.message);
        else for (const id of outbound.to) this.sendTo(id, outbound.message);
      }

      if (match.instance.phase === MatchPhase.MatchEnd && !match.finalized) {
        this.finalizeMatch(matchId, match, now);
      }
      if (match.instance.isFinished) this.closeMatch(matchId);
    }

    if (this.tickCount % SNAPSHOT_INTERVAL_TICKS === 0) this.broadcastSnapshots(now);

    // Track how much of the tick budget we're using; surfaced in ServerStatus
    // so an operator can see the server struggling before players do.
    const elapsed = performance.now() - started;
    this.tickLoad = this.tickLoad * 0.95 + (elapsed / TICK_MS) * 0.05;
  }

  private broadcastSnapshots(now: number): void {
    for (const match of this.matches.values()) {
      for (const [playerId, snapshot] of match.snapshots.buildAll(now)) {
        this.sendTo(playerId, snapshot);
      }
    }
  }

  private slowTick(): void {
    const now = Date.now();
    this.processMatchmaking(now);

    // Queue status updates.
    for (const [playerId, connection] of this.connectionByPlayer) {
      const status = this.matchmaking.status(playerId, now);
      if (status.inQueue) {
        connection.send({ type: ServerMessageType.QueueUpdate, ...status });
      }
    }

    // Match state updates (score, timer) at 1 Hz — the HUD doesn't need more.
    for (const [matchId, match] of this.matches) {
      this.broadcastToMatch(matchId, {
        type: ServerMessageType.MatchState,
        ...match.instance.matchStatePayload(),
      });
      if (match.instance.mapId !== HUB_MAP_ID) {
        this.broadcastToMatch(matchId, {
          type: ServerMessageType.VehicleState,
          vehicles: [],
        });
      }
    }

    // Drop stale connections and expired sessions.
    for (const connection of Array.from(this.connections.values())) {
      if (connection.isStale(now, CONNECTION_TIMEOUT_MS)) {
        log.info('closing stale connection', { connectionId: connection.id });
        connection.close(1001, 'timeout');
      }
    }
    for (const playerId of this.sessions.prune(now)) {
      this.removeFromMatch(playerId, 'session expired');
      this.parties.leave(playerId);
      this.antiCheat.end(playerId);
    }
    this.parties.pruneOffline(60_000, now);
  }

  // ================================================================ matches ==

  private matchFor(playerId: string): ActiveMatch | null {
    const matchId = this.matchByPlayer.get(playerId);
    return matchId ? this.matches.get(matchId) ?? null : null;
  }

  private finalizeMatch(matchId: string, match: ActiveMatch, now: number): void {
    match.finalized = true;

    const outcomes = this.rewards.finalize(
      match.instance,
      (playerId) => this.profiles.peek(playerId),
      now,
    );

    const results = outcomes.map((o) => o.result);
    for (const outcome of outcomes) {
      const connection = this.connectionByPlayer.get(outcome.playerId);
      if (!connection) continue;

      connection.send({
        type: ServerMessageType.MatchEnded,
        matchId,
        winningTeam: match.instance.winningTeam,
        winningPlayerId: match.instance.winningPlayerId,
        results,
        durationMs: match.instance.elapsedMs,
      });

      const profile = this.profiles.peek(outcome.playerId);
      if (!profile) continue;

      connection.send(this.progressionMessage(profile, outcome.leveledUpTo, outcome.rankChange));
      connection.send(this.currencyMessage(profile));
      connection.send({ type: ServerMessageType.QuestUpdate, ...this.quests.snapshot(profile, now) });
      if (outcome.itemsGranted.length > 0) connection.send(this.inventoryMessage(profile));

      for (const questId of outcome.questsCompleted) {
        this.notify(connection, 'success', 'notify.quest_complete', { name: questId });
      }
      for (const achievementId of outcome.achievementsUnlocked) {
        this.notify(connection, 'success', 'notify.achievement', { name: achievementId });
      }
      this.analytics.recordFunnel(outcome.playerId, FunnelStep.MatchCompleted);
    }
  }

  private closeMatch(matchId: string): void {
    const match = this.matches.get(matchId);
    if (!match) return;
    for (const playerId of match.instance.players.keys()) {
      this.matchByPlayer.delete(playerId);
      this.sessions.setMatch(playerId, null);
    }
    this.matches.delete(matchId);
    log.info('match closed', { matchId });
  }

  private removeFromMatch(playerId: string, reason: string): void {
    const matchId = this.matchByPlayer.get(playerId);
    if (!matchId) return;
    const match = this.matches.get(matchId);
    if (match) {
      // A player who leaves before the end forfeits that match's rewards; the
      // match itself carries on for everyone else.
      match.instance.removePlayer(playerId, reason);
      if (match.instance.activePlayerCount === 0) this.closeMatch(matchId);
    }
    this.matchByPlayer.delete(playerId);
    this.sessions.setMatch(playerId, null);
  }

  // =============================================================== actions ==

  private handlePurchase(
    connection: Connection,
    profile: PlayerProfile,
    itemId: string,
    section: string,
  ): void {
    const result = this.shop.purchase(profile, itemId, section);
    if (!result.ok) {
      this.sendFailure(connection, result.error, 'shop_purchase');
      return;
    }
    connection.send(this.currencyMessage(profile));
    connection.send(this.inventoryMessage(profile));
    connection.send(this.shopMessage(profile));
    this.notify(connection, 'success', 'shop.purchase_success', { item: itemId });
  }

  private handleCrate(connection: Connection, profile: PlayerProfile, crateId: string): void {
    const result = this.crates.open(profile, crateId);
    if (!result.ok) {
      this.sendFailure(connection, result.error, 'open_crate');
      return;
    }
    this.analytics.crateOpened(crateId);
    this.quests.track(profile, { type: ObjectiveType.OpenCrate, target: crateId });

    connection.send({
      type: ServerMessageType.CrateResult,
      crateId: result.value.crateId,
      itemId: result.value.itemId,
      rarity: result.value.rarity,
      duplicate: result.value.duplicate,
      coinsAwarded: result.value.coinsAwarded,
      rates: result.value.rates,
    });
    connection.send(this.inventoryMessage(profile));
    connection.send(this.currencyMessage(profile));
  }

  private handleQuestClaim(connection: Connection, profile: PlayerProfile, questId: string): void {
    const result = this.quests.claim(profile, questId);
    if (!result.ok) {
      this.sendFailure(connection, result.error, 'claim_quest_reward');
      return;
    }
    connection.send(this.currencyMessage(profile));
    connection.send(this.progressionMessage(profile));
    connection.send({ type: ServerMessageType.QuestUpdate, ...this.quests.snapshot(profile) });
    if (result.value.itemsGranted.length > 0) connection.send(this.inventoryMessage(profile));
  }

  private handleLoginClaim(connection: Connection, profile: PlayerProfile): void {
    const result = this.loginRewards.claim(profile);
    if (!result.ok) {
      this.sendFailure(connection, result.error, 'claim_login_reward');
      return;
    }
    connection.send(this.currencyMessage(profile));
    connection.send(this.progressionMessage(profile));
    if (result.value.itemsGranted.length > 0) connection.send(this.inventoryMessage(profile));
    this.notify(connection, 'success', 'notify.reward_received');
  }

  private handleTalk(connection: Connection, profile: PlayerProfile, npcId: string): void {
    const match = this.matchFor(profile.id);
    const position = match?.instance.players.get(profile.id)?.position ?? null;
    const result = this.npcs.talk(profile, npcId, position);
    if (!result.ok) {
      this.sendFailure(connection, result.error, 'talk_to_npc');
      return;
    }
    connection.send({ type: ServerMessageType.DialogueState, ...result.value });
  }

  private handleDialogueChoice(
    connection: Connection,
    profile: PlayerProfile,
    npcId: string,
    nodeId: string,
    optionIndex: number,
  ): void {
    const result = this.npcs.choose(profile, npcId, nodeId, optionIndex);
    if (!result.ok) {
      this.sendFailure(connection, result.error, 'dialogue_choice');
      return;
    }
    const { view } = result.value;
    connection.send({
      type: ServerMessageType.DialogueState,
      npcId,
      nodeId: view?.nodeId ?? null,
      textKey: view?.textKey ?? '',
      options: view?.options ?? [],
    });
    connection.send({ type: ServerMessageType.QuestUpdate, ...this.quests.snapshot(profile) });
  }

  private handleInteract(
    connection: Connection,
    profile: PlayerProfile,
    kind: string,
    targetId: string,
  ): void {
    if (kind === 'npc') {
      this.handleTalk(connection, profile, targetId);
      return;
    }

    if (kind === 'secret') {
      const match = this.matchFor(profile.id);
      const player = match?.instance.players.get(profile.id) ?? null;
      const map = match ? match.instance.map : getMap(HUB_MAP_ID);
      const anchor = map?.secrets.find((s) => s.id === targetId) ?? null;
      if (!anchor) {
        connection.sendError(ErrorCode.NotFound, 'error.not_found', false, 'interact');
        return;
      }

      const result = this.npcs.triggerSecret(
        profile,
        anchor.id,
        anchor.unlocksId,
        anchor.at,
        player?.position ?? null,
      );
      if (!result.ok) {
        this.sendFailure(connection, result.error, 'interact');
        return;
      }
      if (result.value) {
        connection.send({
          type: ServerMessageType.SecretDiscovered,
          secretId: anchor.id,
          questId: anchor.unlocksId,
          nameKey: `quest.${anchor.unlocksId}.name`,
        });
        connection.send({ type: ServerMessageType.QuestUpdate, ...this.quests.snapshot(profile) });
      }
      return;
    }

    if (kind === 'vehicle') {
      const match = this.matchFor(profile.id);
      if (!match) return;
      // "Press E on a vehicle" is the same request as the explicit board
      // message, so it goes through the same validated path.
      const numeric = Number.parseInt(targetId, 10);
      if (Number.isFinite(numeric)) {
        this.handleVehicle(profile.id, {
          type: ClientMessageType.EnterVehicle,
          vehicleId: numeric,
        });
      }
    }
  }

  /**
   * Route a board / drive / exit request to the match's VehicleSystem.
   *
   * Nothing here decides anything: VehicleSystem re-checks proximity, seat
   * availability, liveness and ownership against authoritative state, so a
   * client cannot board a vehicle across the map or drive one it is not in.
   */
  private handleVehicle(playerId: string, message: ClientMessage): void {
    const match = this.matchFor(playerId);
    if (!match) return;

    const player = match.instance.players.get(playerId);
    if (!player) return;

    const vehicles = match.instance.vehicleSystem;

    switch (message.type) {
      case ClientMessageType.EnterVehicle: {
        const vehicle = vehicles.enter(player, message.vehicleId);
        // A refusal is normal (out of range, full, destroyed) and not an error:
        // the client simply stays on foot and the next snapshot says so.
        if (vehicle) this.broadcastVehicleState(match);
        break;
      }

      case ClientMessageType.ExitVehicle:
        vehicles.exit(player);
        this.broadcastVehicleState(match);
        break;

      case ClientMessageType.VehicleInput:
        // Only the driver's input is accepted; setInput ignores a passenger.
        vehicles.setInput(playerId, message.throttle, message.steer, message.brake);
        break;

      default:
        break;
    }
  }

  private broadcastVehicleState(match: ActiveMatch): void {
    match.instance.broadcast({
      type: ServerMessageType.VehicleState,
      vehicles: match.instance.vehicleSystem.snapshot(),
    });
  }

  private handleParty(connection: Connection, profile: PlayerProfile, message: ClientMessage): void {
    const level = levelFromTotalXp(profile.totalXp).level;
    let partyId: string | null = null;

    switch (message.type) {
      case ClientMessageType.PartyCreate: {
        const result = this.parties.create(profile.id, profile.displayName, level);
        if (result.ok) partyId = result.value.id;
        break;
      }
      case ClientMessageType.PartyJoin: {
        const result = this.parties.joinByCode(message.code, profile.id, profile.displayName, level);
        if (!result.ok) {
          this.sendFailure(connection, result.error, message.type);
          return;
        }
        partyId = result.value.id;
        break;
      }
      case ClientMessageType.PartyLeave: {
        const before = this.parties.partyOf(profile.id);
        const after = this.parties.leave(profile.id);
        partyId = after?.id ?? null;
        // Tell the remaining members, and the leaver that they're now solo.
        if (before && !after) connection.send(this.partyMessage(null));
        break;
      }
      case ClientMessageType.PartyKick: {
        const result = this.parties.kick(profile.id, message.playerId);
        if (!result.ok) {
          this.sendFailure(connection, result.error, message.type);
          return;
        }
        partyId = result.value.id;
        this.sendTo(message.playerId, this.partyMessage(null));
        break;
      }
      case ClientMessageType.PartySetReady: {
        const result = this.parties.setReady(profile.id, message.ready);
        if (result.ok) partyId = result.value.id;
        break;
      }
      default:
        return;
    }

    if (partyId) {
      const update = this.partyMessage(partyId);
      for (const memberId of this.parties.memberIds(partyId)) this.sendTo(memberId, update);
    } else {
      connection.send(this.partyMessage(null));
    }
  }

  private handleChat(
    connection: Connection,
    profile: PlayerProfile,
    channel: string,
    text: string,
  ): void {
    const match = this.matchFor(profile.id);
    const team = match?.instance.players.get(profile.id)?.team ?? TeamId.None;

    const payload: ServerMessage = {
      type: ServerMessageType.ChatMessage,
      channel,
      fromId: profile.id,
      fromName: profile.displayName,
      text,
      team,
    };

    const recipients: string[] = [];
    if (channel === 'party') {
      const party = this.parties.partyOf(profile.id);
      if (party) recipients.push(...party.members.map((m) => m.playerId));
    } else if (match) {
      for (const [id, player] of match.instance.players) {
        if (channel === 'team' && player.team !== team) continue;
        recipients.push(id);
      }
    } else {
      recipients.push(profile.id);
    }

    for (const id of recipients) {
      // Blocked and muted players' messages never reach the recipient.
      const target = this.profiles.peek(id);
      if (target && this.social.hasBlocked(target, profile.id)) continue;
      if (this.social.isMuted(id, profile.id)) continue;
      this.sendTo(id, payload);
    }
    void connection;
  }

  private handleProfileRequest(connection: Connection, playerId: string): void {
    const profile = this.profiles.peek(playerId);
    if (!profile) {
      connection.sendError(ErrorCode.NotFound, 'error.not_found', false, 'request_profile');
      return;
    }
    connection.send({
      type: ServerMessageType.PlayerProfile,
      playerId: profile.id,
      displayName: profile.displayName,
      level: levelFromTotalXp(profile.totalXp).level,
      rankPoints: profile.rankPoints,
      title: profile.equippedTitleId,
      stats: this.publicStats(profile),
      achievementIds: profile.unlockedAchievementIds,
    });
  }

  // ============================================================== messages ==

  private profileSyncMessage(
    profile: PlayerProfile,
    loginRewardAvailable: boolean,
    now: number,
  ): ServerMessage {
    return {
      type: ServerMessageType.ProfileSync,
      displayName: profile.displayName,
      settings: profile.settings,
      progression: this.progression.snapshot(profile, now),
      inventory: {
        ownedItemIds: profile.ownedItemIds,
        ownedWeaponIds: profile.ownedWeaponIds,
        ownedAttachmentIds: profile.ownedAttachmentIds,
        ownedCharacterIds: profile.ownedCharacterIds,
        loadout: profile.loadout,
        equippedTitle: profile.equippedTitleId,
      },
      currencies: this.economy.balances(profile),
      stats: this.publicStats(profile),
      achievementIds: profile.unlockedAchievementIds,
      loginStreak: profile.loginStreak,
      loginRewardAvailable,
      discoveredSecretIds: profile.discoveredSecretIds,
      unlockedTitleIds: profile.unlockedTitleIds,
    };
  }

  private publicStats(profile: PlayerProfile) {
    const weaponKills = Object.entries(profile.stats.weaponKills);
    weaponKills.sort((a, b) => b[1] - a[1]);
    return {
      kills: profile.stats.kills,
      deaths: profile.stats.deaths,
      assists: profile.stats.assists,
      wins: profile.stats.wins,
      losses: profile.stats.losses,
      headshots: profile.stats.headshots,
      playtimeMs: profile.stats.playtimeMs,
      bestStreak: profile.stats.bestStreak,
      bestScore: profile.stats.bestScore,
      favoriteWeaponId: weaponKills[0]?.[0] ?? null,
    };
  }

  private inventoryMessage(profile: PlayerProfile): ServerMessage {
    return {
      type: ServerMessageType.InventoryUpdate,
      ownedItemIds: profile.ownedItemIds,
      ownedWeaponIds: profile.ownedWeaponIds,
      ownedAttachmentIds: profile.ownedAttachmentIds,
      ownedCharacterIds: profile.ownedCharacterIds,
      loadout: profile.loadout,
      equippedTitle: profile.equippedTitleId,
    };
  }

  /**
   * The live storefront for this player.
   *
   * Rebuilt per request rather than cached: the rotation is a pure function of
   * the clock, and ownership/affordability are per-player, so a shared cache
   * would have to be invalidated on every purchase anyway.
   */
  private shopMessage(profile: PlayerProfile, now = Date.now()): ServerMessage {
    const storefront = this.shop.storefront(profile, now);
    const rotation = this.shop.nextRotationAt(now);

    const sections: Record<string, ServerShopEntry[]> = {};
    for (const [section, entries] of Object.entries(storefront)) {
      sections[section] = entries.map((e) => ({
        itemId: e.itemId,
        section: e.section,
        currency: e.currency,
        price: e.price,
        basePrice: e.basePrice,
        discountPercent: e.discountPercent,
        unlockLevel: e.unlockLevel,
        owned: e.owned ?? false,
        purchasable: e.purchasable ?? false,
      }));
    }

    return {
      type: ServerMessageType.ShopUpdate,
      sections,
      dailyRefreshAtMs: rotation.daily,
      weeklyRefreshAtMs: rotation.weekly,
    };
  }

  private currencyMessage(profile: PlayerProfile): ServerMessage {
    return { type: ServerMessageType.CurrencyUpdate, balances: this.economy.balances(profile) };
  }

  private progressionMessage(
    profile: PlayerProfile,
    leveledUpTo: number | null = null,
    rankChanged: { from: string; to: string; promoted: boolean } | null = null,
  ): ServerMessage {
    return {
      type: ServerMessageType.ProgressionUpdate,
      ...this.progression.snapshot(profile),
      leveledUpTo,
      rankChanged,
    };
  }

  private partyMessage(partyId: string | null): ServerMessage {
    const party = partyId ? this.parties.get(partyId) : null;
    return {
      type: ServerMessageType.PartyUpdate,
      partyId: party?.id ?? null,
      code: party?.code ?? null,
      members:
        party?.members.map((m) => ({
          playerId: m.playerId,
          displayName: m.displayName,
          level: m.level,
          ready: m.ready,
          isLeader: party.leaderId === m.playerId,
          online: m.online,
        })) ?? [],
      maxSize: MAX_PARTY_SIZE,
    };
  }

  private notify(
    connection: Connection,
    level: 'info' | 'success' | 'warning',
    messageKey: string,
    params?: Record<string, string | number>,
  ): void {
    connection.send({
      type: ServerMessageType.Notification,
      level,
      messageKey,
      params,
      durationMs: 4000,
    });
  }

  private sendFailure(
    connection: Connection,
    error: { code: ErrorCode; messageKey: string; params?: Record<string, string | number>; detail: string },
    inResponseTo: string,
  ): void {
    this.analytics.errorOccurred(error.code);
    log.debug('action failed', { code: error.code, detail: error.detail });
    connection.send({
      type: ServerMessageType.Error,
      code: error.code,
      messageKey: error.messageKey,
      params: error.params,
      inResponseTo,
      fatal: false,
    });
  }

  private sendTo(playerId: string, message: ServerMessage): void {
    this.connectionByPlayer.get(playerId)?.send(message);
  }

  private broadcastToMatch(matchId: string, message: ServerMessage): void {
    const match = this.matches.get(matchId);
    if (!match) return;
    for (const playerId of match.instance.players.keys()) this.sendTo(playerId, message);
  }

  // ================================================================ status ==

  statusPayload() {
    return {
      serverTimeMs: Date.now(),
      tickRate: TICK_RATE,
      load: Math.min(1, this.tickLoad),
      playersOnline: this.connectionByPlayer.size,
      matchesActive: this.matches.size,
      region: this.options.region,
    };
  }

  /** Diagnostics for the operator/dev tools. */
  diagnostics() {
    const season = activeSeason(Date.now());
    return {
      ...this.statusPayload(),
      sessions: this.sessions.totalCount,
      cachedProfiles: this.profiles.cachedCount,
      queued: this.matchmaking.totalQueued,
      queueSizes: this.matchmaking.queueSizes(),
      parties: this.parties.count,
      worldsLoaded: this.worlds.loadedCount,
      flaggedPlayers: this.antiCheat.flagged().length,
      reports: this.social.reportCount,
      seasonId: season?.id ?? null,
      analytics: this.options.devTools ? this.analytics.summary() : null,
      currencies: [Currency.Coins, Currency.Cores],
    };
  }

  get matchCount(): number {
    return this.matches.size;
  }

  get playerCount(): number {
    return this.connectionByPlayer.size;
  }
}
