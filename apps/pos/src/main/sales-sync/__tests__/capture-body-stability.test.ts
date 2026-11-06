/**
 * RT-1240 — the capture request body is byte-identical across re-sends of the
 * same stored sale.
 *
 * Since RT-1206 Backend-Core answers 409 `idempotency_key_conflict` to a
 * `captureSale` provenance replay whose `payload_hash` differs from the stored
 * sale, comparing the raw body literally (RT-1206 c15590: array order and money
 * string format included). The POS rebuilds the body on every send, so every
 * send-time input to `buildCapturePayload` and the wire transform must be
 * frozen or stable:
 *
 *   • the `SaleRow` — append-only (migration 0021), re-read on every send;
 *   • `resolvedRoles` (RT-906) — the append-only `sale_discount_role_resolutions`
 *     rows (migration 0058), never the live PIN record (the full-stack case is
 *     in `discount-role-resolver.test.ts`, "RT-1240");
 *   • `tendersSince` / `receiptSince` — process configuration read at boot;
 *   • the currency code — the build constant `DEFAULT_CURRENCY_CODE`;
 *   • no clock, no random, no lookup inside the builder; line order is
 *     `lines_json` order, tender order is first-seen order of the frozen summary.
 *
 * These tests rebuild the body for the same stored sale with the wall clock
 * moved past the 72h replay window, from a fresh copy of the row (as a re-read
 * from SQLite gives) and a freshly read roles map, and compare the JSON bytes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCapturePayload, type BuildCapturePayloadOptions } from '../capture-payload.js';
import {
  DEFAULT_CURRENCY_CODE,
  toCashierWireBody,
  toWireBody,
} from '../create-sale-sync-client.js';
import type { CaptureApproverRole } from '../discount-role-resolutions.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';

const CUTOFF = '2026-01-01T00:00:00.000Z';
const FIRST_SEND = '2026-10-26T10:00:05.000Z';
/** After RT-1206's 72h replay window, when a changed body would be a 409. */
const LATE_RETRY = '2026-11-02T10:00:00.000Z';
const CASHIER_USER = '0190f5a2-3b4c-7d8e-9f01-00000000000c';

/** A line frozen with a discount and NO `approver_role` (RT-906: resolved from 0058). */
const ROLELESS_DISCOUNT = {
  kind: 'percent',
  value: 10,
  amount_minor: 900,
  placeholder_id: 'dp-1',
  reason_code: 'promotion',
  authority_source: 'cashier_approval',
  approver_operator_id: 'mgr-1',
};

/** A second line with a frozen amount discount and a frozen role. */
const FROZEN_AMOUNT_DISCOUNT = {
  kind: 'amount',
  value: 250,
  amount_minor: 250,
  placeholder_id: 'dp-2',
  reason_code: 'price_correction',
  authority_source: 'manager_session',
  approver_role: 'admin',
  approver_operator_id: 'mgr-2',
};

/** A third line with no role frozen, resolved under its own placeholder. */
const SECOND_ROLELESS_DISCOUNT = {
  ...ROLELESS_DISCOUNT,
  placeholder_id: 'dp-3',
  value: 50,
  amount_minor: 500,
};

const LINES = [
  {
    line_id: 'l-1',
    item_ref: 'p-1',
    display_name: 'Panadol',
    note: null,
    quantity: 2,
    unit_price_minor: 4500,
    line_subtotal_minor: 9000,
    discount: ROLELESS_DISCOUNT,
  },
  {
    line_id: 'l-2',
    item_ref: '0190f5a2-3b4c-7d8e-9f01-0000000000f2',
    display_name: 'Vitamin C',
    note: null,
    quantity: 1,
    unit_price_minor: 1000,
    line_subtotal_minor: 1000,
    discount: FROZEN_AMOUNT_DISCOUNT,
  },
  {
    line_id: 'l-3',
    item_ref: 'p-3',
    display_name: 'Bandage',
    note: null,
    quantity: 3,
    unit_price_minor: 333,
    line_subtotal_minor: 999,
    discount: SECOND_ROLELESS_DISCOUNT,
  },
  {
    line_id: 'l-4',
    item_ref: 'p-4',
    display_name: 'Gauze',
    note: null,
    quantity: 1,
    unit_price_minor: 10,
    line_subtotal_minor: 10,
  },
];

// 8100 + 750 + 499 (999 less 50%, half up: 500 off) + 10 = 9359.
const TOTAL = 9359;

/**
 * Tenders deliberately card first, then cash split over two lines with change:
 * the wire order is first-seen (card, cash) and cash is summed net of change.
 */
const TENDER_SUMMARY = [
  { tender_type: 'external_card_terminal', amount_applied_minor: 5000, change_due_minor: 0 },
  { tender_type: 'cash', amount_applied_minor: 4000, change_due_minor: 641 },
  { tender_type: 'cash', amount_applied_minor: 1000, change_due_minor: 0 },
];

