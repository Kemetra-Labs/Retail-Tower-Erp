import { describe, expect, it } from 'vitest';

import {
  SALE_QUEUE_COUNT_MAX,
  SALE_QUEUE_MIN_REVISION,
  buildHeartbeatBody,
  clampSaleQueueCount,
  parseHeartbeatAck,
  saleQueueKey,
  type HeartbeatFacts,
} from '../heartbeat-wire.js';

/**
 * RT-1312 Phase 1 (P1-D1) — the `posReportDeviceHeartbeat` body and reply
 * (`pos-device-health.openapi.yaml` 1.1.0-draft). A stored beat replaces every
 * field, so every beat names every field it knows (null when unknown), and a
 * value off the contract is sent as null rather than refused with a 400.
 */

const FACTS: HeartbeatFacts = {
  appVersion: null,
  updateChannel: 'canary',
  updateState: 'idle',
  pendingVersion: null,
  schemaHead: '0060_tenant_branding_cache',
  sourceClockAt: new Date('2026-11-10T12:00:00.000Z'),
  saleQueue: { pending: 3, deadLetter: 1, heldPreviousPairing: 0, oldestPendingAt: null },
};

describe('buildHeartbeatBody', () => {
  it('names every D-1 field, and no sale_queue key while the gate is closed', () => {
    expect(buildHeartbeatBody(FACTS, { includeSaleQueue: false })).toEqual({
      app_version: null,
      update_channel: 'canary',
      update_state: 'idle',
      pending_version: null,
      schema_head: '0060_tenant_branding_cache',
      source_clock_at: '2026-11-10T12:00:00.000Z',
    });
    expect(Object.keys(buildHeartbeatBody(FACTS, { includeSaleQueue: false }))).not.toContain(
      'sale_queue',
    );
  });

  it('adds the sale queue counts, snake_case, once the gate is open', () => {
    const body = buildHeartbeatBody(
      {
        ...FACTS,
        saleQueue: {
          pending: 2,
          deadLetter: 1,
          heldPreviousPairing: 4,
          oldestPendingAt: '2026-11-10T11:58:00.000Z',
        },
      },
      { includeSaleQueue: true },
    );
    expect(body.sale_queue).toEqual({
      pending: 2,
      dead_letter: 1,
      held_previous_pairing: 4,
      oldest_pending_at: '2026-11-10T11:58:00.000Z',
    });
  });

  it('sends sale_queue null (unknown, never zeros) when the gate is open but the counts are unknown', () => {
    const body = buildHeartbeatBody({ ...FACTS, saleQueue: null }, { includeSaleQueue: true });
    expect(body).toHaveProperty('sale_queue', null);
  });

  it('keeps a valid release version and pending version', () => {
    const body = buildHeartbeatBody(
      { ...FACTS, appVersion: '1.4.0', pendingVersion: '1.5.0-rc.1' },
      { includeSaleQueue: false },
    );
    expect([body.app_version, body.pending_version]).toEqual(['1.4.0', '1.5.0-rc.1']);
  });

  it.each([
    ['build metadata', '1.4.0+abc'],
    ['too short', '1.4'],
    ['a leading zero', '01.4.0'],
    ['over 32 characters', `1.4.0-${'a'.repeat(30)}`],
  ])('sends a version with %s as null', (_name, version) => {
    const body = buildHeartbeatBody(
      { ...FACTS, appVersion: version, pendingVersion: version },
      { includeSaleQueue: false },
    );
    expect([body.app_version, body.pending_version]).toEqual([null, null]);
  });

  it('sends an unknown channel, update state or schema head as null', () => {
    const body = buildHeartbeatBody(
      { ...FACTS, updateChannel: 'beta', updateState: 'paused', schemaHead: '../0001 init' },
      { includeSaleQueue: false },
    );
    expect([body.update_channel, body.update_state, body.schema_head]).toEqual([null, null, null]);
  });

  it('normalizes the oldest pending instant to RFC 3339 UTC, and an unparseable one to null', () => {
    const at = (oldestPendingAt: string): unknown =>
      buildHeartbeatBody(
        {
          ...FACTS,
          saleQueue: { pending: 1, deadLetter: 0, heldPreviousPairing: 0, oldestPendingAt },
        },
        { includeSaleQueue: true },
      ).sale_queue?.oldest_pending_at;
    expect(at('2026-11-10T13:58:00+02:00')).toBe('2026-11-10T11:58:00.000Z');
    expect(at('not a time')).toBeNull();
  });
});

describe('clampSaleQueueCount', () => {
  it.each([
    [5, 5],
    [-1, 0],
    [2.7, 2],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, SALE_QUEUE_COUNT_MAX],
    [SALE_QUEUE_COUNT_MAX + 1, SALE_QUEUE_COUNT_MAX],
  ])('%s -> %s', (input, expected) => {
    expect(clampSaleQueueCount(input)).toBe(expected);
  });

  it('is applied to every count in the body', () => {
    const body = buildHeartbeatBody(
      {
        ...FACTS,
        saleQueue: {
          pending: 2_000_000,
          deadLetter: -3,
          heldPreviousPairing: 1.5,
          oldestPendingAt: null,
        },
      },
      { includeSaleQueue: true },
    );
    expect(body.sale_queue).toMatchObject({
      pending: SALE_QUEUE_COUNT_MAX,
      dead_letter: 0,
      held_previous_pairing: 1,
    });
  });
});

describe('saleQueueKey', () => {
  it('changes when any reported count or the oldest instant changes, and not otherwise', () => {
    const base = { pending: 1, deadLetter: 0, heldPreviousPairing: 0, oldestPendingAt: null };
    expect(saleQueueKey(base)).toBe(saleQueueKey({ ...base }));
    expect(saleQueueKey(base)).not.toBe(saleQueueKey({ ...base, deadLetter: 1 }));
    expect(saleQueueKey(base)).not.toBe(
      saleQueueKey({ ...base, oldestPendingAt: '2026-11-10T11:58:00Z' }),
    );
  });
});

describe('parseHeartbeatAck', () => {
  const ack = {
    acknowledged_at: '2026-11-10T12:00:01.000Z',
    pos_contract_revision: 2,
    policy: null,
    min_supported_grace_until: null,
    compliance: 'unknown',
  };

  it('reads pos_contract_revision from a contract reply', () => {
    expect(parseHeartbeatAck(ack)).toEqual({ posContractRevision: 2 });
    expect(SALE_QUEUE_MIN_REVISION).toBe(2);
  });

  it.each([
    ['a missing revision', { ...ack, pos_contract_revision: undefined }],
    ['a zero revision', { ...ack, pos_contract_revision: 0 }],
    ['a fractional revision', { ...ack, pos_contract_revision: 2.5 }],
    ['a string revision', { ...ack, pos_contract_revision: '2' }],
    ['not an object', 'ok'],
    ['null', null],
  ])('reads %s as unreadable (null)', (_name, json) => {
    expect(parseHeartbeatAck(json)).toBeNull();
  });
});
