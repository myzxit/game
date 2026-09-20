/**
 * Per-connection rate limiting.
 *
 * A token bucket per message class. Input messages get a high rate (they arrive
 * every frame); economy actions get a low one, because there is no legitimate
 * reason to open twenty crates a second and doing so is how someone probes for
 * a race condition in the grant path.
 */

import { ClientMessageType } from '@titan/shared';

export interface BucketConfig {
  /** Tokens restored per second. */
  refillPerSecond: number;
  /** Maximum tokens held — this is the burst allowance. */
  capacity: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly config: BucketConfig, now: number) {
    this.tokens = config.capacity;
    this.lastRefill = now;
  }

  tryConsume(now: number, cost = 1): boolean {
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.config.capacity, this.tokens + elapsed * this.config.refillPerSecond);
      this.lastRefill = now;
    }
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  get available(): number {
    return this.tokens;
  }
}

/** Message classes, so related messages share a budget. */
export enum LimitClass {
  Input = 'input',
  Action = 'action',
  Economy = 'economy',
  Chat = 'chat',
  Query = 'query',
  Handshake = 'handshake',
}

const CLASS_CONFIG: Record<LimitClass, BucketConfig> = {
  // Inputs arrive up to ~60/s; allow headroom for batching and resends.
  [LimitClass.Input]: { refillPerSecond: 90, capacity: 180 },
  // Weapon swaps, skills, interacts.
  [LimitClass.Action]: { refillPerSecond: 20, capacity: 40 },
  // Purchases, crate opens, claims. Deliberately tight.
  [LimitClass.Economy]: { refillPerSecond: 3, capacity: 10 },
  [LimitClass.Chat]: { refillPerSecond: 1, capacity: 5 },
  // Leaderboards, profiles.
  [LimitClass.Query]: { refillPerSecond: 4, capacity: 12 },
  [LimitClass.Handshake]: { refillPerSecond: 0.5, capacity: 3 },
};

const MESSAGE_CLASS: Partial<Record<ClientMessageType, LimitClass>> = {
  [ClientMessageType.Input]: LimitClass.Input,
  [ClientMessageType.VehicleInput]: LimitClass.Input,
  [ClientMessageType.Ping]: LimitClass.Input,
  [ClientMessageType.AckSnapshot]: LimitClass.Input,

  [ClientMessageType.SwitchWeapon]: LimitClass.Action,
  [ClientMessageType.UseSkill]: LimitClass.Action,
  [ClientMessageType.Interact]: LimitClass.Action,
  [ClientMessageType.RequestRespawn]: LimitClass.Action,
  [ClientMessageType.SetLoadout]: LimitClass.Action,
  [ClientMessageType.EnterVehicle]: LimitClass.Action,
  [ClientMessageType.ExitVehicle]: LimitClass.Action,
  [ClientMessageType.DevCommand]: LimitClass.Action,
  [ClientMessageType.SpectateTarget]: LimitClass.Action,
  [ClientMessageType.QueueJoin]: LimitClass.Action,
  [ClientMessageType.QueueLeave]: LimitClass.Action,
  [ClientMessageType.PartyCreate]: LimitClass.Action,
  [ClientMessageType.PartyJoin]: LimitClass.Action,
  [ClientMessageType.PartyLeave]: LimitClass.Action,
  [ClientMessageType.PartyKick]: LimitClass.Action,
  [ClientMessageType.PartySetReady]: LimitClass.Action,
  [ClientMessageType.LeaveMatch]: LimitClass.Action,
  [ClientMessageType.TalkToNpc]: LimitClass.Action,
  [ClientMessageType.DialogueChoice]: LimitClass.Action,
  [ClientMessageType.SaveSettings]: LimitClass.Action,
  [ClientMessageType.BlockPlayer]: LimitClass.Action,

  [ClientMessageType.ShopPurchase]: LimitClass.Economy,
  [ClientMessageType.OpenCrate]: LimitClass.Economy,
  [ClientMessageType.EquipItem]: LimitClass.Economy,
  [ClientMessageType.ClaimQuestReward]: LimitClass.Economy,
  [ClientMessageType.ClaimLoginReward]: LimitClass.Economy,
  [ClientMessageType.ClaimSeasonReward]: LimitClass.Economy,
  [ClientMessageType.ReportPlayer]: LimitClass.Economy,

  [ClientMessageType.ChatMessage]: LimitClass.Chat,

  [ClientMessageType.RequestLeaderboard]: LimitClass.Query,
  [ClientMessageType.RequestProfile]: LimitClass.Query,

  [ClientMessageType.Handshake]: LimitClass.Handshake,
};

export function limitClassFor(type: string): LimitClass {
  return MESSAGE_CLASS[type as ClientMessageType] ?? LimitClass.Action;
}

export class ConnectionRateLimiter {
  private readonly buckets = new Map<LimitClass, TokenBucket>();
  /** Bytes received in the current window, to cap total bandwidth per client. */
  private bytesWindow = 0;
  private windowStart: number;

  constructor(
    now = Date.now(),
    /** Maximum inbound bytes per second from one connection. */
    private readonly bytesPerSecond = 64 * 1024,
  ) {
    this.windowStart = now;
    for (const [cls, config] of Object.entries(CLASS_CONFIG)) {
      this.buckets.set(cls as LimitClass, new TokenBucket(config, now));
    }
  }

  /** True if the message is within budget. */
  allow(type: string, now = Date.now()): boolean {
    const cls = limitClassFor(type);
    const bucket = this.buckets.get(cls);
    if (!bucket) return true;
    return bucket.tryConsume(now);
  }

  /** True if the connection is within its bandwidth budget. */
  allowBytes(byteLength: number, now = Date.now()): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.bytesWindow = 0;
    }
    this.bytesWindow += byteLength;
    return this.bytesWindow <= this.bytesPerSecond;
  }

  /** Diagnostics. */
  remaining(cls: LimitClass): number {
    return this.buckets.get(cls)?.available ?? 0;
  }
}
