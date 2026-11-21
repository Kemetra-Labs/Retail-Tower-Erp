/**
 * RT-363 (G1, RT-264 D1: `tenderRef := tender_line_id`) — one capture tender per tender line,
 * with `tenderRef` and `sequence`, behind a finalize-time cutoff (`tenderRefsSince`).
 *
 * The body is rebuilt on every send and Backend-Core answers 409 to a different body under the
 * same Idempotency-Key, so the byte-identity cases compare the FULL wire string
 * (`JSON.stringify(toWireBody(...))`), never just `.tenders`. That a sale already attempted keeps
 * its body across restarts, whatever the environment does, is `tender-refs-restart.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { buildCapturePayload, parseTenderRefsSince } from '../capture-payload.js';
import { toWireBody } from '../create-sale-sync-client.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';

const TENDERS_CUTOFF = '2026-06-01T00:00:00.000Z';
const REFS_CUTOFF = '2026-06-10T00:00:00.000Z';
const BEFORE_REFS = '2026-06-05T10:00:00.000Z'; // after the tenders cutoff, before the refs one
const AFTER_REFS = '2026-06-11T10:00:00.000Z';

const L1 = 'a1111111-1111-4111-8111-111111111111';
const L2 = 'b2222222-2222-4222-8222-222222222222';
const L3 = 'c3333333-3333-4333-8333-333333333333';
const RED = '3f1c6a52-9d0e-4b7a-8a41-0c2d5e7f9a10';

const OFF = { tendersSince: TENDERS_CUTOFF };
const ON = { tendersSince: TENDERS_CUTOFF, tenderRefsSince: REFS_CUTOFF };

function saleRow(lines: unknown[], over: Partial<SaleRow> = {}): SaleRow {
  return {
    sale_id: 'sale-1',
    sale_number: 'SN-1',
    receipt_number: 'R-1',
    envelope_handoff_action_id: 'handoff-abc',
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'term-1',
    terminal_label: 'Till 1',
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Operator One',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary_json: JSON.stringify(lines),
    settled_at: AFTER_REFS,
    finalized_at: AFTER_REFS,
    tenant_tax_registration_id: 'TRN-123',
    branch_name: 'Main',
    branch_address: 'Cairo',
    local_calendar_day: '2026-06-11',
    lines_json: JSON.stringify([
      {
        line_id: 'l-1',
        item_ref: 'p-1',
        display_name: 'Panadol',
        quantity: 2,
        unit_price_minor: 750,
        line_subtotal_minor: 1500,
      },
    ]),
    ...over,
  };
}

/** The exact bytes the client would POST for this sale under these cutoffs. */
function wire(sale: SaleRow, options: Parameters<typeof buildCapturePayload>[1]): string {
  return JSON.stringify(toWireBody(buildCapturePayload(sale, options), 'EGP'));
}

/** A frozen summary (RT-362 shape): identity on every line. */
const SPLIT_CASH = [
  { tender_type: 'cash', amount_applied_minor: 1000, tender_line_id: L1, sequence: 1 },
  {
    tender_type: 'cash',
    amount_applied_minor: 700,
    change_due_minor: 200,
    tender_line_id: L2,
    sequence: 2,
  },
];

/** The same sale as the legacy summary (frozen before RT-362): no identity. */
const SPLIT_CASH_LEGACY = [
  { tender_type: 'cash', amount_applied_minor: 1000 },
  { tender_type: 'cash', amount_applied_minor: 700, change_due_minor: 200 },
];

