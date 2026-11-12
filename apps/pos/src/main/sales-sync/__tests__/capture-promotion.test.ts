/**
 * RT-1339 (RT-286 S7, `sales.yaml` 1.22.0-draft) — the capture sends the automatic-offer
 * `promotion` frozen on a sale line.
 *
 * The promotion is read from `lines_json` only (never re-evaluated at send time), so every
 * re-send is byte-identical (RT-1240). A line is sent at its NET `lineAmount` with
 * `promotion.discountAmount`; a sale with no offers is byte-identical to before; a promotion
 * that cannot be sent faithfully is not sendable (dead-lettered, never POSTed).
 */
import { describe, expect, it } from 'vitest';

import { buildCapturePayload, DiscountNotSendableError } from '../capture-payload.js';
import { toWireBody } from '../create-sale-sync-client.js';
import type { PosSalesSales } from '../../../shared/api-types.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';
import { nn } from './__helpers__/sales-sync-fixture.js';

type ContractLine = PosSalesSales.components['schemas']['CaptureSaleLine'];
type WireLine = ReturnType<typeof toWireBody>['lines'][number];
// Compile-time: a promoted wire line is a contract `CaptureSaleLine` of the pinned `sales.yaml`.
const _lineToContract: ContractLine = null as unknown as WireLine;
void _lineToContract;

const OFFER = '0a000000-0000-7000-8000-000000000001';

function promotion(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    offer_id: OFFER,
    offer_version: 3,
    pack_revision: 118,
    offer_name_ar: 'عرض',
    percent_off: 40,
    discount_minor: 6000,
    ...over,
  };
}

function sale(lines: Array<Record<string, unknown>>, over: Partial<SaleRow> = {}): SaleRow {
  const snapshot: Array<Record<string, unknown>> = lines.map((l, i) => ({
    item_ref: `0b000000-0000-7000-8000-00000000000${String(i + 1)}`,
    display_name: `Item ${String(i + 1)}`,
    note: null,
    ...l,
  }));
  const net = snapshot.reduce(
    (sum, l) =>
      sum +
      Number(l['line_subtotal_minor']) -
      ((l['promotion'] as { discount_minor?: number } | undefined)?.discount_minor ?? 0),
    0,
  );
  return {
    sale_id: 'sale-1',
    sale_number: 'SN-1',
    receipt_number: 'R-1',
    envelope_handoff_action_id: 'handoff-1',
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'term-1',
    terminal_label: 'Till 1',
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Operator One',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: net,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary_json: JSON.stringify(
      net > 0 ? [{ tender_type: 'cash', amount_applied_minor: net, change_due_minor: 0 }] : [],
    ),
    settled_at: '2026-10-26T10:00:00.000Z',
    finalized_at: '2026-10-26T10:00:00.000Z',
    tenant_tax_registration_id: 'TRN-1',
    branch_name: 'Main',
    branch_address: 'Cairo',
    local_calendar_day: '2026-10-26',
    lines_json: JSON.stringify(snapshot),
    ...over,
  };
}

const reward = (over: Record<string, unknown> = {}) => ({
  line_id: 'l-2',
  quantity: 1,
  unit_price_minor: 15_000,
  line_subtotal_minor: 15_000,
  promotion: promotion(),
  ...over,
});

describe('RT-1339 — the captured line promotion', () => {
  it('a reward line is sent at its net with the promotion and its discount', () => {
    const payload = buildCapturePayload(sale([reward()]));
    expect(nn(payload.lines[0])).toMatchObject({
      quantity: 1,
      unitPriceMinor: 15_000,
      lineAmountMinor: 9_000,
      promotion: { offerId: OFFER, offerVersion: 3, packRevision: 118, discountAmountMinor: 6_000 },
    });
    const wire = toWireBody(payload, 'EGP');
    expect(wire.posTotal).toBe('90.00');
    expect(wire.lines[0]).toMatchObject({
      lineAmount: '90.00',
      promotion: {
        offerId: OFFER,
        offerVersion: 3,
        packRevision: 118,
        discountAmount: '60.00',
      },
    });
    // The offer's name and percent are receipt copy only; they never cross.
    expect(JSON.stringify(wire)).not.toContain('عرض');
  });

  it('a participating non-reward line carries discountAmount 0.00 and its gross as the net', () => {
    const wire = toWireBody(
      buildCapturePayload(
        sale([
          reward({
            line_id: 'l-1',
            quantity: 2,
            line_subtotal_minor: 30_000,
            promotion: promotion({ discount_minor: 0 }),
          }),
        ]),
      ),
      'EGP',
    );
    expect(wire.lines[0]).toMatchObject({
      quantity: '2',
      lineAmount: '300.00',
      promotion: { discountAmount: '0.00' },
    });
  });

  it('a line without an offer is unchanged: no promotion key, gross lineAmount', () => {
    const payload = buildCapturePayload(
      sale([{ line_id: 'l-1', quantity: 1, unit_price_minor: 100, line_subtotal_minor: 100 }]),
    );
    expect('promotion' in nn(payload.lines[0])).toBe(false);
    expect(JSON.stringify(toWireBody(payload, 'EGP'))).not.toContain('promotion');
  });

  it('is byte-identical on every build from the same stored sale', () => {
    const row = sale([reward()]);
    const a = JSON.stringify(toWireBody(buildCapturePayload(row), 'EGP'));
    const b = JSON.stringify(toWireBody(buildCapturePayload(row), 'EGP'));
    expect(b).toBe(a);
  });

  it('a 100% offer that makes the total 0 sends one cash tender of 0', () => {
    const payload = buildCapturePayload(
      sale([reward({ promotion: promotion({ discount_minor: 15_000 }) })]),
      { tendersSince: '2026-01-01T00:00:00.000Z' },
    );
    expect(payload.totalMinor).toBe(0);
    expect(payload.tenders).toEqual([{ method: 'cash', amountMinor: 0 }]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an offer id that is not a uuid', { offer_id: 'offer-1' }],
    ['an offer version of 0', { offer_version: 0 }],
    ['a fractional pack revision', { pack_revision: 1.5 }],
    ['a negative discount', { discount_minor: -1 }],
    ['a discount above the line gross', { discount_minor: 15_001 }],
  ])('%s is not sendable (dead-lettered, never POSTed)', (_name, over) => {
    expect(() => buildCapturePayload(sale([reward({ promotion: promotion(over) })]))).toThrow(
      DiscountNotSendableError,
    );
  });

  it('a reward discount on a line of quantity above 1 is not sendable (OD-4)', () => {
    expect(() =>
      buildCapturePayload(sale([reward({ quantity: 2, line_subtotal_minor: 30_000 })])),
    ).toThrow(DiscountNotSendableError);
  });

  it('a promotion beside a manual discount is not sendable (OD-5)', () => {
    expect(() =>
      buildCapturePayload(
        sale([reward({ discount: { kind: 'percent', value: 10, amount_minor: 1_500 } })]),
      ),
    ).toThrow(DiscountNotSendableError);
  });

  it('a promotion that is not an object is not sendable', () => {
    expect(() => buildCapturePayload(sale([reward({ promotion: 7 })]))).toThrow(
      DiscountNotSendableError,
    );
  });
});
