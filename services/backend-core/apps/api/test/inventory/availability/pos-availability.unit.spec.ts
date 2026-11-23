/**
 * RT-1577 (RT-1511 S2) — the pure parts of `posGetStoreAvailability`: the band and the snapshot item (RT-1511 section 3),
 * and the opaque page cursor. No database.
 */
import { composeStoreAvailabilityItem } from '../../../src/inventory/availability/availability.rules';
import {
  AvailabilityCursorError,
  decodeAvailabilityCursor,
  encodeAvailabilityCursor,
} from '../../../src/inventory/availability/pos-availability.cursor';

const P = '0a000000-0000-7000-8000-0000000000a1';
const T = '0a000000-0000-7000-8000-00000000ada1';
const S = '0a000000-0000-7000-8000-00000000a5a1';
const facts = (sellable: string, expired = '0.0000', reserved = '0.0000') => ({
  primarySellable: sellable,
  expiredTrackedSellable: expired,
  activeReserved: reserved,
});

describe('composeStoreAvailabilityItem', () => {
  it('uses the S1 formula: sellable - expired lots - active reservations', () => {
    expect(composeStoreAvailabilityItem(P, facts('100.0000', '5.0000', '12.5000'), null)).toEqual({
      productId: P,
      availableToSell: '82.5000',
      band: 'in_stock',
    });
  });

  it('no low-stock level set: in_stock above zero, out at zero', () => {
    expect(composeStoreAvailabilityItem(P, facts('0.0001'), null).band).toBe('in_stock');
    expect(composeStoreAvailabilityItem(P, facts('0.0000'), null).band).toBe('out');
  });

  it('band edges against a level of 10: 10 is low, 10.0001 is in_stock, 0.0001 is low, 0 is out', () => {
    const level = '10.0000';
    expect(composeStoreAvailabilityItem(P, facts('10.0001'), level).band).toBe('in_stock');
    expect(composeStoreAvailabilityItem(P, facts('10.0000'), level).band).toBe('low');
    expect(composeStoreAvailabilityItem(P, facts('0.0001'), level).band).toBe('low');
    expect(composeStoreAvailabilityItem(P, facts('0.0000'), level).band).toBe('out');
  });

  it('a negative ATS is reported as computed and is out (A-4, never clamped)', () => {
    expect(composeStoreAvailabilityItem(P, facts('2.0000', '0.0000', '6.0000'), '10.0000')).toEqual({
      productId: P,
      availableToSell: '-4.0000',
      band: 'out',
    });
  });

  it('a product with no movement and no reservation reads 0.0000 and out', () => {
    expect(composeStoreAvailabilityItem(P, facts('0.0000'), '5.0000')).toEqual({
      productId: P,
      availableToSell: '0.0000',
      band: 'out',
    });
  });

  it('is exact at the numeric(19,4) limits (no float)', () => {
    const big = '999999999999999.0000';
    expect(composeStoreAvailabilityItem(P, facts(big, '1.0000'), '1.0000').availableToSell).toBe('999999999999998.0000');
  });
});

describe('availability cursor', () => {
  it('round-trips the last scanned product for the same (tenant, store)', () => {
    const token = encodeAvailabilityCursor({ tenantId: T, storeId: S, afterProductId: P });
    expect(decodeAvailabilityCursor(token, T, S)).toBe(P);
  });

  it('refuses a cursor issued to another tenant or store', () => {
    const token = encodeAvailabilityCursor({ tenantId: T, storeId: S, afterProductId: P });
    expect(() => decodeAvailabilityCursor(token, T, '0a000000-0000-7000-8000-00000000a5a2')).toThrow(AvailabilityCursorError);
    expect(() => decodeAvailabilityCursor(token, '0b000000-0000-7000-8000-00000000bdb1', S)).toThrow(AvailabilityCursorError);
  });

  it.each([
    ['not base64url json', '%%%not-a-cursor'],
    ['a json array', Buffer.from('[1]').toString('base64url')],
    ['null', Buffer.from('null').toString('base64url')],
    ['a missing product', Buffer.from(JSON.stringify({ t: T, s: S })).toString('base64url')],
    ['a non-uuid product', Buffer.from(JSON.stringify({ t: T, s: S, a: 'x' })).toString('base64url')],
  ])('refuses %s', (_name, token) => {
    expect(() => decodeAvailabilityCursor(token, T, S)).toThrow(AvailabilityCursorError);
  });
});