describe('RT-363 — one tender per line past the tender-refs cutoff', () => {
  it('a post-cutoff split cash+cash sale sends two tenders, distinct tenderRef, sequence 1 and 2, NET of change', () => {
    const body = toWireBody(buildCapturePayload(saleRow(SPLIT_CASH), ON), 'EGP');
    expect(body.tenders).toEqual([
      { method: 'cash', amount: '10.00', tenderRef: L1, sequence: 1 },
      { method: 'cash', amount: '5.00', tenderRef: L2, sequence: 2 },
    ]);
  });

  it('every tender of a mixed sale carries its identity, in apply order (not grouped by method)', () => {
    const lines = [
      {
        tender_type: 'external_card_terminal',
        amount_applied_minor: 500,
        tender_line_id: L1,
        sequence: 1,
      },
      { tender_type: 'cash', amount_applied_minor: 600, tender_line_id: L2, sequence: 2 },
      { tender_type: 'cash', amount_applied_minor: 400, tender_line_id: L3, sequence: 3 },
    ];
    expect(buildCapturePayload(saleRow(lines), ON).tenders).toEqual([
      { method: 'card_external', amountMinor: 500, tenderRef: L1, sequence: 1 },
      { method: 'cash', amountMinor: 600, tenderRef: L2, sequence: 2 },
      { method: 'cash', amountMinor: 400, tenderRef: L3, sequence: 3 },
    ]);
  });

  it('a zero-net line is dropped as today, and the other lines keep their frozen sequence', () => {
    const lines = [
      {
        tender_type: 'cash',
        amount_applied_minor: 200,
        change_due_minor: 200,
        tender_line_id: L1,
        sequence: 1,
      },
      { tender_type: 'cash', amount_applied_minor: 1500, tender_line_id: L2, sequence: 2 },
    ];
    expect(buildCapturePayload(saleRow(lines), ON).tenders).toEqual([
      { method: 'cash', amountMinor: 1500, tenderRef: L2, sequence: 2 },
    ]);
  });

  it('a single voucher carries redemptionId, tenderRef and sequence', () => {
    const lines = [
      {
        tender_type: 'internal_voucher',
        amount_applied_minor: 1500,
        voucher_authority_redemption_id: RED,
        tender_line_id: L1,
        sequence: 1,
      },
    ];
    expect(buildCapturePayload(saleRow(lines), ON).tenders).toEqual([
      { method: 'voucher', amountMinor: 1500, redemptionId: RED, tenderRef: L1, sequence: 1 },
    ]);
  });

  it('lines are sent in sequence order, whatever order the summary lists them', () => {
    const lines = [
      { tender_type: 'cash', amount_applied_minor: 400, tender_line_id: L3, sequence: 3 },
      { tender_type: 'cash', amount_applied_minor: 600, tender_line_id: L1, sequence: 1 },
      {
        tender_type: 'external_card_terminal',
        amount_applied_minor: 500,
        tender_line_id: L2,
        sequence: 2,
      },
    ];
    expect(buildCapturePayload(saleRow(lines), ON).tenders?.map((t) => t.sequence)).toEqual([
      1, 2, 3,
    ]);
  });

  it('two vouchers each keep their redemptionId, tenderRef and sequence', () => {
    const RED_2 = '7b9e1d34-2c58-4f06-9a73-5d8e0b1c4f22';
    const lines = [
      {
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
        voucher_authority_redemption_id: RED,
        tender_line_id: L1,
        sequence: 1,
      },
      {
        tender_type: 'internal_voucher',
        amount_applied_minor: 500,
        voucher_authority_redemption_id: RED_2,
        tender_line_id: L2,
        sequence: 2,
      },
    ];
    expect(buildCapturePayload(saleRow(lines), ON).tenders).toEqual([
      { method: 'voucher', amountMinor: 1000, redemptionId: RED, tenderRef: L1, sequence: 1 },
      { method: 'voucher', amountMinor: 500, redemptionId: RED_2, tenderRef: L2, sequence: 2 },
    ]);
  });

  it('the same redemption id twice is still not sendable per line (also in another letter case)', () => {
    const line = (id: string, sequence: number, redemption: string) => ({
      tender_type: 'internal_voucher',
      amount_applied_minor: 750,
      voucher_authority_redemption_id: redemption,
      tender_line_id: id,
      sequence,
    });
    expect(() =>
      buildCapturePayload(saleRow([line(L1, 1, RED), line(L2, 2, RED.toUpperCase())]), ON),
    ).toThrow('voucher redemption id repeated');
  });

  it('keeps the sum check: lines that do not add up to the total stay not sendable', () => {
    const lines = [
      { tender_type: 'cash', amount_applied_minor: 1400, tender_line_id: L1, sequence: 1 },
    ];
    expect(() => buildCapturePayload(saleRow(lines), ON)).toThrow(
      'tenders sum 1400 != sale total 1500',
    );
  });

  it('keeps the fail-closed path: an unknown tender type is still not sendable', () => {
    const lines = [
      { tender_type: 'crypto', amount_applied_minor: 1500, tender_line_id: L1, sequence: 1 },
    ];
    expect(() => buildCapturePayload(saleRow(lines), ON)).toThrow('unsupported tender type crypto');
  });
});