function storedSale(): SaleRow {
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
    subtotal_minor: TOTAL,
    total_tax_minor: 0,
    total_change_due_minor: 641,
    tender_lines_summary_json: JSON.stringify(TENDER_SUMMARY),
    // Finalized 60 s after settling (boot recovery): `admissionCheckAt` is sent.
    settled_at: '2026-10-26T09:59:00.000Z',
    finalized_at: '2026-10-26T10:00:00.000Z',
    tenant_tax_registration_id: 'TRN-1',
    branch_name: 'Main',
    branch_address: 'Cairo',
    local_calendar_day: '2026-10-26',
    lines_json: JSON.stringify(LINES),
  };
}

/** A fresh copy of the stored row, as a new SELECT returns it on each send. */
function reread(row: SaleRow): SaleRow {
  return JSON.parse(JSON.stringify(row)) as SaleRow;
}

/** A fresh read of the sale's 0058 rows, in the given row order. */
function readRoles(entries: [string, CaptureApproverRole][]): Map<string, CaptureApproverRole> {
  return new Map(entries);
}

function options(roles: Map<string, CaptureApproverRole>): BuildCapturePayloadOptions {
  return { tendersSince: CUTOFF, receiptSince: CUTOFF, resolvedRoles: roles };
}

/** The exact bytes `send` POSTs on the envelope path. */
function envelopeBytes(row: SaleRow, opts: BuildCapturePayloadOptions): string {
  return JSON.stringify(toWireBody(buildCapturePayload(row, opts), DEFAULT_CURRENCY_CODE));
}

/** The exact bytes `send` POSTs on the device path. */
function deviceBytes(row: SaleRow, opts: BuildCapturePayloadOptions): string {
  return JSON.stringify(
    toCashierWireBody(buildCapturePayload(row, opts), DEFAULT_CURRENCY_CODE, CASHIER_USER),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RT-1240 — the capture body is byte-identical across re-sends', () => {
  const ROLES: [string, CaptureApproverRole][] = [
    ['dp-1', 'manager'],
    ['dp-3', 'admin'],
  ];

  it.each([
    ['envelope', envelopeBytes],
    ['device', deviceBytes],
  ] as const)(
    '%s path: a late retry of the same stored sale sends the same bytes',
    (_path, bytesOf) => {
      const sale = storedSale();
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIRST_SEND));
      const first = bytesOf(reread(sale), options(readRoles(ROLES)));
      vi.setSystemTime(new Date(LATE_RETRY));
      // Rows read back in the other order: the map order never reaches the body.
      const retry = bytesOf(reread(sale), options(readRoles([...ROLES].reverse())));
      expect(retry).toBe(first);
    },
  );

  it('the body carries every field these tests rely on (not a vacuous pass)', () => {
    const body = JSON.parse(deviceBytes(storedSale(), options(readRoles(ROLES)))) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      posTotal: '93.59',
      admissionCheckAt: '2026-10-26T09:59:00.000Z',
      operatorUserId: CASHIER_USER,
      receipt: { saleNumber: 'SN-1', changeGiven: '6.41' },
    });
    expect(body['tenders']).toEqual([
      { method: 'card_external', amount: '50.00' },
      { method: 'cash', amount: '43.59' },
    ]);
    const lines = body['lines'] as Record<string, unknown>[];
    expect(lines.map((l) => l['lineAmount'])).toEqual(['81.00', '7.50', '4.99', '0.10']);
    expect(
      lines.map((l) => (l['discount'] as Record<string, unknown> | undefined)?.['approverRole']),
    ).toEqual(['manager', 'admin', 'admin', undefined]);
    expect((lines[1]?.['discount'] as Record<string, unknown>)['value']).toBe('2.50');
  });

  it('an RT-906 line with no role saved takes the resolved role, never a live lookup', () => {
    // The builder's only role inputs are the frozen `lines_json` and the 0058
    // rows. A frozen role always wins over a resolution, so a resolution read
    // later for a line that has one changes nothing.
    const sale = storedSale();
    const withExtra = readRoles([...ROLES, ['dp-2', 'manager']]);
    expect(envelopeBytes(sale, options(withExtra))).toBe(
      envelopeBytes(sale, options(readRoles(ROLES))),
    );
  });

  it('the comparison is sensitive: a different saved role would change the bytes', () => {
    // Why the role must come from the append-only 0058 row: had the builder used
    // the live PIN-record role, a role change between sends would do this.
    const sale = storedSale();
    const changed = readRoles([
      ['dp-1', 'admin'],
      ['dp-3', 'admin'],
    ]);
    expect(envelopeBytes(sale, options(changed))).not.toBe(
      envelopeBytes(sale, options(readRoles(ROLES))),
    );
  });

  it('building never mutates the stored row or the roles it was given', () => {
    const sale = storedSale();
    const before = JSON.stringify(sale);
    const roles = readRoles(ROLES);
    envelopeBytes(sale, options(roles));
    deviceBytes(sale, options(roles));
    expect(JSON.stringify(sale)).toBe(before);
    expect([...roles]).toEqual(ROLES);
  });

  it('tenders keep the frozen first-seen order on every build', () => {
    const sale = storedSale();
    const orders = [0, 1, 2].map(() => {
      const body = JSON.parse(envelopeBytes(reread(sale), options(readRoles(ROLES)))) as {
        tenders: { method: string }[];
      };
      return body.tenders.map((t) => t.method).join(',');
    });
    expect(orders).toEqual(['card_external,cash', 'card_external,cash', 'card_external,cash']);
  });
});
