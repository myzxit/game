/**
 * The client application.
 *
 * Owns the frame loop and the state machine (boot -> login -> menu -> match ->
 * results), and routes server messages to the systems that care about them.
 *
 * The frame loop does three things in order:
 *   1. sample input and step the *predicted* local simulation immediately, so
 *      the game responds on the same frame as the key press,
 *   2. interpolate remote players to a fixed delay in the past, so they move
 *      smoothly,
 *   3. render, and send the accumulated inputs to the server.
 *
 * Prediction correctness depends entirely on this file running the exact same
 * `stepMovement`/`stepWeapon` the server runs — which is why they live in
 * @titan/shared and are imported here rather than reimplemented.
 */

import * as THREE from 'three';
import {
  CollisionWorld,
  Currency,
  DEFAULT_LOADOUT,
  DEFAULT_MOVEMENT,
  HUB_MAP_ID,
  InputButton,
  MatchPhase,
  MovementState,
  ServerMessageType,
  SurfaceMaterial,
  TICK_MS,
  TeamId,
  clamp,
  createLogger,
  effectiveMovement,
  enableConsoleLogging,
  eyePosition,
  getCharacter,
  getMap,
  getGameMode,
  getSkill,
  getWeapon,
  reloadProgress,
  requireMap,
  resolveWeapon,
  setLocale,
  t,
  vec3,
  volumesToBrushes,
  WeaponPhase,
  applyDeltaSnapshot,
  type DeltaSnapshot,
  type MapDefinition,
  type PlayerInput,
  type ResolvedWeapon,
  type ServerMessage,
  type ServerSnapshot,
  type Vec3,
  ClientMessageType,
  LogLevel,
} from '@titan/shared';

import { SettingsStore, suggestPreset, type Settings } from './Settings.js';
import { assets } from './AssetManifest.js';
import { Renderer } from '../render/Renderer.js';
import { CameraController } from '../render/CameraController.js';
import { ViewModel } from '../render/ViewModel.js';
import { VfxSystem } from '../render/Vfx.js';
import { buildCharacter, disposeCharacter, poseCharacter, type CharacterRig } from '../render/CharacterModels.js';
import { InputManager } from '../input/InputManager.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { MusicEngine } from '../audio/MusicEngine.js';
import { NetClient, type ConnectionState } from '../net/NetClient.js';
import { PredictionSystem } from '../net/Prediction.js';
import { EntityInterpolator, type InterpolatedPlayer } from '../net/EntityInterpolation.js';
import { Hud } from '../ui/Hud.js';
import { MinimapRenderer } from '../ui/Minimap.js';
import { Notifications } from '../ui/Notifications.js';
import { Screens } from '../ui/Screens.js';

const log = createLogger('Game');

interface RemoteEntity {
  rig: CharacterRig;
  lastSeen: number;
}

export class Game {
  private readonly settings = new SettingsStore();
  private readonly renderer: Renderer;
  private readonly camera: CameraController;
  private readonly viewModel = new ViewModel();
  private readonly vfx: VfxSystem;
  private readonly input: InputManager;
  private readonly audio: AudioEngine;
  private readonly music = new MusicEngine();
  private readonly net: NetClient;
  private readonly interpolator = new EntityInterpolator();
  private readonly hud: Hud;
  private readonly minimap: MinimapRenderer;
  private readonly notifications: Notifications;
  private readonly screens: Screens;

  private prediction: PredictionSystem;
  private world: CollisionWorld | null = null;
  private currentMap: MapDefinition | null = null;

  /** Match state. */
  private matchId: string | null = null;
  private modeId: string | null = null;
  private team = TeamId.None;
  private matchPhase: MatchPhase = MatchPhase.Warmup;
  private matchState = {
    timeRemainingMs: 0,
    alphaScore: 0,
    bravoScore: 0,
    round: 1,
    roundsWonAlpha: 0,
    roundsWonBravo: 0,
    objectives: [] as { id: string; owner: TeamId; progress: number; contested: boolean }[],
  };

  /** Local player state. */
  private yaw = 0;
  private pitch = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private health = 100;
  private maxHealth = 100;
  private shield = 0;
  private maxShield = 50;
  private alive = true;
  private respawnInMs = 0;
  private activeSlot = 0;
  private weapons: (ResolvedWeapon | null)[] = [null, null, null];
  private skillCooldownMs = 0;
  private skillCooldownTotalMs = 1;
  private skillEnergy = 100;
  private lastLandImpact = 0;
  private footstepAccumulator = 0;

  private inputSequence = 0;
  private lastAckedSnapshot = -1;
  private readonly pendingInputs: PlayerInput[] = [];

  /**
   * Recently reconstructed snapshots, keyed by id, so a delta can be applied to
   * the exact base the server named.
   *
   * Keeping only the newest snapshot is not enough: an ack takes half a round
   * trip to arrive, so the server is still deltaing against a snapshot several
   * older than the client's latest. With a single base almost every delta
   * failed to apply and fell back to a full resend, which costs more bandwidth
   * than sending no deltas at all.
   */
  private readonly snapshotHistory = new Map<number, ServerSnapshot>();
  /** Matches the server's history depth; a few seconds at 20 Hz. */
  private static readonly SNAPSHOT_HISTORY = 64;
  private deltaResyncs = 0;

  private readonly remoteEntities = new Map<string, RemoteEntity>();