describe('RT-363 — everything else stays byte-identical to today', () => {
  it('a sale finalized BEFORE the refs cutoff sends the merged body, same bytes as with the option absent', () => {
    const sale = saleRow(SPLIT_CASH, { finalized_at: BEFORE_REFS });
    expect(wire(sale, ON)).toBe(wire(sale, OFF));
    expect(buildCapturePayload(sale, ON).tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
  });

  it('a sale finalized exactly AT the refs cutoff already splits (the cutoff is inclusive, like tendersSince)', () => {
    const sale = saleRow(SPLIT_CASH, { finalized_at: REFS_CUTOFF });
    expect(buildCapturePayload(sale, ON).tenders).toHaveLength(2);
  });

  it('a legacy summary (no tender_line_id) sends the merged body, same bytes as with the option absent', () => {
    const sale = saleRow(SPLIT_CASH_LEGACY);
    expect(wire(sale, ON)).toBe(wire(sale, OFF));
    expect(buildCapturePayload(sale, ON).tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
  });

  it('with the option absent, null or undefined, a post-cutoff identified sale is the merged body', () => {
    const sale = saleRow(SPLIT_CASH);
    const merged = wire(sale, OFF);
    expect(wire(sale, { ...OFF, tenderRefsSince: null })).toBe(merged);
    expect(wire(sale, { ...OFF, tenderRefsSince: undefined })).toBe(merged);
    expect(merged).not.toContain('tenderRef');
    expect(merged).not.toContain('sequence');
  });

  it('the refs cutoff on but the tenders cutoff off: no tenders at all', () => {
    const sale = saleRow(SPLIT_CASH);
    expect('tenders' in buildCapturePayload(sale, { tenderRefsSince: REFS_CUTOFF })).toBe(false);
    expect(
      'tenders' in buildCapturePayload(sale, { tendersSince: null, tenderRefsSince: REFS_CUTOFF }),
    ).toBe(false);
  });

  it('the refs cutoff on and a sale before the TENDERS cutoff: still no tenders', () => {
    const sale = saleRow(SPLIT_CASH, { finalized_at: '2026-05-31T23:59:59.999Z' });
    expect('tenders' in buildCapturePayload(sale, ON)).toBe(false);
  });

  it('an empty summary stays tender-unknown with the option on', () => {
    expect(wire(saleRow([]), ON)).toBe(wire(saleRow([]), OFF));
  });

  it('a sale whose merged body is the RT-858 zero cash tender is unchanged', () => {
    const sale = saleRow([], {
      subtotal_minor: 0,
      lines_json: JSON.stringify([
        {
          line_id: 'l-1',
          item_ref: 'p-1',
          display_name: 'Free',
          quantity: 1,
          unit_price_minor: 500,
          line_subtotal_minor: 500,
          discount: {
            kind: 'percent',
            value: 100,
            amount_minor: 500,
            placeholder_id: 'dp-1',
            reason_code: 'promotion',
            authority_source: 'cashier_approval',
            approver_role: 'manager',
            approver_operator_id: 'mgr-1',
          },
        },
      ]),
    });
    expect(buildCapturePayload(sale, ON).tenders).toEqual([{ method: 'cash', amountMinor: 0 }]);
    expect(wire(sale, ON)).toBe(wire(sale, OFF));
  });
});

describe('RT-363 — an unusable identity falls back to the merged body (deterministic, never a throw)', () => {
  const legacyOf = (lines: unknown[]): string => wire(saleRow(lines), OFF);

  it.each([
    [
      'a line without tender_line_id',
      [{ ...SPLIT_CASH[0] }, { ...SPLIT_CASH[1], tender_line_id: undefined }],
    ],
    ['a non-uuid tender_line_id', [{ ...SPLIT_CASH[0], tender_line_id: 'line-1' }, SPLIT_CASH[1]]],
    ['a line without a sequence', [SPLIT_CASH[0], { ...SPLIT_CASH[1], sequence: undefined }]],
    ['a zero sequence', [SPLIT_CASH[0], { ...SPLIT_CASH[1], sequence: 0 }]],
    ['a fractional sequence', [SPLIT_CASH[0], { ...SPLIT_CASH[1], sequence: 1.5 }]],
    ['a sequence above the contract bound', [SPLIT_CASH[0], { ...SPLIT_CASH[1], sequence: 32768 }]],
    ['a repeated sequence', [SPLIT_CASH[0], { ...SPLIT_CASH[1], sequence: 1 }]],
    ['a repeated tender_line_id', [SPLIT_CASH[0], { ...SPLIT_CASH[1], tender_line_id: L1 }]],
    [
      'the same id in another letter case',
      [SPLIT_CASH[0], { ...SPLIT_CASH[1], tender_line_id: L1.toUpperCase() }],
    ],
  ])('%s', (_name, lines) => {
    const sale = saleRow(lines);
    expect(wire(sale, ON)).toBe(legacyOf(lines));
    expect(buildCapturePayload(sale, ON).tenders).toEqual([{ method: 'cash', amountMinor: 1500 }]);
  });

  it('more entries than the contract allows (16) falls back to the merged body (RT-1052 stays true)', () => {
    const many = Array.from({ length: 17 }, (_, i) => ({
      tender_type: 'cash',
      amount_applied_minor: 100,
      tender_line_id: `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      sequence: i + 1,
    }));
    const sale = saleRow(many, { subtotal_minor: 1700 });
    expect(buildCapturePayload(sale, ON).tenders).toEqual([{ method: 'cash', amountMinor: 1700 }]);
    expect(wire(sale, ON)).toBe(wire(sale, OFF));
  });

  it('exactly 16 entries still splits', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ({
      tender_type: 'cash',
      amount_applied_minor: 100,
      tender_line_id: `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      sequence: i + 1,
    }));
    const sale = saleRow(sixteen, { subtotal_minor: 1600 });
    expect(buildCapturePayload(sale, ON).tenders).toHaveLength(16);
  });
});

describe('RT-363 — parseTenderRefsSince (POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE)', () => {
  it('unset / blank / unparseable / zone-less -> null (off, fail-safe)', () => {
    for (const raw of [undefined, '', '   ', 'garbage', '2026-06-10', '2026-06-10T00:00:00']) {
      expect(parseTenderRefsSince(raw)).toBeNull();
    }
  });

  it('an explicit-zone instant -> its canonical UTC form, like the tenders cutoff', () => {
    expect(parseTenderRefsSince('2026-06-10T02:00:00+02:00')).toBe('2026-06-10T00:00:00.000Z');
    expect(parseTenderRefsSince(' 2026-06-10T00:00:00Z ')).toBe('2026-06-10T00:00:00.000Z');
  });
});
