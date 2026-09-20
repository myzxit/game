/**
 * Message validation — the trust boundary.
 *
 * Nothing arriving from a client is trusted. Every field is checked for type,
 * range and length *before* any handler sees it. This module is deliberately
 * boring and exhaustive; that is the point.
 *
 * Range checks here are the first anti-cheat layer. The second is behavioural
 * (server/anticheat), the third is that the server simply doesn't accept the
 * client's word on outcomes at all.
 */

import { ClientMessageType, type ClientMessage } from './protocol.js';
import { MAX_INPUTS_PER_PACKET, PROTOCOL_VERSION } from '../core/constants.js';
import { MAX_INPUT_DELTA_MS, type PlayerInput } from '../sim/movement.js';
import { AttachmentSlot } from '../config/weapons.js';
import type { Loadout } from '../config/loadout.js';

export interface ValidationFailure {
  ok: false;
  reason: string;
  /** Set when the failure is severe enough to warrant a strike. */
  suspicious: boolean;
}
export type ValidationResult<T> = { ok: true; value: T } | ValidationFailure;

const pass = <T>(value: T): ValidationResult<T> => ({ ok: true, value });
const reject = (reason: string, suspicious = false): ValidationFailure => ({
  ok: false,
  reason,
  suspicious,
});

// --------------------------------------------------------------- primitives

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const inRange = (v: unknown, min: number, max: number): v is number =>
  isFiniteNumber(v) && v >= min && v <= max;

const isString = (v: unknown, maxLen: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= maxLen;

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Ids are restricted to a safe alphabet — blocks path traversal and injection. */
const ID_PATTERN = /^[a-z0-9_.:-]{1,64}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);

/**
 * Display names: letters (any script, so Korean works), digits, spaces and a
 * few punctuation marks. No control characters, no zero-width joiners (which
 * are used for impersonation), no leading/trailing whitespace.
 */
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,14}[\p{L}\p{N}]$/u;
// Control characters, zero-width/bidi marks and the BOM. Zero-width joiners in
// particular are used to build visually identical impersonation names.
const INVISIBLE_CLASS =
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff]';
// Two separate RegExp objects on purpose: a /g regex carries `lastIndex` state,
// which makes repeated `.test()` calls alternate between true and false.
const CONTROL_OR_INVISIBLE = new RegExp(INVISIBLE_CLASS, 'u');
const CONTROL_OR_INVISIBLE_GLOBAL = new RegExp(INVISIBLE_CLASS, 'gu');

export function validateDisplayName(v: unknown): ValidationResult<string> {
  if (typeof v !== 'string') return reject('displayName must be a string');
  const trimmed = v.trim();
  if (trimmed.length < 2) return reject('login.name_too_short');
  if (trimmed.length > 16) return reject('login.name_too_long');
  if (CONTROL_OR_INVISIBLE.test(trimmed)) return reject('login.name_invalid');
  if (!NAME_PATTERN.test(trimmed)) return reject('login.name_invalid');
  return pass(trimmed);
}

/** Chat: strip control characters, cap length, reject empty results. */
export function sanitizeChat(v: unknown, maxLen = 160): ValidationResult<string> {
  if (typeof v !== 'string') return reject('chat text must be a string');
  const cleaned = v.replace(CONTROL_OR_INVISIBLE_GLOBAL, '').trim().slice(0, maxLen);
  if (cleaned.length === 0) return reject('empty chat message');
  return pass(cleaned);
}

// ------------------------------------------------------------------- input

const HALF_PI = Math.PI / 2;

export function validateInput(v: unknown): ValidationResult<PlayerInput> {
  if (!isPlainObject(v)) return reject('input must be an object', true);

  if (!inRange(v.sequence, 0, Number.MAX_SAFE_INTEGER)) return reject('bad sequence', true);
  // deltaMs is clamped rather than rejected: a legitimate client can hitch.
  // Values far outside the plausible range are treated as a speed-hack attempt.
  if (!isFiniteNumber(v.deltaMs)) return reject('bad deltaMs', true);
  if (v.deltaMs < 0 || v.deltaMs > 1000) return reject('implausible deltaMs', true);

  if (!inRange(v.moveX, -1.001, 1.001)) return reject('bad moveX', true);
  if (!inRange(v.moveZ, -1.001, 1.001)) return reject('bad moveZ', true);
  if (!inRange(v.yaw, -Math.PI * 4, Math.PI * 4)) return reject('bad yaw', true);
  if (!inRange(v.pitch, -HALF_PI - 0.01, HALF_PI + 0.01)) return reject('bad pitch', true);
  if (!inRange(v.buttons, 0, 0xffff)) return reject('bad buttons', true);
  if (!isFiniteNumber(v.clientTimeMs)) return reject('bad clientTimeMs');

  return pass({
    sequence: Math.floor(v.sequence),
    // Clamp here, once, so every downstream consumer sees a sane value.
    deltaMs: Math.min(v.deltaMs, MAX_INPUT_DELTA_MS),
    moveX: Math.max(-1, Math.min(1, v.moveX)),
    moveZ: Math.max(-1, Math.min(1, v.moveZ)),
    yaw: v.yaw,
    pitch: Math.max(-HALF_PI + 0.01, Math.min(HALF_PI - 0.01, v.pitch)),
    buttons: Math.floor(v.buttons),
    clientTimeMs: v.clientTimeMs,
  });
}

