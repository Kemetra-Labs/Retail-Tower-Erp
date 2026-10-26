/**
 * RT-858 (RT-699 I4, doc 28 §6 C-A) — the capture sends the manual line
 * discount.
 *
 * A line frozen with a `discount` (RT-856) is captured at its NET
 * `lineAmount` with the RT-740 `CaptureSaleLineDiscount`: `kind`, `value`,
 * `amount`, `reasonCode`, `authoritySource`, `approverRole`. The amount is the
 * RT-699 math on the frozen gross (percent half up, once per line), re-checked
 * here; the till's placeholder and approver operator ids never cross. An
 * undiscounted line, and so an undiscounted body, is byte-identical to before.
 * A discounted sale whose total is 0 sends one `cash` tender of 0 (OZ-1 = Z-A).
 */
import { describe, expect, it } from 'vitest';

import {
  buildCapturePayload,
  DiscountNotSendableError,
  type CaptureSaleLine,
} from '../capture-payload.js';
import { toCashierWireBody, toWireBody } from '../create-sale-sync-client.js';
import type { PosSalesSales } from '../../../shared/api-types.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';
import { nn } from './__helpers__/sales-sync-fixture.js';

type ContractLine = PosSalesSales.components['schemas']['CaptureSaleLine'];
type ContractRequest = PosSalesSales.components['schemas']['CaptureSaleRequest'];
type WireLine = ReturnType<typeof toWireBody>['lines'][number];

// Compile-time: a discounted wire line is a contract `CaptureSaleLine` of the
// pinned `sales.yaml` (generated types), discount included.
const _lineToContract: ContractLine = null as unknown as WireLine;
void _lineToContract;

const CUTOFF = '2026-01-01T00:00:00.000Z';

interface FrozenLine {
  line_id: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
  discount?: Record<string, unknown>;
}

function frozenDiscount(over: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'percent',
    value: 10,
    amount_minor: 900,
    placeholder_id: 'dp-1',
    reason_code: 'promotion',
    authority_source: 'cashier_approval',
    approver_role: 'manager',
    approver_operator_id: 'mgr-1',
    ...over,
  };
}

function line(over: Partial<FrozenLine> = {}): FrozenLine {
  return {
    line_id: 'l-1',
    quantity: 2,
    unit_price_minor: 4500,
    line_subtotal_minor: 9000,
    ...over,
  };
}

