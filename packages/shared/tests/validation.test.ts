/**
 * Trust-boundary tests for the client→server message validator.
 *
 * The validator is the only thing standing between a hostile client and the
 * simulation, so the interesting cases are the ones where being too strict is
 * as damaging as being too lax: a legitimate client that gets disconnected for
 * sending something the protocol documents as valid.
 */

import { describe, expect, it } from 'vitest';
import { ClientMessageType, validateClientMessage } from '../src/index.js';

/** A minimal well-formed input, so an Input test only exercises the ack field. */
const INPUT = {
  sequence: 1,
  deltaMs: 16,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  clientTimeMs: 1_000,
};

describe('snapshot acknowledgement', () => {
  // A client that cannot reconstruct a delta acks -1 to ask for a full
  // snapshot. Both ack paths carry that value, and both must accept it: when
  // only the Input path did, every dropped snapshot disconnected the client
  // with a protocol violation instead of resyncing it.
  it('accepts the -1 resync request on the dedicated ack message', () => {
    const result = validateClientMessage({
      type: ClientMessageType.AckSnapshot,
      snapshotId: -1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({
      type: ClientMessageType.AckSnapshot,
      snapshotId: -1,
    });
  });

  it('accepts the -1 resync request piggybacked on an input batch', () => {
    const result = validateClientMessage({
      type: ClientMessageType.Input,
      inputs: [INPUT],
      lastAckedSnapshot: -1,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a normal acknowledgement', () => {
    const result = validateClientMessage({
      type: ClientMessageType.AckSnapshot,
      snapshotId: 41,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({
      type: ClientMessageType.AckSnapshot,
      snapshotId: 41,
    });
  });

  it('still rejects ids below the resync sentinel', () => {
    // -1 is a sentinel, not "any negative number".
    for (const snapshotId of [-2, -100, Number.NEGATIVE_INFINITY]) {
      expect(validateClientMessage({ type: ClientMessageType.AckSnapshot, snapshotId }).ok).toBe(
        false,
      );
    }
  });

  it('rejects non-numeric and missing ids', () => {
    for (const snapshotId of ['5', null, undefined, NaN, {}, []]) {
      expect(validateClientMessage({ type: ClientMessageType.AckSnapshot, snapshotId }).ok).toBe(
        false,
      );
    }
  });

  it('agrees between the two ack paths across the whole range', () => {
    // The two paths carry the same value and must never disagree about whether
    // it is legal — that mismatch is exactly what caused the disconnect loop.
    for (const id of [-2, -1, 0, 1, 1000, 2 ** 31]) {
      const dedicated = validateClientMessage({
        type: ClientMessageType.AckSnapshot,
        snapshotId: id,
      }).ok;
      const piggybacked = validateClientMessage({
        type: ClientMessageType.Input,
        inputs: [INPUT],
        lastAckedSnapshot: id,
      }).ok;
      expect(dedicated, `ack paths disagree for ${id}`).toBe(piggybacked);
    }
  });
});

describe('malformed input', () => {
  it('rejects a message that is not an object', () => {
    for (const raw of [null, undefined, 42, 'hello', []]) {
      expect(validateClientMessage(raw).ok).toBe(false);
    }
  });

  it('rejects an unknown message type', () => {
    expect(validateClientMessage({ type: 'drop_tables' }).ok).toBe(false);
  });
});