// ---------------------------------------------------------------- loadout

const VALID_SLOTS = new Set<string>(Object.values(AttachmentSlot));

export function validateLoadout(v: unknown): ValidationResult<Loadout> {
  if (!isPlainObject(v)) return reject('loadout must be an object');
  if (!isId(v.primaryWeaponId)) return reject('bad primaryWeaponId');
  if (!isId(v.secondaryWeaponId)) return reject('bad secondaryWeaponId');
  if (!isId(v.meleeWeaponId)) return reject('bad meleeWeaponId');
  if (!isId(v.characterId)) return reject('bad characterId');
  if (!isId(v.skillId)) return reject('bad skillId');
  if (v.characterSkinId !== null && !isId(v.characterSkinId)) return reject('bad characterSkinId');

  const attachments: Loadout['attachments'] = {};
  if (v.attachments !== undefined) {
    if (!isPlainObject(v.attachments)) return reject('bad attachments');
    const weaponKeys = Object.keys(v.attachments);
    if (weaponKeys.length > 16) return reject('too many attachment entries', true);
    for (const weaponId of weaponKeys) {
      if (!isId(weaponId)) return reject('bad attachment weapon id');
      const slots = v.attachments[weaponId];
      if (!isPlainObject(slots)) return reject('bad attachment slots');
      const entry: Partial<Record<AttachmentSlot, string>> = {};
      for (const [slot, attId] of Object.entries(slots)) {
        if (!VALID_SLOTS.has(slot)) return reject(`unknown attachment slot: ${slot}`);
        if (!isId(attId)) return reject('bad attachment id');
        entry[slot as AttachmentSlot] = attId;
      }
      attachments[weaponId] = entry;
    }
  }

  const weaponSkins: Record<string, string> = {};
  if (v.weaponSkins !== undefined) {
    if (!isPlainObject(v.weaponSkins)) return reject('bad weaponSkins');
    if (Object.keys(v.weaponSkins).length > 32) return reject('too many skins', true);
    for (const [weaponId, skinId] of Object.entries(v.weaponSkins)) {
      if (!isId(weaponId) || !isId(skinId)) return reject('bad weapon skin entry');
      weaponSkins[weaponId] = skinId;
    }
  }

  return pass({
    primaryWeaponId: v.primaryWeaponId,
    secondaryWeaponId: v.secondaryWeaponId,
    meleeWeaponId: v.meleeWeaponId,
    characterId: v.characterId,
    skillId: v.skillId,
    characterSkinId: (v.characterSkinId as string | null) ?? null,
    attachments,
    weaponSkins,
  });
}

// ------------------------------------------------------- settings payload

/**
 * Settings are stored opaquely but must stay small and shallow, or a client
 * could use the profile as free storage (or blow up the save file).
 */
export function validateSettings(v: unknown): ValidationResult<Record<string, unknown>> {
  if (!isPlainObject(v)) return reject('settings must be an object');
  const keys = Object.keys(v);
  if (keys.length > 80) return reject('too many settings keys', true);

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.length > 48) return reject('settings key too long', true);
    const value = v[key];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return reject('non-finite settings value');
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > 64) return reject('settings string too long', true);
      out[key] = value;
    } else if (isPlainObject(value)) {
      // One level of nesting is allowed, for keybind maps.
      const nested: Record<string, string> = {};
      const nestedKeys = Object.keys(value);
      if (nestedKeys.length > 60) return reject('nested settings too large', true);
      for (const nk of nestedKeys) {
        const nv = value[nk];
        if (nk.length > 48 || typeof nv !== 'string' || nv.length > 48) {
          return reject('bad nested settings entry', true);
        }
        nested[nk] = nv;
      }
      out[key] = nested;
    } else {
      return reject(`unsupported settings value type for ${key}`);
    }
  }
  return pass(out);
}

