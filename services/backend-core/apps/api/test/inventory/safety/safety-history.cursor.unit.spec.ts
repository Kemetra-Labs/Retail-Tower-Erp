/**
 * Jira RT-1081 — the keyset cursor of the safety history lists (no DB): a
 * token round-trips only for the operation, tenant and normalized filters it
 * was issued for; anything else is a SafetyHistoryCursorError (→ 400).
 */
import {
  SafetyHistoryCursorError,
  decodeSafetyHistoryCursor,
  encodeSafetyHistoryCursor,
  instantKeySql,
  type SafetyHistoryCursorBinding,
} from '../../../src/inventory/safety/safety-history.cursor';

const TENANT = '0a000000-0000-7000-8000-00000000ada1';
const OTHER_TENANT = '0b000000-0000-7000-8000-00000000bdb1';
const ID = '0a000000-0000-7000-8000-000010810c01';
const AT = '2026-11-03T10:15:30.123456Z';

const binding: SafetyHistoryCursorBinding = {
  op: 'tracking_holds',
  tenantId: TENANT,
  filters: ['active', 'quality_hold', ID, null],
};

/** A real cursor for `binding` with exactly one payload field changed (the digest stays valid). */
function tampered(change: Record<string, unknown>): string {
  const real = encodeSafetyHistoryCursor(binding, { atKey: AT, id: ID });
  const payload = JSON.parse(Buffer.from(real, 'base64url').toString('utf8')) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...payload, ...change }), 'utf8').toString('base64url');
}

describe('safety history cursor (RT-1081)', () => {
  it('round-trips the keyset position, case-insensitively on ids', () => {
    const cursor = encodeSafetyHistoryCursor(binding, { atKey: AT, id: ID.toUpperCase() });
    expect(decodeSafetyHistoryCursor(binding, cursor)).toEqual({ atKey: AT, id: ID });
    const upper = { ...binding, tenantId: TENANT.toUpperCase(), filters: ['active', 'quality_hold', ID.toUpperCase(), null] };
    expect(decodeSafetyHistoryCursor(upper, cursor)).toEqual({ atKey: AT, id: ID });
  });

  it.each<[string, SafetyHistoryCursorBinding]>([
    ['another operation', { ...binding, op: 'inventory_recalls' }],
    ['another tenant', { ...binding, tenantId: OTHER_TENANT }],
    ['other filters', { ...binding, filters: ['released', 'quality_hold', ID, null] }],
    ['a filter dropped', { ...binding, filters: ['active', 'quality_hold', null, null] }],
  ])('refuses a token presented for %s', (_label, other) => {
    const cursor = encodeSafetyHistoryCursor(binding, { atKey: AT, id: ID });
    expect(() => decodeSafetyHistoryCursor(other, cursor)).toThrow(SafetyHistoryCursorError);
  });

  it.each<[string, string]>([
    ['not base64 JSON', 'not-a-cursor'],
    ['an unknown key', tampered({ extra: 1 })],
    ['a millisecond instant', tampered({ at: '2026-11-03T10:15:30.123Z' })],
    ['an impossible day', tampered({ at: '2026-02-31T00:00:00.000000Z' })],
    ['a non-uuid id', tampered({ id: 'LOT-1' })],
    ['an upper-case tenant', tampered({ tenant: TENANT.toUpperCase() })],
  ])('refuses %s', (_label, cursor) => {
    expect(() => decodeSafetyHistoryCursor(binding, cursor)).toThrow(SafetyHistoryCursorError);
  });

  it('accepts the untampered control token (so each refusal above is its one changed field)', () => {
    expect(decodeSafetyHistoryCursor(binding, tampered({}))).toEqual({ atKey: AT, id: ID });
  });

  it('renders the key at microsecond precision in UTC', () => {
    expect(instantKeySql('h.placed_at')).toBe(`to_char(h.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
  });
});
