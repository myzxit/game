/**
 * Explicit success/failure values.
 *
 * Server services (economy, inventory, quests) return `Result` rather than
 * throwing, because "you can't afford that" is a normal outcome that must be
 * turned into a localized message, not a crash. Exceptions stay reserved for
 * genuine programming errors.
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E = GameError> = { ok: false; error: E };
export type Result<T, E = GameError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E = GameError>(error: E): Err<E> => ({ ok: false, error });

/** Stable machine-readable failure codes. Each maps to a localization key. */
export enum ErrorCode {
  Unknown = 'unknown',
  Validation = 'validation',
  NotFound = 'not_found',
  Forbidden = 'forbidden',
  RateLimited = 'rate_limited',
  InsufficientFunds = 'insufficient_funds',
  AlreadyOwned = 'already_owned',
  NotOwned = 'not_owned',
  LevelRequirement = 'level_requirement',
  Unavailable = 'unavailable',
  Conflict = 'conflict',
  Storage = 'storage',
  Network = 'network',
  MatchFull = 'match_full',
  PartyFull = 'party_full',
  NotPartyLeader = 'not_party_leader',
  AssetMissing = 'asset_missing',
  PaymentUnavailable = 'payment_unavailable',
}

export interface GameError {
  code: ErrorCode;
  /** Developer-facing detail. Never shown verbatim to the player. */
  detail: string;
  /** Localization key for the player-facing message. */
  messageKey: string;
  /** Interpolation values for the localized message. */
  params?: Record<string, string | number>;
}

const DEFAULT_MESSAGE_KEYS: Record<ErrorCode, string> = {
  [ErrorCode.Unknown]: 'error.unknown',
  [ErrorCode.Validation]: 'error.validation',
  [ErrorCode.NotFound]: 'error.not_found',
  [ErrorCode.Forbidden]: 'error.forbidden',
  [ErrorCode.RateLimited]: 'error.rate_limited',
  [ErrorCode.InsufficientFunds]: 'error.insufficient_funds',
  [ErrorCode.AlreadyOwned]: 'error.already_owned',
  [ErrorCode.NotOwned]: 'error.not_owned',
  [ErrorCode.LevelRequirement]: 'error.level_requirement',
  [ErrorCode.Unavailable]: 'error.unavailable',
  [ErrorCode.Conflict]: 'error.conflict',
  [ErrorCode.Storage]: 'error.storage',
  [ErrorCode.Network]: 'error.network',
  [ErrorCode.MatchFull]: 'error.match_full',
  [ErrorCode.PartyFull]: 'error.party_full',
  [ErrorCode.NotPartyLeader]: 'error.not_party_leader',
  [ErrorCode.AssetMissing]: 'error.asset_missing',
  [ErrorCode.PaymentUnavailable]: 'error.payment_unavailable',
};

export function gameError(
  code: ErrorCode,
  detail: string,
  params?: Record<string, string | number>,
  messageKey?: string,
): GameError {
  return { code, detail, messageKey: messageKey ?? DEFAULT_MESSAGE_KEYS[code], params };
}

export const fail = (
  code: ErrorCode,
  detail: string,
  params?: Record<string, string | number>,
): Err<GameError> => err(gameError(code, detail, params));

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Wrap a throwing call so an unexpected exception becomes a Result. */
export function attempt<T>(fn: () => T, detail: string): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return fail(ErrorCode.Unknown, `${detail}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function attemptAsync<T>(fn: () => Promise<T>, detail: string): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(ErrorCode.Unknown, `${detail}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