// ------------------------------------------------------- message dispatch

/**
 * Validate a decoded message. Returns the message narrowed to its concrete
 * type, or a failure describing what was wrong.
 */
export function validateClientMessage(raw: unknown): ValidationResult<ClientMessage> {
  if (!isPlainObject(raw)) return reject('message must be an object', true);
  const type = raw.type;
  if (typeof type !== 'string') return reject('missing message type', true);

  switch (type) {
    case ClientMessageType.Handshake: {
      if (raw.protocolVersion !== PROTOCOL_VERSION) {
        return reject(`protocol mismatch: got ${String(raw.protocolVersion)}`);
      }
      const name = validateDisplayName(raw.displayName);
      if (!name.ok) return name;
      if (raw.sessionToken !== null && !isString(raw.sessionToken, 128)) {
        return reject('bad sessionToken');
      }
      if (!isString(raw.locale, 8)) return reject('bad locale');
      return pass({
        type: ClientMessageType.Handshake,
        protocolVersion: PROTOCOL_VERSION,
        displayName: name.value,
        sessionToken: (raw.sessionToken as string | null) ?? null,
        locale: raw.locale as string,
      });
    }

    case ClientMessageType.Ping: {
      if (!isFiniteNumber(raw.clientTimeMs)) return reject('bad clientTimeMs');
      return pass({ type: ClientMessageType.Ping, clientTimeMs: raw.clientTimeMs });
    }

    case ClientMessageType.Input: {
      if (!Array.isArray(raw.inputs)) return reject('inputs must be an array', true);
      if (raw.inputs.length === 0) return reject('empty input batch');
      if (raw.inputs.length > MAX_INPUTS_PER_PACKET) {
        return reject(`input batch too large: ${raw.inputs.length}`, true);
      }
      const inputs: PlayerInput[] = [];
      for (const item of raw.inputs) {
        const r = validateInput(item);
        if (!r.ok) return r;
        inputs.push(r.value);
      }
      if (!inRange(raw.lastAckedSnapshot, -1, Number.MAX_SAFE_INTEGER)) {
        return reject('bad lastAckedSnapshot');
      }
      return pass({
        type: ClientMessageType.Input,
        inputs,
        lastAckedSnapshot: Math.floor(raw.lastAckedSnapshot),
      });
    }

    case ClientMessageType.SwitchWeapon: {
      if (!inRange(raw.slot, 0, 2)) return reject('bad weapon slot', true);
      return pass({ type: ClientMessageType.SwitchWeapon, slot: Math.floor(raw.slot) });
    }

    case ClientMessageType.UseSkill: {
      if (!inRange(raw.aimYaw, -Math.PI * 4, Math.PI * 4)) return reject('bad aimYaw', true);
      if (!inRange(raw.aimPitch, -HALF_PI - 0.01, HALF_PI + 0.01)) return reject('bad aimPitch', true);
      return pass({
        type: ClientMessageType.UseSkill,
        aimYaw: raw.aimYaw,
        aimPitch: raw.aimPitch,
      });
    }

    case ClientMessageType.Interact: {
      const kinds = ['npc', 'secret', 'vehicle', 'objective', 'pickup'];
      if (typeof raw.targetKind !== 'string' || !kinds.includes(raw.targetKind)) {
        return reject('bad interact targetKind', true);
      }
      if (!isId(raw.targetId)) return reject('bad interact targetId', true);
      return pass({
        type: ClientMessageType.Interact,
        targetKind: raw.targetKind as 'npc',
        targetId: raw.targetId,
      });
    }

    case ClientMessageType.SetLoadout: {
      const r = validateLoadout(raw.loadout);
      if (!r.ok) return r;
      return pass({ type: ClientMessageType.SetLoadout, loadout: r.value });
    }

    case ClientMessageType.ChatMessage: {
      const channels = ['team', 'all', 'party'];
      if (typeof raw.channel !== 'string' || !channels.includes(raw.channel)) {
        return reject('bad chat channel');
      }
      const text = sanitizeChat(raw.text);
      if (!text.ok) return text;
      return pass({
        type: ClientMessageType.ChatMessage,
        channel: raw.channel as 'team',
        text: text.value,
      });
    }

    case ClientMessageType.QueueJoin: {
      if (!isId(raw.modeId)) return reject('bad modeId');
      if (raw.mapIds !== undefined) {
        if (!Array.isArray(raw.mapIds) || raw.mapIds.length > 8) return reject('bad mapIds');
        for (const m of raw.mapIds) if (!isId(m)) return reject('bad map id');
      }
      return pass({
        type: ClientMessageType.QueueJoin,
        modeId: raw.modeId,
        mapIds: (raw.mapIds as string[]) ?? [],
      });
    }

    case ClientMessageType.PartyJoin: {
      if (!isString(raw.code, 12)) return reject('bad party code');
      return pass({ type: ClientMessageType.PartyJoin, code: raw.code });
    }

    case ClientMessageType.PartyKick: {
      if (!isId(raw.playerId)) return reject('bad playerId');
      return pass({ type: ClientMessageType.PartyKick, playerId: raw.playerId });
    }

    case ClientMessageType.PartySetReady: {
      if (!isBool(raw.ready)) return reject('bad ready flag');
      return pass({ type: ClientMessageType.PartySetReady, ready: raw.ready });
    }

    case ClientMessageType.ShopPurchase: {
      if (!isId(raw.itemId)) return reject('bad itemId', true);
      if (!isString(raw.section, 32)) return reject('bad section');
      return pass({
        type: ClientMessageType.ShopPurchase,
        itemId: raw.itemId,
        section: raw.section,
      });
    }

    case ClientMessageType.OpenCrate: {
      if (!isId(raw.crateId)) return reject('bad crateId', true);
      return pass({ type: ClientMessageType.OpenCrate, crateId: raw.crateId });
    }

    case ClientMessageType.EquipItem: {
      if (!isId(raw.itemId)) return reject('bad itemId', true);
      if (!isString(raw.slot, 32)) return reject('bad slot');
      return pass({ type: ClientMessageType.EquipItem, itemId: raw.itemId, slot: raw.slot });
    }

    case ClientMessageType.ClaimQuestReward: {
      if (!isId(raw.questId)) return reject('bad questId', true);
      return pass({ type: ClientMessageType.ClaimQuestReward, questId: raw.questId });
    }

    case ClientMessageType.ClaimSeasonReward: {
      if (!isId(raw.seasonId)) return reject('bad seasonId', true);
      if (!inRange(raw.level, 1, 500)) return reject('bad season level', true);
      return pass({
        type: ClientMessageType.ClaimSeasonReward,
        seasonId: raw.seasonId,
        level: Math.floor(raw.level),
      });
    }

    case ClientMessageType.TalkToNpc: {
      if (!isId(raw.npcId)) return reject('bad npcId');
      return pass({ type: ClientMessageType.TalkToNpc, npcId: raw.npcId });
    }

    case ClientMessageType.DialogueChoice: {
      if (!isId(raw.npcId)) return reject('bad npcId');
      if (!isId(raw.nodeId)) return reject('bad nodeId');
      if (!inRange(raw.optionIndex, 0, 15)) return reject('bad optionIndex', true);
      return pass({
        type: ClientMessageType.DialogueChoice,
        npcId: raw.npcId,
        nodeId: raw.nodeId,
        optionIndex: Math.floor(raw.optionIndex),
      });
    }

    case ClientMessageType.SaveSettings: {
      const r = validateSettings(raw.settings);
      if (!r.ok) return r;
      return pass({ type: ClientMessageType.SaveSettings, settings: r.value });
    }

    case ClientMessageType.ReportPlayer: {
      const reasons = ['cheating', 'abuse', 'exploit', 'other'];
      if (!isId(raw.playerId)) return reject('bad playerId');
      if (typeof raw.reason !== 'string' || !reasons.includes(raw.reason)) {
        return reject('bad report reason');
      }
      const details =
        raw.details === undefined || raw.details === ''
          ? pass('')
          : sanitizeChat(raw.details, 300);
      if (!details.ok) return details;
      return pass({
        type: ClientMessageType.ReportPlayer,
        playerId: raw.playerId,
        reason: raw.reason as 'other',
        details: details.value,
      });
    }

    case ClientMessageType.BlockPlayer: {
      if (!isId(raw.playerId)) return reject('bad playerId');
      if (!isBool(raw.blocked)) return reject('bad blocked flag');
      return pass({
        type: ClientMessageType.BlockPlayer,
        playerId: raw.playerId,
        blocked: raw.blocked,
      });
    }

    case ClientMessageType.RequestLeaderboard: {
      const boards = ['rank', 'kills', 'wins', 'score'];
      if (typeof raw.board !== 'string' || !boards.includes(raw.board)) {
        return reject('bad leaderboard');
      }
      if (raw.seasonId !== null && !isId(raw.seasonId)) return reject('bad seasonId');
      return pass({
        type: ClientMessageType.RequestLeaderboard,
        board: raw.board as 'rank',
        seasonId: (raw.seasonId as string | null) ?? null,
      });
    }

    case ClientMessageType.RequestProfile: {
      if (!isId(raw.playerId)) return reject('bad playerId');
      return pass({ type: ClientMessageType.RequestProfile, playerId: raw.playerId });
    }

    case ClientMessageType.SpectateTarget: {
      if (raw.playerId !== null && !isId(raw.playerId)) return reject('bad playerId');
      return pass({
        type: ClientMessageType.SpectateTarget,
        playerId: (raw.playerId as string | null) ?? null,
      });
    }

    case ClientMessageType.EnterVehicle: {
      if (!inRange(raw.vehicleId, 0, 100000)) return reject('bad vehicleId', true);
      return pass({ type: ClientMessageType.EnterVehicle, vehicleId: Math.floor(raw.vehicleId) });
    }

    case ClientMessageType.VehicleInput: {
      if (!inRange(raw.throttle, -1.001, 1.001)) return reject('bad throttle', true);
      if (!inRange(raw.steer, -1.001, 1.001)) return reject('bad steer', true);
      if (!isBool(raw.brake)) return reject('bad brake');
      if (!inRange(raw.deltaMs, 0, 1000)) return reject('bad deltaMs', true);
      if (!inRange(raw.sequence, 0, Number.MAX_SAFE_INTEGER)) return reject('bad sequence', true);
      return pass({
        type: ClientMessageType.VehicleInput,
        throttle: Math.max(-1, Math.min(1, raw.throttle)),
        steer: Math.max(-1, Math.min(1, raw.steer)),
        brake: raw.brake,
        deltaMs: Math.min(raw.deltaMs, MAX_INPUT_DELTA_MS),
        sequence: Math.floor(raw.sequence),
      });
    }

    case ClientMessageType.AckSnapshot: {
      // -1 is the documented "I could not reconstruct that delta, resend in
      // full" signal, and must be accepted here for the same reason the Input
      // message's piggybacked `lastAckedSnapshot` accepts it. Rejecting it
      // disconnects any client that drops a snapshot.
      if (!inRange(raw.snapshotId, -1, Number.MAX_SAFE_INTEGER)) return reject('bad snapshotId');
      return pass({ type: ClientMessageType.AckSnapshot, snapshotId: Math.floor(raw.snapshotId) });
    }

    case ClientMessageType.DevCommand: {
      // Shape-checked here like everything else; *whether* the server honours
      // it is decided by its devTools setting, not by the validator.
      const c = raw.command;
      if (!isPlainObject(c)) return reject('bad dev command', true);
      switch (c.kind) {
        case 'teleport':
          // Checked one by one so each narrows to number; `every` would not.
          if (!inRange(c.x, -5000, 5000) || !inRange(c.y, -5000, 5000) || !inRange(c.z, -5000, 5000)) {
            return reject('bad teleport target', true);
          }
          return pass({
            type: ClientMessageType.DevCommand,
            command: { kind: 'teleport', x: c.x, y: c.y, z: c.z },
          });
        case 'give_coins':
          if (!inRange(c.amount, 0, 1_000_000)) return reject('bad coin amount', true);
          return pass({
            type: ClientMessageType.DevCommand,
            command: { kind: 'give_coins', amount: Math.floor(c.amount) },
          });
        case 'set_health':
          if (!inRange(c.health, 0, 1000)) return reject('bad health', true);
          return pass({
            type: ClientMessageType.DevCommand,
            command: { kind: 'set_health', health: c.health },
          });
        default:
          return reject('unknown dev command', true);
      }
    }

    // Messages with no payload beyond their type.
    case ClientMessageType.QueueLeave:
    case ClientMessageType.PartyCreate:
    case ClientMessageType.PartyLeave:
    case ClientMessageType.LeaveMatch:
    case ClientMessageType.RequestRespawn:
    case ClientMessageType.ClaimLoginReward:
    case ClientMessageType.ExitVehicle:
      return pass({ type } as ClientMessage);

    default:
      return reject(`unknown message type: ${type}`, true);
  }
}
