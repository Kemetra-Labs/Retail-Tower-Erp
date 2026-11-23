/**
 * RT-1576 — the pure Available-to-Sell arithmetic (RT-1511 rules A-1, A-3, A-4, A-6, A-7).
 * No database: the facts are given, the composition is the unit under test.
 */
import { composeAvailability } from '../../../src/inventory/availability/availability.rules';

const raw = {
  primaryLocationId: '0a000000-0000-7000-8000-000000000001',
  primarySellable: '100.0000',
  expiredTrackedSellable: '0.0000',
  activeReserved: '0.0000',
  inTransitInbound: '0.0000',
  inTransitOutbound: '0.0000',
  asOf: new Date('2026-11-23T10:00:00.000Z'),
};

describe('composeAvailability', () => {
  it('A-1: ATS = primary sellable - expired tracked sellable - active reserved - safety protection', () => {
    const a = composeAvailability({ ...raw, expiredTrackedSellable: '5.0000', activeReserved: '12.5000' });
    expect(a.availableToSell).toBe('82.5000');
    expect(a.primarySellable).toBe('100.0000');
    expect(a.expiredTrackedSellable).toBe('5.0000');
    expect(a.activeReserved).toBe('12.5000');
  });

  it('A-3: safety protection is zero and reported', () => {
    expect(composeAvailability(raw).safetyProtection).toBe('0.0000');
  });

  it('A-4: a negative ATS is preserved, never clamped', () => {
    const a = composeAvailability({ ...raw, primarySellable: '3.0000', activeReserved: '10.0000' });
    expect(a.availableToSell).toBe('-7.0000');
  });

  it('A-6: In Transit is reported beside ATS and never enters it', () => {
    const a = composeAvailability({ ...raw, inTransitInbound: '40.0000', inTransitOutbound: '7.0000' });
    expect(a.availableToSell).toBe('100.0000');
    expect(a.inTransitInbound).toBe('40.0000');
    expect(a.inTransitOutbound).toBe('7.0000');
  });

  it('A-7: On Order is null and asOf is the read instant', () => {
    const a = composeAvailability(raw);
    expect(a.onOrder).toBeNull();
    expect(a.asOf).toBe('2026-11-23T10:00:00.000Z');
    expect(a.primaryLocationId).toBe(raw.primaryLocationId);
  });
});