  /** Frame timing. */
  private lastFrameTime = 0;
  private accumulatedSendTime = 0;
  private running = false;
  private frameHandle = 0;

  /** Scratch vectors, reused every frame to avoid per-frame allocation. */
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchC = new THREE.Vector3();

  private devPanel: HTMLElement | null = null;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, serverUrl: string) {
    enableConsoleLogging(import.meta.env?.DEV ? LogLevel.Debug : LogLevel.Info);

    // Pick a starting preset from the device, then let the player override.
    const suggested = suggestPreset();
    if (!this.hasStoredSettings()) this.settings.applyPreset(suggested);
    setLocale(this.settings.current.locale);

    const settings = this.settings.current;
    this.renderer = new Renderer(canvas, settings);
    this.camera = new CameraController(this.renderer.camera, settings.gameplay, settings.accessibility);
    this.vfx = new VfxSystem(settings.graphics, settings.accessibility);
    this.input = new InputManager(canvas, settings);
    this.audio = new AudioEngine(settings.audio);
    this.net = new NetClient(serverUrl, {
      onMessage: (message) => this.onServerMessage(message),
      onStateChange: (state, detail) => this.onConnectionState(state, detail),
      onFatal: (key) => this.notifications.showConnectionProblem(key, undefined, null),
    });

    this.prediction = new PredictionSystem(vec3(0, 2, 0), 0);

    this.hud = new Hud(uiRoot, settings.gameplay, settings.accessibility);
    this.minimap = new MinimapRenderer(this.hud.minimapCanvas);
    this.notifications = new Notifications(uiRoot);
    this.screens = new Screens(uiRoot, this.settings, {
      onLogin: (name) => this.login(name),
      onQueue: (modeId, mapIds) => this.net.send({ type: ClientMessageType.QueueJoin, modeId, mapIds }),
      onCancelQueue: () => this.net.send({ type: ClientMessageType.QueueLeave }),
      onEquip: (itemId, slot) => this.net.send({ type: ClientMessageType.EquipItem, itemId, slot }),
      onPurchase: (itemId, section) =>
        this.net.send({ type: ClientMessageType.ShopPurchase, itemId, section }),
      onOpenCrate: (crateId) => this.net.send({ type: ClientMessageType.OpenCrate, crateId }),
      onClaimQuest: (questId) => this.net.send({ type: ClientMessageType.ClaimQuestReward, questId }),
      onClaimLogin: () => this.net.send({ type: ClientMessageType.ClaimLoginReward }),
      onPartyCreate: () => this.net.send({ type: ClientMessageType.PartyCreate }),
      onPartyJoin: (code) => this.net.send({ type: ClientMessageType.PartyJoin, code }),
      onPartyLeave: () => this.net.send({ type: ClientMessageType.PartyLeave }),
      onSettingsChanged: () => this.applySettings(),
      onRequestLeaderboard: (board) =>
        this.net.send({
          type: ClientMessageType.RequestLeaderboard,
          board: board as 'rank',
          seasonId: null,
        }),
      onReturnToMenu: () => this.returnToMenu(),
    });

    // Push settings to the server so they follow the player between machines.
    this.settings.onSync = () => {
      if (this.net.isConnected) {
        this.net.send({
          type: ClientMessageType.SaveSettings,
          settings: this.settings.toPayload(),
        });
      }
    };

    this.renderer.onQualityDowngrade = (from, to) => {
      this.settings.applyPreset(to as 'low' | 'medium');
      this.applySettings();
      this.notifications.push(
        'warning',
        `${t('settings.graphics.preset')}: ${from} → ${to}`,
        5000,
      );
    };

    this.renderer.camera.add(this.viewModel.root);
    this.renderer.scene.add(this.renderer.camera);
    this.renderer.scene.add(this.vfx.root);

    this.input.onPointerLockChange = (locked) => {
      // Losing pointer lock mid-match means the player alt-tabbed or hit Esc;
      // pause input rather than leaving them running into a wall.
      if (!locked && this.screens.activeScreen === 'match') this.input.setEnabled(false);
    };

    this.setupGlobalHandlers();
  }

  private hasStoredSettings(): boolean {
    try {
      return localStorage.getItem('titan.settings.v1') !== null;
    } catch {
      return false;
    }
  }

  private setupGlobalHandlers(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void this.audio.suspend();
      else void this.audio.resume();
    });

    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape') return;
      if (this.notifications.isOverlayOpen) {
        this.notifications.closeOverlay();
        return;
      }
      if (this.screens.activeScreen === 'match') {
        this.input.exitPointerLock();
        this.input.setEnabled(false);
      }
    });

    // Any click starts audio (browsers require a gesture) and re-acquires
    // pointer lock if we're in a match.
    window.addEventListener('click', () => {
      void this.audio.start().then((started) => {
        if (started) {
          this.music.attach(
            (this.audio as unknown as { context: AudioContext }).context,
            (this.audio as unknown as { buses: Map<string, { gain: GainNode }> }).buses.get('music')!
              .gain,
          );
          this.music.setVolume(this.settings.current.audio.music);
        }
      });
      if (this.screens.activeScreen === 'match' && !this.input.hasPointerLock && this.alive) {
        this.input.requestPointerLock();
        this.input.setEnabled(true);
      }
    });
  }

  // ================================================================== boot

  async start(): Promise<void> {
    this.running = true;
    document.getElementById('preboot')?.classList.add('hidden');

    const report = assets.report();
    this.screens.setBootProgress(0.2, 'boot.loading_assets');
    this.screens.setBootTip(
      report.procedural > 0
        ? `${t('boot.tip')}: ${report.procedural}/${report.total} asset groups are procedural placeholders in this build.`
        : t('boot.tip'),
    );

    // Preload the hub so the first transition into it is instant.
    await this.nextFrame();
    this.screens.setBootProgress(0.6, 'boot.building_world');
    await this.nextFrame();

    this.screens.setBootProgress(1, 'boot.ready');
    await this.delay(200);

    this.screens.show('login');
    this.loop(performance.now());
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private login(displayName: string): void {
    this.screens.rememberName(displayName);
    this.screens.setBootProgress(0.3, 'boot.connecting');
    this.screens.show('boot');
    this.net.connect(displayName, this.settings.current.locale);
  }

  // ============================================================ connection

  private onConnectionState(state: ConnectionState, detail?: { attempt: number; max: number }): void {
    log.info('connection state', { state });

    switch (state) {
      case 'connected':
        this.notifications.closeOverlay();
        if (this.screens.activeScreen === 'boot') this.screens.show('menu');
        break;
      case 'reconnecting':
        this.notifications.showConnectionProblem(
          'network.reconnecting',
          { attempt: detail?.attempt ?? 1, max: detail?.max ?? 1 },
          null,
        );
        break;
      case 'failed':
        this.notifications.showConnectionProblem('network.reconnect_failed', undefined, () =>
          this.net.retry(),
        );
        break;
      default:
        break;
    }
  }

  // ======================================================= server messages

  private onServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case ServerMessageType.ProfileSync:
        this.screens.setProfile(message);
        // Settings stored server-side win on a fresh device.
        if (Object.keys(message.settings).length > 0) {
          this.settings.fromPayload(message.settings);
          this.applySettings();
        }
        this.buildWeapons(message.inventory.loadout);
        this.music.play('music.menu');
        break;

      case ServerMessageType.MatchJoined:
        this.enterMatch(message.matchId, message.modeId, message.mapId, message.team);
        break;

      case ServerMessageType.MatchState:
        this.matchPhase = message.phase;
        this.matchState = {
          timeRemainingMs: message.timeRemainingMs,
          alphaScore: message.scores[String(TeamId.Alpha)] ?? 0,
          bravoScore: message.scores[String(TeamId.Bravo)] ?? 0,
          round: message.round,
          roundsWonAlpha: message.roundsWon[String(TeamId.Alpha)] ?? 0,
          roundsWonBravo: message.roundsWon[String(TeamId.Bravo)] ?? 0,
          objectives: message.objectives,
        };
        if (message.phase === MatchPhase.Live && this.music.currentTrack !== 'music.combat') {
          this.music.play('music.combat');
        }
        break;

      case ServerMessageType.Snapshot:
        this.onSnapshot(message);
        break;

      case ServerMessageType.CombatEvent:
        this.onCombatEvent(message.event);
        break;

      case ServerMessageType.KillFeed:
        this.hud.addKillfeed(message);
        break;

      case ServerMessageType.MatchEnded: {
        const self = message.results.find((r) => r.playerId === this.net.playerId);
        const won = message.winningTeam === this.team || message.winningPlayerId === this.net.playerId;
        this.music.play(won ? 'music.victory' : 'music.defeat');
        this.exitMatch();
        this.screens.showResults(
          message.results,
          this.net.playerId ?? '',
          won,
          self?.xpEarned ?? 0,
          self?.coinsEarned ?? 0,
          self?.rankDelta ?? 0,
        );
        break;
      }

      case ServerMessageType.QueueUpdate:
        this.screens.setQueueStatus({
          inQueue: message.inQueue,
          queuedMs: message.queuedMs,
          found: message.playersFound,
          needed: message.playersNeeded,
        });
        break;

      case ServerMessageType.PartyUpdate:
        this.screens.setParty(
          message.partyId
            ? {
                code: message.code,
                members: message.members.map((m) => ({
                  displayName: m.displayName,
                  isLeader: m.isLeader,
                  ready: m.ready,
                })),
              }
            : null,
        );
        break;

      case ServerMessageType.CurrencyUpdate:
        this.screens.setCurrencies(message.balances);
        break;

      case ServerMessageType.InventoryUpdate:
        this.screens.setInventory({
          ownedItemIds: message.ownedItemIds,
          ownedWeaponIds: message.ownedWeaponIds,
          ownedAttachmentIds: message.ownedAttachmentIds,
          ownedCharacterIds: message.ownedCharacterIds,
          loadout: message.loadout,
          equippedTitle: message.equippedTitle,
        });
        this.buildWeapons(message.loadout);
        break;

      case ServerMessageType.QuestUpdate:
        this.screens.setQuests(message.quests);
        break;

      case ServerMessageType.ShopUpdate:
        this.screens.setShop(message.sections as unknown as Record<string, unknown[]>);
        break;

      case ServerMessageType.ProgressionUpdate:
        if (message.leveledUpTo !== null) {
          this.audio.ui('ui.levelup');
          void this.notifications.showLevelUp(message.leveledUpTo, []);
        }
        if (message.rankChanged) {
          this.audio.ui('ui.rankup');
          void this.notifications.showRankChange(
            message.rankChanged.from,
            message.rankChanged.to,
            message.rankChanged.promoted,
          );
        }
        break;

      case ServerMessageType.CrateResult:
        this.audio.ui('ui.reward');
        void this.notifications.showCrateResult(message);
        break;

      case ServerMessageType.SecretDiscovered:
        this.audio.ui('ui.quest_complete');
        void this.notifications.showSecretDiscovered(message.nameKey);
        break;

      case ServerMessageType.Notification:
        this.audio.ui('ui.notification');
        this.notifications.pushKey(message.level, message.messageKey, message.params, message.durationMs);
        break;

      case ServerMessageType.Leaderboard:
        this.screens.setLeaderboard(message.entries);
        break;

      case ServerMessageType.DialogueState:
        if (message.nodeId) {
          this.notifications.showDialogue(
            `npc.${message.npcId.replace('npc_', '')}.name`,
            message.textKey,
            message.options,
            (index) =>
              this.net.send({
                type: ClientMessageType.DialogueChoice,
                npcId: message.npcId,
                nodeId: message.nodeId!,
                optionIndex: index,
              }),
          );
        } else {
          this.notifications.closeOverlay();
        }
        break;

      case ServerMessageType.Error:
        if (!message.fatal) {
          this.audio.ui('ui.error');
          this.notifications.pushKey('warning', message.messageKey, message.params);
        }
        break;

      case ServerMessageType.ServerStatus:
        if (message.shutdownInMs !== null) {
          this.notifications.push('warning', t('network.server_status'), 8000);
        }
        break;

      default:
        break;
    }
  }

  private onSnapshot(wire: Extract<ServerMessage, { type: ServerMessageType.Snapshot }>): void {
    // The server delta-compresses against the snapshot we last acknowledged, so
    // a wire snapshot's player list may hold partial entries. Rebuild the full
    // state before anything reads it.
    const base = wire.baseId >= 0 ? (this.snapshotHistory.get(wire.baseId) ?? null) : null;
    const snapshot = applyDeltaSnapshot(base, wire as DeltaSnapshot);

    if (!snapshot) {
      // We don't hold the base this delta references — it aged out of our
      // history, or the packet carrying it was dropped. Acknowledge -1 so the
      // server resends in full, and skip this snapshot rather than rendering
      // partial state.
      this.deltaResyncs += 1;
      this.snapshotHistory.clear();
      this.lastAckedSnapshot = -1;
      this.net.send({ type: ClientMessageType.AckSnapshot, snapshotId: -1 });
      return;
    }

    // Snapshots can arrive out of order; an older one must not overwrite what
    // we've already applied.
    if (snapshot.id <= this.lastAckedSnapshot) return;

    this.snapshotHistory.set(snapshot.id, snapshot);
    while (this.snapshotHistory.size > Game.SNAPSHOT_HISTORY) {
      const oldest = this.snapshotHistory.keys().next().value;
      if (oldest === undefined) break;
      this.snapshotHistory.delete(oldest);
    }

    this.lastAckedSnapshot = snapshot.id;
    this.net.send({ type: ClientMessageType.AckSnapshot, snapshotId: snapshot.id });

    const local = snapshot.local;
    this.health = local.health;
    this.shield = local.shield;
    this.skillCooldownMs = local.skillCooldownMs;
    this.skillEnergy = local.skillEnergy;
    this.recoilPitch = local.recoilPitch;
    this.recoilYaw = local.recoilYaw;
    this.respawnInMs = local.respawnInMs;

    // Death and respawn transitions.
    if (this.alive && !local.alive) {
      this.alive = false;
      this.camera.onDeath();
      this.audio.play('sfx.player.death');
      this.music.duckFor(0.8);
      this.viewModel.setVisible(false);
      this.input.setEnabled(false);
    } else if (!this.alive && local.alive) {
      this.alive = true;
      this.camera.onRespawn();
      this.prediction.teleport(local.position, this.yaw);
      this.audio.play('sfx.player.spawn');
      this.viewModel.setVisible(true);
      this.input.setEnabled(true);
      this.input.requestPointerLock();
    }

    if (this.activeSlot !== local.weaponSlot) {
      this.activeSlot = local.weaponSlot;
      const weapon = this.weapons[this.activeSlot];
      if (weapon) {
        this.viewModel.setWeapon(weapon, null);
        this.prediction.setWeapon(weapon);
        this.audio.play('sfx.weapon.equip');
      }
    }

    // Reconcile the predicted local state against the authoritative one.
    if (this.world) {
      this.prediction.reconcile(local, this.world, this.movementProfile(), this.weapons[this.activeSlot]);
    }

    this.interpolator.ingest(snapshot.players, snapshot.serverTimeMs, this.net.playerId);
  }

  private onCombatEvent(
    event: Extract<ServerMessage, { type: ServerMessageType.CombatEvent }>['event'],
  ): void {
    switch (event.kind) {
      case 'hit':
        this.hud.showHitmarker(event.zone, event.lethal);
        this.audio.ui(event.zone === 'head' ? 'sfx.hit.headshot' : 'sfx.hit.marker');
        break;

      case 'damaged': {
        this.hud.showDamage(
          { x: event.fromDirection[0], y: event.fromDirection[1], z: event.fromDirection[2] },
          this.yaw,
          event.amount,
        );
        this.audio.play('sfx.player.hurt');
        this.camera.addShake(0.008 * clamp(event.amount / 40, 0.3, 1.6), 0.2);
        break;
      }

      case 'impact': {
        const at = { x: event.at[0], y: event.at[1], z: event.at[2] };
        const normal = { x: event.normal[0], y: event.normal[1], z: event.normal[2] };
        this.vfx.impact(at, normal, event.material);
        this.audio.impact(event.material, at);
        if (event.material === SurfaceMaterial.Glass) this.vfx.glassBreak(at);
        break;
      }

      case 'shot': {
        // Another player's shot: draw the tracer from their muzzle and play
        // the report at their position.
        if (event.shooterId === this.net.playerId) break;
        const origin = new THREE.Vector3(event.origin[0], event.origin[1], event.origin[2]);
        const direction = new THREE.Vector3(event.direction[0], event.direction[1], event.direction[2]);
        const end = origin.clone().addScaledVector(direction, 60);
        this.vfx.tracer(origin, end);
        this.vfx.muzzleFlash(origin, direction, 0.8);
        this.audio.weaponFire(event.weaponId, { x: origin.x, y: origin.y, z: origin.z });
        this.music.duckFor(0.35);
        break;
      }

      case 'killed':
        if (event.killerId === this.net.playerId) {
          this.audio.ui('sfx.hit.kill');
        }
        break;

      case 'respawn': {
        this.vfx.spawnEffect({ x: event.at[0], y: event.at[1], z: event.at[2] });
        break;
      }

      case 'skill': {
        const at = { x: event.at[0], y: event.at[1], z: event.at[2] };
        const skill = getSkill(event.skillId);
        if (skill) {
          this.audio.play(skill.sfxKey, at);
          if (skill.id === 'skill_scan_pulse') {
            this.vfx.scanPulse(at, skill.params.radius ?? 25);
          } else if (skill.id === 'skill_pulse_dash') {
            this.vfx.dashTrail(at);
          } else if (skill.id === 'skill_ion_charge') {
            this.vfx.explosion(at, skill.params.radius ?? 4);
            const distance = this.scratchA
              .set(at.x, at.y, at.z)
              .distanceTo(this.renderer.camera.position);
            this.camera.addExplosionShake(distance, skill.params.radius ?? 4);
          }
        }
        break;
      }

      case 'streak':
        if (event.playerId === this.net.playerId) {
          this.hud.announce(t('hud.killstreak', { count: event.count }), 1.6);
        }
        break;

      case 'multikill':
        if (event.playerId === this.net.playerId) {
          const key = event.count === 2 ? 'hud.doublekill' : event.count === 3 ? 'hud.triplekill' : 'hud.multikill';
          this.hud.announce(t(key, { count: event.count }), 1.6);
        }
        break;

      default:
        break;
    }
  }

  // ================================================================= match

  private enterMatch(matchId: string, modeId: string, mapId: string, team: TeamId): void {
    log.info('entering match', { matchId, mapId, modeId });

    this.matchId = matchId;
    this.modeId = modeId;
    this.team = team;

    // Snapshot ids restart per match, so a base carried over from the previous
    // one could be matched by id and silently mixed into the new match's state.
    this.snapshotHistory.clear();
    this.lastAckedSnapshot = -1;

    const map = getMap(mapId) ?? requireMap('foundry_reach');
    this.currentMap = map;
    this.world = new CollisionWorld(volumesToBrushes(map.volumes));

    this.renderer.loadMap(map);
    this.minimap.setMap(map);
    this.vfx.clear();
    this.interpolator.clear();
    this.clearRemoteEntities();

    // Spawn is corrected by the first snapshot; this only avoids a frame at
    // the origin.
    const spawn = map.spawns.find((s) => s.team === team) ?? map.spawns[0]!;
    this.prediction.reset(spawn.at, spawn.yaw);
    this.yaw = spawn.yaw;
    this.pitch = 0;
    this.alive = true;

    const weapon = this.weapons[0];
    if (weapon) {
      this.viewModel.setWeapon(weapon, null);
      this.prediction.setWeapon(weapon);
    }

    this.audio.setAmbience(map.environment.ambienceKeys);
    this.music.play('music.combat');

    this.screens.show('match');
    this.hud.setVisible(true);
    this.viewModel.setVisible(true);
    this.input.setEnabled(true);
    this.input.requestPointerLock();
    this.input.enableTouchControls(document.getElementById('ui-root')!);
  }

  private exitMatch(): void {
    this.matchId = null;
    this.hud.setVisible(false);
    this.viewModel.setVisible(false);
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.audio.stopAmbience();
    this.clearRemoteEntities();
    this.interpolator.clear();
  }

  private returnToMenu(): void {
    this.screens.show('menu');
    this.music.play('music.menu');
  }

  private clearRemoteEntities(): void {
    for (const entity of this.remoteEntities.values()) {
      this.renderer.remove(entity.rig.root);
      disposeCharacter(entity.rig);
    }
    this.remoteEntities.clear();
  }

  private buildWeapons(loadout: typeof DEFAULT_LOADOUT): void {
    const ids = [loadout.primaryWeaponId, loadout.secondaryWeaponId, loadout.meleeWeaponId];
    this.weapons = ids.map((id) => resolveWeapon(id, loadout.attachments[id] ?? {}));
    const weapon = this.weapons[this.activeSlot];
    if (weapon) {
      this.viewModel.setWeapon(weapon, loadout.weaponSkins[weapon.baseId] ?? null);
      this.prediction.setWeapon(weapon);
    }
  }

  private movementProfile() {
    const character = getCharacter(this.weaponsCharacterId);
    const weapon = this.weapons[this.activeSlot];
    return effectiveMovement(
      DEFAULT_MOVEMENT,
      character?.moveSpeedMultiplier ?? 1,
      weapon?.mobility ?? 1,
    );
  }

  private weaponsCharacterId = DEFAULT_LOADOUT.characterId;

  // ================================================================== loop

  private loop = (now: number): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.loop);

    const rawDt = this.lastFrameTime > 0 ? (now - this.lastFrameTime) / 1000 : 1 / 60;
    // Clamp so a background tab or a hitch doesn't produce a giant step.
    const dt = Math.min(rawDt, 0.1);
    this.lastFrameTime = now;

    // FPS limiter, for battery life and to keep weak GPUs cool.
    const limit = this.settings.current.graphics.fpsLimit;
    if (limit > 0 && rawDt < 1 / (limit + 1)) return;

    this.notifications.update(now);
    this.hud.update(dt, now);
    this.music.update(dt);

    if (this.screens.activeScreen === 'match' && this.world) {
      this.stepMatchFrame(dt, now);
    }

    this.vfx.update(dt, this.renderer.camera.position);
    const stats = this.renderer.render(now);

    if (this.screens.activeScreen === 'match') {
      this.hud.updateNetwork(this.net.roundTripMs, stats.fps);
      this.updateDevPanel(stats.fps, stats.drawCalls);
    }
  };

  private stepMatchFrame(dt: number, now: number): void {
    const world = this.world!;
    const weapon = this.weapons[this.activeSlot];
    const profile = this.movementProfile();
    const runtime = this.prediction.weaponRuntime;
    const adsActive = (runtime?.adsProgress ?? 0) > 0.5;

    // ---- Input ------------------------------------------------------------
    const frame = this.input.poll(dt, adsActive);

    this.yaw += frame.deltaYaw;
    this.pitch = clamp(this.pitch + frame.deltaPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

    if (frame.requestedSlot !== null && frame.requestedSlot !== this.activeSlot) {
      this.net.send({ type: ClientMessageType.SwitchWeapon, slot: frame.requestedSlot });
    }
    if ((frame.buttons & InputButton.Skill) !== 0 && this.skillCooldownMs <= 0) {
      this.net.send({ type: ClientMessageType.UseSkill, aimYaw: this.yaw, aimPitch: this.pitch });
    }
    if ((frame.buttons & InputButton.Inspect) !== 0) this.viewModel.inspect();

    // ---- Predict ----------------------------------------------------------
    if (this.alive) {
      this.inputSequence++;
      const input = this.input.buildInput(
        frame,
        this.inputSequence,
        Math.min(dt * 1000, 50),
        this.yaw,
        this.pitch,
      );

      const before = this.prediction.state;
      const wasGrounded = before.grounded;

      const result = this.prediction.applyInput(input, world, profile, weapon);
      this.pendingInputs.push(input);

      const state = this.prediction.state;

      // Local feedback for predicted events — these fire immediately rather
      // than waiting for the server, which is the whole point of prediction.
      if (result.shotsFired > 0 && weapon) {
        this.onLocalShot(weapon, result.shotsFired);
      }
      if (result.dryFired) this.audio.play('sfx.weapon.dryfire');
      if (result.reloadCompleted) this.audio.play('sfx.weapon.reload_magin');

      // Landing.
      if (!wasGrounded && state.grounded && state.landedSpeed > 0) {
        this.lastLandImpact = state.landedSpeed;
        this.audio.play('sfx.player.land', state.position, clamp(state.landedSpeed / 20, 0.2, 1));
      } else {
        this.lastLandImpact = 0;
      }

      // Footsteps, timed by distance so they match the animation cadence.
      const speed = Math.hypot(state.velocity.x, state.velocity.z);
      if (state.grounded && speed > 0.8) {
        this.footstepAccumulator += speed * dt;
        const stride = state.state === MovementState.Sprint ? 2.1 : 1.6;
        if (this.footstepAccumulator >= stride) {
          this.footstepAccumulator = 0;
          const material = world.materialUnder(state.position);
          this.audio.footstep(material, state.position, state.state === MovementState.Sprint);
        }
      }
    }

    this.prediction.updateSmoothing(dt);

    // ---- Send -------------------------------------------------------------
    // Batch inputs at roughly the tick rate rather than every frame: at 240fps
    // that would be four times more packets than the server can consume.
    this.accumulatedSendTime += dt * 1000;
    if (this.accumulatedSendTime >= TICK_MS && this.pendingInputs.length > 0) {
      this.accumulatedSendTime = 0;
      this.net.send({
        type: ClientMessageType.Input,
        inputs: this.pendingInputs.splice(0, 12),
        lastAckedSnapshot: this.lastAckedSnapshot,
      });
    }

    // ---- Camera and view model -------------------------------------------
    const renderPosition = this.prediction.renderPosition();
    const state = this.prediction.state;
    const eye = eyePosition({ ...state, position: renderPosition });
    const speed = Math.hypot(state.velocity.x, state.velocity.z);

    this.camera.update({
      eye,
      yaw: this.yaw,
      pitch: this.pitch,
      ads: runtime?.adsProgress ?? 0,
      adsFov: weapon?.adsFov ?? 55,
      speed,
      sprinting: state.state === MovementState.Sprint,
      grounded: state.grounded,
      landImpact: this.lastLandImpact,
      recoilPitch: this.recoilPitch,
      recoilYaw: this.recoilYaw,
      dt,
    });

    this.viewModel.update({
      ads: runtime?.adsProgress ?? 0,
      speed,
      sprinting: state.state === MovementState.Sprint,
      grounded: state.grounded,
      phase: runtime?.phase ?? WeaponPhase.Ready,
      reloadProgress: runtime && weapon ? reloadProgress(runtime, weapon) : 0,
      lookDeltaYaw: frame.deltaYaw,
      lookDeltaPitch: frame.deltaPitch,
      landImpact: this.lastLandImpact,
      dt,
    });

    // ---- Remote players ---------------------------------------------------
    this.updateRemotePlayers(dt);

    // ---- Audio listener ---------------------------------------------------
    this.camera.forward(this.scratchA);
    this.audio.updateListener(
      eye,
      { x: this.scratchA.x, y: this.scratchA.y, z: this.scratchA.z },
      { x: 0, y: 1, z: 0 },
    );

    // ---- HUD --------------------------------------------------------------
    this.updateHud(state, weapon, runtime, frame.scoreboard);
    this.updateMinimap(renderPosition);
    void now;
  }

  private onLocalShot(weapon: ResolvedWeapon, count: number): void {
    for (let i = 0; i < count; i++) {
      this.viewModel.addFireKick(weapon, (this.prediction.weaponRuntime?.adsProgress ?? 0) > 0.5);
      this.camera.addShake(weapon.recoil.vertical * 0.35, 0.12, 40);

      const muzzle = this.viewModel.muzzleWorldPosition(this.scratchA);
      this.camera.forward(this.scratchB);
      this.vfx.muzzleFlash(muzzle.clone(), this.scratchB.clone(), 1);

      // Predicted tracer: drawn immediately toward where the player is aiming.
      // The server's authoritative version arrives shortly after and produces
      // the impact effect; the tracer itself is purely cosmetic.
      const end = muzzle.clone().addScaledVector(this.scratchB, weapon.maxRange * 0.4);
      this.vfx.tracer(muzzle.clone(), end);

      const ejection = this.viewModel.ejectionWorldPosition(this.scratchC);
      this.scratchB.crossVectors(this.scratchB, new THREE.Vector3(0, 1, 0)).normalize();
      this.vfx.casing(ejection.clone(), this.scratchB.clone());

      this.audio.weaponFire(weapon.baseId, undefined, true);
      this.audio.play('sfx.weapon.casing');
      this.music.duckFor(0.5);
    }
  }

  private updateRemotePlayers(dt: number): void {
    const players = this.interpolator.sampleAll(this.net.serverNow());
    const seen = new Set<string>();

    for (const player of players) {
      seen.add(player.id);
      let entity = this.remoteEntities.get(player.id);

      if (!entity) {
        const rig = buildCharacter(
          player.characterId,
          player.team,
          player.skinId,
          this.settings.current.graphics.shadows,
        );
        this.renderer.add(rig.root);
        entity = { rig, lastSeen: performance.now() };
        this.remoteEntities.set(player.id, entity);
      }

      entity.lastSeen = performance.now();
      entity.rig.root.position.set(player.position.x, player.position.y, player.position.z);
      entity.rig.root.rotation.y = player.yaw;

      // A phased player is drawn faint rather than removed, so a skilled
      // player can still spot the distortion — the skill obscures, it does
      // not delete information.
      const phased = EntityInterpolator.isPhased(player);
      for (const material of entity.rig.materials) {
        material.transparent = phased;
        material.opacity = phased ? 0.25 : 1;
      }
      entity.rig.root.visible = player.alive || !player.alive; // corpses stay visible briefly

      poseCharacter(entity.rig, {
        state: player.state,
        speed: player.speed,
        pitch: player.pitch,
        aiming: EntityInterpolator.isAiming(player),
        alive: player.alive,
        dt,
      });
    }

    // Remove entities that stopped appearing.
    for (const [id, entity] of Array.from(this.remoteEntities.entries())) {
      if (seen.has(id)) continue;
      this.renderer.remove(entity.rig.root);
      disposeCharacter(entity.rig);
      this.remoteEntities.delete(id);
    }
  }

  private updateHud(
    state: ReturnType<PredictionSystem['state']['valueOf']> extends never ? never : typeof this.prediction.state,
    weapon: ResolvedWeapon | null,
    runtime: ReturnType<() => typeof this.prediction.weaponRuntime>,
    showScoreboard: boolean,
  ): void {
    const skill = getSkill(DEFAULT_LOADOUT.skillId);
    this.skillCooldownTotalMs = skill?.cooldownMs ?? 1;

    // Crosshair opens with the weapon's real spread cone, converted to pixels
    // via the current FOV so it stays honest at any zoom level.
    const spreadRadians = runtime && weapon ? weapon.spread.base + runtime.spread : 0;
    const fovRadians = (this.camera.fov * Math.PI) / 180;
    const spreadPixels = (spreadRadians / fovRadians) * window.innerHeight * 0.5;

    this.hud.updateVitals({
      health: this.health,
      maxHealth: this.maxHealth,
      shield: this.shield,
      maxShield: this.maxShield,
      stamina: state.stamina,
      ammoInMag: runtime?.ammoInMag ?? 0,
      reserveAmmo: runtime?.reserveAmmo ?? 0,
      weaponNameKey: weapon?.nameKey ?? '',
      reloading: runtime?.phase === WeaponPhase.Reloading,
      reloadProgress: runtime && weapon ? reloadProgress(runtime, weapon) : 0,
      skillCooldownMs: this.skillCooldownMs,
      skillCooldownTotalMs: this.skillCooldownTotalMs,
      skillEnergy: this.skillEnergy,
      skillReady: this.skillCooldownMs <= 0 && this.skillEnergy >= (skill?.energyCost ?? 0),
      spreadRadius: clamp(spreadPixels, 0, 120),
      alive: this.alive,
      respawnInMs: this.respawnInMs,
      spawnProtected: false,
    });

    const mode = this.modeId ? getGameMode(this.modeId) : null;
    this.hud.updateMatch({
      phase: this.matchPhase,
      timeRemainingMs: this.matchState.timeRemainingMs,
      alphaScore: this.matchState.alphaScore,
      bravoScore: this.matchState.bravoScore,
      round: this.matchState.round,
      roundsWonAlpha: this.matchState.roundsWonAlpha,
      roundsWonBravo: this.matchState.roundsWonBravo,
      objectives: this.matchState.objectives,
      teamBased: mode?.teamBased ?? true,
    });

    const rows = this.interpolator.sampleAll(this.net.serverNow()).map((p) => ({
      playerId: p.id,
      displayName: p.displayName,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      score: p.score,
      ping: p.ping,
      alive: p.alive,
    }));
    this.hud.setScoreboardVisible(
      showScoreboard,
      rows,
      this.net.playerId ?? '',
      mode?.teamBased ?? true,
    );
  }

  private updateMinimap(position: Vec3): void {
    const players = this.interpolator.sampleAll(this.net.serverNow());
    const entities = players.map((p) => ({
      position: p.position,
      yaw: p.yaw,
      team: p.team,
      isSelf: false,
      // Enemies are only drawn when the game has revealed them.
      revealed: EntityInterpolator.isScanned(p) || EntityInterpolator.isFiring(p),
      alive: p.alive,
    }));
    entities.push({
      position,
      yaw: this.yaw,
      team: this.team,
      isSelf: true,
      revealed: true,
      alive: this.alive,
    });

    const objectives = (this.currentMap?.objectives ?? []).map((o) => {
      const state = this.matchState.objectives.find((s) => s.id === o.id);
      return {
        position: o.at,
        owner: state?.owner ?? TeamId.None,
        contested: state?.contested ?? false,
      };
    });

    this.minimap.render(
      position,
      this.yaw,
      entities,
      objectives,
      this.settings.current.gameplay.minimapRotate,
    );
  }

  // ============================================================== dev tools

  private updateDevPanel(fps: number, drawCalls: number): void {
    if (!import.meta.env?.DEV) return;

    if (!this.devPanel) {
      this.devPanel = document.createElement('div');
      this.devPanel.className = 'dev-panel';
      document.getElementById('ui-root')!.appendChild(this.devPanel);
    }

    const prediction = this.prediction.stats();
    const vfx = this.vfx.stats();
    const audio = this.audio.stats();

    this.devPanel.innerHTML = `
      <h4>${t('dev.performance')}</h4>
      <div class="row"><span>FPS</span><span>${fps}</span></div>
      <div class="row"><span>Draw calls</span><span>${drawCalls}</span></div>
      <div class="row"><span>Ping</span><span>${Math.round(this.net.roundTripMs)}ms</span></div>
      <div class="row"><span>Pred. error</span><span>${prediction.error.toFixed(3)}m</span></div>
      <div class="row"><span>Corrections</span><span>${prediction.corrections}</span></div>
      <div class="row"><span>Replayed</span><span>${prediction.replayed}</span></div>
      <div class="row"><span>Particles</span><span>${vfx.particles}</span></div>
      <div class="row"><span>Voices</span><span>${audio.voices}</span></div>
      <div class="row"><span>Remotes</span><span>${this.remoteEntities.size}</span></div>
      <div class="row"><span>Delta resyncs</span><span>${this.deltaResyncs}</span></div>
      <div class="row warn"><span>Assets</span><span>procedural</span></div>`;
  }

  // ================================================================ settings

  private applySettings(): void {
    const settings: Settings = this.settings.current;
    setLocale(settings.locale);
    this.renderer.applySettings(settings);
    this.camera.applySettings(settings.gameplay, settings.accessibility);
    this.vfx.applySettings(settings.graphics, settings.accessibility);
    this.input.applySettings(settings);
    this.audio.applySettings(settings.audio);
    this.music.setVolume(settings.audio.music);
    this.hud.applySettings(settings.gameplay, settings.accessibility);
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
    this.net.disconnect();
    this.input.dispose();
    this.audio.dispose();
    this.music.dispose();
    this.vfx.dispose();
    this.viewModel.dispose();
    this.clearRemoteEntities();
    this.renderer.dispose();
  }
}

export { Currency };
