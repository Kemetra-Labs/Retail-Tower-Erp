/**
 * Jira RT-1600 — the store freshness gate (RT-1599 FRESHNESS): which stores may not GIVE stock, from the device facts.
 */
import { classifyStoreFreshness, type FreshnessDeviceFact } from '../../../src/inventory/redistribution/freshness';
import { HEARTBEAT_STALE_AFTER_MS } from '../../../src/inventory/redistribution/policy';

const NOW = Date.parse('2026-11-26T08:00:00.000Z');
const recent = new Date(NOW - 60_000);
const stale = new Date(NOW - HEARTBEAT_STALE_AFTER_MS - 1);
const clean = { pending: 0, deadLetter: 0, held: 0 };
const till = (over: Partial<FreshnessDeviceFact> = {}): FreshnessDeviceFact => ({
  trustState: 'active',
  lastSeenAt: recent,
  queue: clean,
  ...over,
});
const classify = (devices: FreshnessDeviceFact[]) => classifyStoreFreshness(devices, NOW, HEARTBEAT_STALE_AFTER_MS);

describe('classifyStoreFreshness', () => {
  it('keeps a store whose active tills all reported recently with an empty problem queue eligible', () => {
    expect(classify([till(), till({ queue: { pending: 3, deadLetter: 0, held: 0 } })])).toBeNull();
  });

  it('keeps a store with no till eligible: nothing can be unsynced', () => {
    expect(classify([])).toBeNull();
  });

  it('excludes an unknown queue (no stored beat or a NULL counter) as pos_queue_unknown, first', () => {
    expect(classify([till(), till({ queue: null, lastSeenAt: null })])).toBe('pos_queue_unknown');
    expect(classify([till({ queue: null }), till({ queue: { pending: 0, deadLetter: 1, held: 0 } })])).toBe('pos_queue_unknown');
  });

  it('excludes dead-letter or held sales as pos_queue_dead_letter_or_held', () => {
    expect(classify([till({ queue: { pending: 0, deadLetter: 1, held: 0 } })])).toBe('pos_queue_dead_letter_or_held');
    expect(classify([till({ queue: { pending: 0, deadLetter: 0, held: 2 }, lastSeenAt: stale })])).toBe('pos_queue_dead_letter_or_held');
  });

  it('excludes a heartbeat older than the threshold, or a till that never reported, as device_heartbeat_stale', () => {
    expect(classify([till({ lastSeenAt: stale })])).toBe('device_heartbeat_stale');
    expect(classify([till({ lastSeenAt: stale, queue: { pending: 4, deadLetter: 0, held: 0 } })])).toBe('device_heartbeat_stale');
    expect(classify([till({ lastSeenAt: null })])).toBe('device_heartbeat_stale');
    expect(classify([till({ lastSeenAt: new Date(NOW - HEARTBEAT_STALE_AFTER_MS) })])).toBeNull();
  });

  it('ignores revoked and retired tills whatever they report', () => {
    expect(
      classify([till(), till({ trustState: 'revoked', queue: null }), till({ trustState: 'retired', lastSeenAt: null, queue: null })]),
    ).toBeNull();
  });

  it('uses a 15 minute placeholder threshold', () => {
    expect(HEARTBEAT_STALE_AFTER_MS).toBe(15 * 60 * 1000);
  });
});