function sale(lines: FrozenLine[], over: Partial<SaleRow> = {}): SaleRow {
  const snapshot = lines.map((l, i) => ({
    item_ref: `p-${String(i + 1)}`,
    display_name: `Item ${String(i + 1)}`,
    note: null,
    ...l,
  }));
  const net = lines.reduce(
    (sum, l) => sum + l.line_subtotal_minor - Number(l.discount?.['amount_minor'] ?? 0),
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

function firstLine(row: SaleRow): CaptureSaleLine {
  return nn(buildCapturePayload(row).lines[0]);
}

describe('RT-858 — the captured line discount', () => {
  it('percent: the net lineAmount and the discount with attribution', () => {
    const captured = firstLine(sale([line({ discount: frozenDiscount({}) })]));
    expect(captured).toMatchObject({ unitPriceMinor: 4500, quantity: 2, lineAmountMinor: 8100 });
    expect(captured.discount).toEqual({
      kind: 'percent',
      value: 10,
      amountMinor: 900,
      reasonCode: 'promotion',
      authoritySource: 'cashier_approval',
      approverRole: 'manager',
    });
  });

  it('amount: value and amount are the same minor units; a manager session path', () => {
    const discount = frozenDiscount({
      kind: 'amount',
      value: 500,
      amount_minor: 500,
      authority_source: 'manager_session',
      approver_role: 'admin',
      reason_code: 'price_correction',
    });
    const captured = firstLine(sale([line({ discount })]));
    expect(captured.lineAmountMinor).toBe(8500);
    expect(captured.discount).toEqual({
      kind: 'amount',
      value: 500,
      amountMinor: 500,
      reasonCode: 'price_correction',
      authoritySource: 'manager_session',
      approverRole: 'admin',
    });
  });

  it('free line (100%): lineAmount 0', () => {
    const discount = frozenDiscount({ value: 100, amount_minor: 9000 });
    expect(firstLine(sale([line({ discount })])).lineAmountMinor).toBe(0);
  });

  it('percent rounds half up once on the line gross, as RT-699 and Backend-Core do', () => {
    const gross = { quantity: 1, unit_price_minor: 105, line_subtotal_minor: 105 };
    const rounded = sale([line({ ...gross, discount: frozenDiscount({ amount_minor: 11 }) })]);
    expect(firstLine(rounded).lineAmountMinor).toBe(94);
    const truncated = sale([line({ ...gross, discount: frozenDiscount({ amount_minor: 10 }) })]);
    expect(() => buildCapturePayload(truncated)).toThrow(DiscountNotSendableError);
  });

  it('an undiscounted line is unchanged: gross lineAmount, no discount key', () => {
    const captured = firstLine(sale([line()]));
    expect(captured).toEqual({
      lineRef: 'l-1',
      productRef: 'p-1',
      lineName: 'Item 1',
      quantity: 2,
      unitPriceMinor: 4500,
      lineAmountMinor: 9000,
    });
    expect('discount' in captured).toBe(false);
  });

  it('a mixed sale: only the discounted line changes, the total is the net', () => {
    const row = sale([line({ discount: frozenDiscount({}) }), line({ line_id: 'l-2' })]);
    const payload = buildCapturePayload(row);
    expect(payload.totalMinor).toBe(17_100);
    expect(payload.lines.map((l) => l.lineAmountMinor)).toEqual([8100, 9000]);
    expect(payload.lines.reduce((sum, l) => sum + l.lineAmountMinor, 0)).toBe(payload.totalMinor);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an amount that is not the RT-699 math', { amount_minor: 901 }],
    ['an amount above the gross', { kind: 'amount', value: 9001, amount_minor: 9001 }],
    ['an unknown kind', { kind: 'bogo' }],
    ['a fractional percent', { value: 10.5 }],
    ['an unclosed reason', { reason_code: 'friend' }],
    ['an unknown authority', { authority_source: 'self' }],
  ])('%s is not sendable (dead-lettered, never POSTed)', (_name, over) => {
    const row = sale([line({ discount: frozenDiscount(over) })]);
    expect(() => buildCapturePayload(row)).toThrow(DiscountNotSendableError);
  });

  it('a non-object discount is not sendable', () => {
    const row = sale([line()], {
      lines_json: JSON.stringify([{ ...line(), item_ref: 'p-1', display_name: 'x', discount: 7 }]),
    });
    expect(() => buildCapturePayload(row)).toThrow(DiscountNotSendableError);
  });

  it('the same row always builds the same body (one Idempotency-Key, one body)', () => {
    const row = sale([line({ discount: frozenDiscount({}) })]);
    expect(buildCapturePayload(row, { tendersSince: CUTOFF })).toEqual(
      buildCapturePayload(row, { tendersSince: CUTOFF }),
    );
  });
});

describe('RT-858 — zero total (OZ-1 = Z-A)', () => {
  const free = (): SaleRow =>
    sale([line({ discount: frozenDiscount({ value: 100, amount_minor: 9000 }) })]);

  it('a discounted zero-total sale sends one cash tender of 0', () => {
    expect(buildCapturePayload(free(), { tendersSince: CUTOFF }).tenders).toEqual([
      { method: 'cash', amountMinor: 0 },
    ]);
  });

  it('with the tender cutoff off it sends no tenders, like every other sale', () => {
    expect('tenders' in buildCapturePayload(free(), { tendersSince: null })).toBe(false);
  });

  it('an undiscounted zero-total sale is unchanged: no tenders', () => {
    const zero = sale([line({ unit_price_minor: 0, line_subtotal_minor: 0 })]);
    expect('tenders' in buildCapturePayload(zero, { tendersSince: CUTOFF })).toBe(false);
  });

  it('a discounted sale with a positive total keeps its real tenders', () => {
    const row = sale([line({ discount: frozenDiscount({}) })]);
    expect(buildCapturePayload(row, { tendersSince: CUTOFF }).tenders).toEqual([
      { method: 'cash', amountMinor: 8100 },
    ]);
  });

  it('the zero tender reaches the wire as 0.00 and sums to posTotal', () => {
    const body = toWireBody(buildCapturePayload(free(), { tendersSince: CUTOFF }), 'EGP');
    expect(body.posTotal).toBe('0.00');
    expect(body.tenders).toEqual([{ method: 'cash', amount: '0.00' }]);
  });
});

describe('RT-858 — the discount on the wire (CaptureSaleLineDiscount)', () => {
  it('percent: value is the whole percent, amount the exact decimal, lineAmount the net', () => {
    const body: ContractRequest = toWireBody(
      buildCapturePayload(sale([line({ discount: frozenDiscount({}) })])),
      'EGP',
    );
    expect(nn(body.lines[0])).toMatchObject({
      unitPrice: '45.00',
      quantity: '2',
      lineAmount: '81.00',
      discount: {
        kind: 'percent',
        value: '10',
        amount: '9.00',
        reasonCode: 'promotion',
        authoritySource: 'cashier_approval',
        approverRole: 'manager',
      },
    });
  });

  it('amount: value equals amount as an exact decimal; exponent 0 has no point', () => {
    const discount = frozenDiscount({ kind: 'amount', value: 550, amount_minor: 550 });
    const payload = buildCapturePayload(sale([line({ discount })]));
    expect(nn(toWireBody(payload, 'EGP').lines[0]).discount).toMatchObject({
      value: '5.50',
      amount: '5.50',
    });
    expect(nn(toWireBody(payload, 'JPY').lines[0]).discount).toMatchObject({
      value: '550',
      amount: '550',
    });
  });

  it('the line obeys the RT-740 price rule: lineAmount = unitPrice × quantity − amount', () => {
    const body = toWireBody(
      buildCapturePayload(sale([line({ discount: frozenDiscount({}) })])),
      'EGP',
    );
    const wire = nn(body.lines[0]);
    const minor = (v: string): number => Math.round(Number(v) * 100);
    expect(minor(wire.lineAmount)).toBe(
      minor(wire.unitPrice) * Number(wire.quantity) - minor(nn(wire.discount).amount),
    );
  });

  it('no till id, no approverUserId, only the contract keys', () => {
    const body = toCashierWireBody(
      buildCapturePayload(sale([line({ discount: frozenDiscount({}) })])),
      'EGP',
      '0190a3c4-0000-7000-8000-00000000000a',
    );
    expect(Object.keys(nn(nn(body.lines[0]).discount)).sort()).toEqual([
      'amount',
      'approverRole',
      'authoritySource',
      'kind',
      'reasonCode',
      'value',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/placeholder|approver_operator|mgr-1|dp-1/);
  });

  it('an undiscounted wire line carries no discount key (body unchanged)', () => {
    const wire = nn(toWireBody(buildCapturePayload(sale([line()])), 'EGP').lines[0]);
    expect('discount' in wire).toBe(false);
  });
});
