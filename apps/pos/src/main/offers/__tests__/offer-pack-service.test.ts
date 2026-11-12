/**
 * RT-1339 (RT-286 S7, spec 048 §7, OD-8) — the Pack's trusted time and freshness.
 *
 * "Now" is `issuedAt` + the monotonic time since the read began; never the
 * workstation wall clock. A fresh Pack applies offers, a stale one applies none,
 * and after a restart (no anchor) the Pack is unproven and applies none until a
 * read succeeds, whatever the wall clock says.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOfferPack } from '../offer-pack.js';
import { ONLINE_PROOF_MS } from '../offer-pack-service.js';
import {
  ISSUED_AT,
  ISSUED_MS,
  P1,
  TENANT,
  clockedService,
  freshService,
  memoryStore,
  packBody,
  packOffer,
} from './pack-fixture.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('offer pack reader — strict', () => {
  it('reads the contract shape', () => {
    const pack = readOfferPack(packBody());
    expect(pack?.packRevision).toBe(118);
    expect(pack?.offers[0]?.parameters).toEqual({
      buyQuantity: 1,
      getQuantity: 1,
      percentOff: '40',
      maxApplicationsPerSale: null,
    });
    expect(pack?.offers[0]?.eligibleProductIds.has(P1)).toBe(true);
  });

  it.each([
    ['a zone-less instant', { issuedAt: '2026-11-12T10:00:00' }],
    ['a window of 0 hours', { freshnessWindowHours: 0 }],
    ['a lower-case currency', { currencyCode: 'egp' }],
    ['more than 200 offers', { offers: Array.from({ length: 201 }, () => packOffer()) }],
  ])('refuses %s', (_name, over) => {
    expect(readOfferPack(packBody(over))).toBeNull();
  });

  it.each([
    ['an unknown offer type', { ...packOffer(), type: 'fixed_price' }],
    ['a percent of 0', packOffer({ percentOff: '0' })],
    ['a percent of 101', packOffer({ percentOff: '101' })],
    ['a fractional percent', packOffer({ percentOff: '12.5' })],
    ['a non-uuid product id', packOffer({ eligibleProductIds: ['dev-p-001'] })],
    ['an empty eligible set', packOffer({ eligibleProductIds: [] })],
    ['an offline policy outside the closed set', { ...packOffer(), offlinePolicy: 'never' }],
  ])('refuses an offer with %s', (_name, offer) => {
    expect(readOfferPack(packBody({ offers: [offer] }))).toBeNull();
  });

  it('makes a product that two offers claim ineligible for both (never discounted twice)', () => {
    const a = packOffer({ eligibleProductIds: [P1, 'cc000000-0000-7000-8000-000000000001'] });
    const b = packOffer({
      offerId: '0a000000-0000-7000-8000-000000000002',
      eligibleProductIds: [P1],
    });
    const pack = readOfferPack(packBody({ offers: [a, b] }));
    expect(pack?.offers[0]?.eligibleProductIds.has(P1)).toBe(false);
    expect(pack?.offers[0]?.eligibleProductIds.size).toBe(1);
    expect(pack?.offers[1]?.eligibleProductIds.size).toBe(0);
  });
});

describe('offer pack service — trusted time (OD-8)', () => {
  it('holds nothing before the first read', () => {
    expect(clockedService().service.view()).toEqual({ kind: 'none' });
  });

  it('is fresh after a 200, with now = issuedAt + monotonic elapsed', () => {
    const c = freshService();
    c.advance(90_000);
    const view = c.service.view();
    expect(view.kind).toBe('fresh');
    if (view.kind === 'fresh') {
      expect(view.nowMs).toBe(ISSUED_MS + 90_000);
      expect(view.onlineProven).toBe(true);
    }
  });

  it('never reads the workstation wall clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    const c = freshService();
    c.advance(1_000);
    const view = c.service.view();
    expect(view.kind === 'fresh' && view.nowMs).toBe(ISSUED_MS + 1_000);
  });

  it('is stale once the tenant window has elapsed since the last successful read', () => {
    const c = freshService(packBody({ freshnessWindowHours: 24 }));
    c.advance(24 * 3_600_000 - 1);
    expect(c.service.view().kind).toBe('fresh');
    c.advance(1);
    expect(c.service.view().kind).toBe('stale');
  });

  it('honours a tenant window other than the 24 h default', () => {
    const c = freshService(packBody({ freshnessWindowHours: 2 }));
    c.advance(2 * 3_600_000);
    expect(c.service.view().kind).toBe('stale');
  });

  it('a 304 refreshes trusted time and freshness from X-Server-Time, keeping the Pack', () => {
    const c = freshService();
    c.advance(23 * 3_600_000);
    const later = new Date(ISSUED_MS + 23 * 3_600_000).toISOString();
    expect(c.service.applyNotModified({ serverTime: later, monoAtStartMs: c.mono() })).toBe(true);
    c.advance(2 * 3_600_000);
    const view = c.service.view();
    expect(view.kind).toBe('fresh');
    if (view.kind === 'fresh') expect(view.nowMs).toBe(ISSUED_MS + 25 * 3_600_000);
  });

  it('a 304 with no readable X-Server-Time, or with no Pack held, changes nothing', () => {
    const c = freshService();
    c.advance(23 * 3_600_000);
    expect(c.service.applyNotModified({ serverTime: null, monoAtStartMs: c.mono() })).toBe(false);
    expect(c.service.applyNotModified({ serverTime: 'yesterday', monoAtStartMs: c.mono() })).toBe(
      false,
    );
    c.advance(2 * 3_600_000);
    expect(c.service.view().kind).toBe('stale');
    expect(
      clockedService().service.applyNotModified({ serverTime: ISSUED_AT, monoAtStartMs: 0 }),
    ).toBe(false);
  });

  it('takes the monotonic reading at the request start, so latency never extends an offer', () => {
    const c = clockedService();
    const start = c.mono();
    c.advance(4_000); // the request took 4 s
    c.service.applyOk({
      tenantId: TENANT,
      body: packBody(),
      etag: '"abc"',
      serverTime: ISSUED_AT,
      monoAtStartMs: start,
    });
    const view = c.service.view();
    expect(view.kind === 'fresh' && view.nowMs).toBe(ISSUED_MS + 4_000);
  });

  it('refuses a body whose header disagrees, one without an ETag, and one off-contract', () => {
    const c = clockedService();
    const ok = { tenantId: TENANT, body: packBody(), etag: '"abc"', monoAtStartMs: 0 };
    expect(c.service.applyOk({ ...ok, serverTime: '2026-11-12T10:00:01.000Z' })).toBe(false);
    expect(c.service.applyOk({ ...ok, serverTime: ISSUED_AT, etag: null })).toBe(false);
    expect(c.service.applyOk({ ...ok, serverTime: ISSUED_AT, body: { nope: 1 } })).toBe(false);
    expect(c.service.view()).toEqual({ kind: 'none' });
  });

  it('a failed read leaves the held Pack and its anchor as they were', () => {
    const c = freshService();
    c.advance(5 * 60_000);
    c.service.applyOk({
      tenantId: TENANT,
      body: { broken: true },
      etag: '"x"',
      serverTime: ISSUED_AT,
      monoAtStartMs: c.mono(),
    });
    const view = c.service.view();
    expect(view.kind === 'fresh' && view.nowMs).toBe(ISSUED_MS + 5 * 60_000);
  });
});

describe('offer pack service — restart without a fresh Pack', () => {
  it('restores the stored Pack as unproven: no "now", no freshness, so no offer applies', () => {
    const first = freshService();
    const second = clockedService(memoryStore(first.store.saved));
    second.service.restore(TENANT);
    expect(second.service.view().kind).toBe('unproven');
    // However long the till has been up, an unproven Pack never becomes fresh by itself.
    second.advance(60_000);
    expect(second.service.view().kind).toBe('unproven');
  });

  it('keeps the ETag so the next read is conditional, and a 304 then proves freshness', () => {
    const first = freshService();
    const second = clockedService(memoryStore(first.store.saved));
    second.service.restore(TENANT);
    expect(second.service.conditionalEtag()).toBe('"abc"');
    second.service.applyNotModified({ serverTime: ISSUED_AT, monoAtStartMs: second.mono() });
    expect(second.service.view().kind).toBe('fresh');
  });

  it('sends no If-None-Match while no readable Pack is held', () => {
    expect(clockedService().service.conditionalEtag()).toBeNull();
  });

  it("drops another tenant's stored Pack and a corrupt one", () => {
    const first = freshService();
    const other = clockedService(memoryStore(first.store.saved));
    other.service.restore('tenant-2');
    expect(other.service.view()).toEqual({ kind: 'none' });
    expect(other.store.saved).toBeNull();

    const corrupt = clockedService(memoryStore({ tenantId: TENANT, etag: '"x"', body: { a: 1 } }));
    corrupt.service.restore(TENANT);
    expect(corrupt.service.view()).toEqual({ kind: 'none' });
    expect(corrupt.store.saved).toBeNull();
  });

  it('persists only the body and ETag of a 200, never a time anchor', () => {
    const c = freshService();
    expect(Object.keys(c.store.saved ?? {}).sort()).toEqual(['body', 'etag', 'tenantId']);
  });
});

describe('offer pack service — online proof for online_only offers', () => {
  it('is proven within ONLINE_PROOF_MS of the last successful read and not after', () => {
    const c = freshService();
    c.advance(ONLINE_PROOF_MS);
    expect(c.service.view()).toMatchObject({ kind: 'fresh', onlineProven: true });
    c.advance(1);
    expect(c.service.view()).toMatchObject({ kind: 'fresh', onlineProven: false });
  });
});
