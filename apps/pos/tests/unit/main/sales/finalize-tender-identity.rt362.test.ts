/**
 * RT-362 (G1, RT-264 D1: `tenderRef := tender_line_id`) — finalize freezes each
 * applied tender line's identity into the sale's `tender_lines_summary_json`:
 * `tender_line_id` and `sequence`, the line's 1-based rank among the applied
 * lines by `apply_order`.
 *
 *   • the dispatch projection reads `tender_line_id` + `apply_order` from the
 *     durable applied lines, in a deterministic order (replay-safe);
 *   • finalize persists them after the existing keys (a legacy line stays an
 *     exact prefix), all lines or none;
 *   • the frozen values never change: a re-finalize is idempotent and the row
 *     is append-only;
 *   • the `sale.finalized` audit payload is unchanged;
 *   • every reader gives the same result for a summary with or without them,
 *     and the receipt bytes are identical.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFinalizeInput } from '../../../../src/main/sales/finalize-dispatch.js';
import {
  bindFinalizeTransaction,
  type FinalizeInput,
} from '../../../../src/main/sales/finalize-transaction.js';
import { freezeTenderLineIdentities } from '../../../../src/main/sales/tender-line-identity.js';
import {
  bindSalesRepository,
  type SaleRow,
} from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { bindSaleNumberAllocator } from '../../../../src/main/sales/sale-number-allocator.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import { deriveReceiptPayload } from '../../../../src/main/receipts/receipts-payload.js';
import { renderReceipt } from '../../../../src/main/receipts/template-engine.js';
import { buildCapturePayload } from '../../../../src/main/sales-sync/capture-payload.js';
import { hasCashTender } from '../../../../src/main/drawer/drawer-kick.js';
import { localTenderEvidence } from '../../../../src/main/returns/returns-tender.js';
import { saleNetCashMinor } from '../../../../src/main/shift-cashup/shift-cashup-calculator.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0003_terminal_assignment.sql',
  '0004_audit_events.sql',
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0024_create_sale_sync_outbox.sql',
  '0025_create_sale_number_sequences.sql',
  '0027_extend_terminal_assignment.sql',
  '0028_extend_sales_with_lines_json.sql',
  '0050_carts_park.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
let captured: Array<Record<string, unknown>>;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
  captured = [];
});

// ── Seeds (the durable state 006 settlement leaves behind) ──────────────────

interface SeedLine {
  id: string;
  amount: number;
  change: number | null;
  state: 'applied' | 'refused';
  order: number;
}

/** Applied tl-a (order 1) and tl-b (order 3), with a refused line (order 2) between them. */
const DEFAULT_LINES: readonly SeedLine[] = [
  { id: 'tl-b', amount: 2000, change: 0, state: 'applied', order: 3 },
  { id: 'tl-a', amount: 4000, change: 500, state: 'applied', order: 1 },
  { id: 'tl-refused', amount: 900, change: null, state: 'refused', order: 2 },
];

function seedSettlement(lines: readonly SeedLine[] = DEFAULT_LINES): void {
  db.run(
    `INSERT INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id,
        printer_vendor_id, printer_product_id, printer_com_port)
     VALUES (1, 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01', 1716800000,
        'Maadi Branch', '12 Road 9, Maadi', 'TRN-100-200-300', '04b8', '0e15', NULL)`,
  );
  db.run(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id, acting_operator_id,
       operator_session_id, envelope_handoff_action_id, envelope_cart_id,
       envelope_subtotal_minor, state, started_at, settled_at, failure_reason,
       force_fail_attribution_operator_id, last_action_id
     ) VALUES ('pa-1', 'tenant-1', 'branch-1', 'terminal-1', 'op-1', 'sess-1',
       'handoff-1', 'cart-1', 5500, 'settled', '2026-05-27T09:59:00.000Z',
       '2026-05-27T10:00:00.000Z', NULL, NULL, 'action-1')`,
  );
  for (const line of lines) {
    db.run(
      `INSERT INTO payment_tender_lines (
         tender_line_id, payment_attempt_id, tender_type, amount_applied_minor, state,
         change_due_minor, applied_at, attribution_operator_id, apply_order, last_action_id
       ) VALUES (?, 'pa-1', 'cash', ?, ?, ?, '2026-05-27T09:59:30.000Z', 'op-1', ?, ?)`,
      [line.id, line.amount, line.state, line.change, line.order, `act-${line.id}`],
    );
  }
  seedFrozenCart();
  seedSettledAudit();
}

function seedFrozenCart(): void {
  const envelope = {
    cart_id: 'cart-1',
    lines: [
      {
        line_id: 'line-1',
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 1,
        unit_price_minor: 5500,
        line_subtotal_minor: 5500,
        note: null,
        version: 1,
        last_action_id: 'a1',
      },
    ],
    discount_placeholders: [],
  };
  db.run(
    `INSERT INTO carts (
       cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
       state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
       cancellation_reason, handoff_envelope_json, last_action_id
     ) VALUES ('cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'op-1', 'sess-1',
       'frozen_handed_off', 5500, '2026-05-27T09:00:00.000Z', '2026-05-27T10:00:00.000Z',
       '2026-05-27T10:00:00.000Z', NULL, NULL, ?, 'action-1')`,
    [JSON.stringify(envelope)],
  );
}

function seedSettledAudit(): void {
  db.run(
    `INSERT INTO audit_events (
       event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id,
       session_id, shift_id, action_category, created_at, approving_supervisor_id, payload
     ) VALUES ('evt-1', 'tenant-1', 'branch-1', 'terminal-1', 'op-1', 'sess-1', NULL,
       'payment.settled', '2026-05-27T10:00:00.000Z', NULL, ?)`,
    [
      JSON.stringify({
        payment_attempt_id: 'pa-1',
        cart_id: 'cart-1',
        handoff_action_id: 'handoff-1',
        settled_at: '2026-05-27T10:00:00.000Z',
        attribution_operator_id: 'op-1',
        selling_operator_display_name: 'Layla Hassan',
      }),
    ],
  );
}

function dispatch(): FinalizeInput {
  const result = buildFinalizeInput({ db: makeSqlJsHandle(db), handoff_action_id: 'handoff-1' });
  if (result.kind !== 'ok') throw new Error(`dispatch refused: ${result.reason}`);
  return result.input;
}

function finalizer() {
  const handle = makeSqlJsHandle(db);
  return bindFinalizeTransaction({
    db: handle,
    salesRepo: bindSalesRepository(handle),
    outboxRepo: bindSaleSyncOutboxRepository(handle),
    allocator: bindSaleNumberAllocator(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: (e) => captured.push(e) } }),
    now: () => '2026-05-27T10:00:00.500Z',
    saleIdGenerator: () => 'sale-1',
    outboxRowIdGenerator: () => 'ob-1',
  });
}

function persistedSummaryJson(): string {
  const rows = db.exec("SELECT tender_lines_summary_json FROM sales WHERE sale_id = 'sale-1'");
  return rows[0]?.values[0]?.[0] as string;
}

const FROZEN_JSON =
  '[{"tender_type":"cash","amount_applied_minor":4000,"change_due_minor":500,' +
  '"tender_line_id":"tl-a","sequence":1},' +
  '{"tender_type":"cash","amount_applied_minor":2000,"change_due_minor":0,' +
  '"tender_line_id":"tl-b","sequence":2}]';

// ── The rank ─────────────────────────────────────────────────────────────────

describe('RT-362 — freezeTenderLineIdentities', () => {
  it('ranks lines 1-based by apply_order; gaps left by refused lines collapse', () => {
    expect(
      freezeTenderLineIdentities([
        { tender_line_id: 'tl-a', apply_order: 1 },
        { tender_line_id: 'tl-b', apply_order: 3 },
        { tender_line_id: 'tl-c', apply_order: 7 },
      ]),
    ).toEqual([
      { tender_line_id: 'tl-a', sequence: 1 },
      { tender_line_id: 'tl-b', sequence: 2 },
      { tender_line_id: 'tl-c', sequence: 3 },
    ]);
  });

  it('ranks by apply_order whatever the input order, and keeps the input order', () => {
    expect(
      freezeTenderLineIdentities([
        { tender_line_id: 'tl-c', apply_order: 9 },
        { tender_line_id: 'tl-a', apply_order: 2 },
        { tender_line_id: 'tl-b', apply_order: 4 },
      ]),
    ).toEqual([
      { tender_line_id: 'tl-c', sequence: 3 },
      { tender_line_id: 'tl-a', sequence: 1 },
      { tender_line_id: 'tl-b', sequence: 2 },
    ]);
  });

  it('breaks an apply_order tie by tender_line_id, so a replay ranks the same', () => {
    const forward = freezeTenderLineIdentities([
      { tender_line_id: 'tl-y', apply_order: 1 },
      { tender_line_id: 'tl-x', apply_order: 1 },
    ]);
    const reverse = freezeTenderLineIdentities([
      { tender_line_id: 'tl-x', apply_order: 1 },
      { tender_line_id: 'tl-y', apply_order: 1 },
    ]);
    expect(forward).toEqual([
      { tender_line_id: 'tl-y', sequence: 2 },
      { tender_line_id: 'tl-x', sequence: 1 },
    ]);
    expect(reverse).toEqual([
      { tender_line_id: 'tl-x', sequence: 1 },
      { tender_line_id: 'tl-y', sequence: 2 },
    ]);
  });

  it('freezes nothing for a sale with no tender lines', () => {
    expect(freezeTenderLineIdentities([])).toEqual([]);
  });

  it.each([
    ['a line without an id', [{ apply_order: 1 }]],
    ['a line with an empty id', [{ tender_line_id: '', apply_order: 1 }]],
    ['a line without an apply_order', [{ tender_line_id: 'tl-a' }]],
    ['a zero apply_order', [{ tender_line_id: 'tl-a', apply_order: 0 }]],
    ['a fractional apply_order', [{ tender_line_id: 'tl-a', apply_order: 1.5 }]],
    [
      'an unsafe apply_order',
      [{ tender_line_id: 'tl-a', apply_order: Number.MAX_SAFE_INTEGER + 1 }],
    ],
    [
      'a duplicate id',
      [
        { tender_line_id: 'tl-a', apply_order: 1 },
        { tender_line_id: 'tl-a', apply_order: 2 },
      ],
    ],
    [
      'one identified line beside one that is not',
      [{ tender_line_id: 'tl-a', apply_order: 1 }, {}],
    ],
  ])('freezes no identity at all for %s', (_label, lines) => {
    expect(freezeTenderLineIdentities(lines)).toBeNull();
  });
});

// ── The dispatch projection ──────────────────────────────────────────────────

describe('RT-362 — buildFinalizeInput carries each applied line identity', () => {
  it('projects tender_line_id and apply_order of the applied lines, by apply_order', () => {
    seedSettlement();
    const lines = dispatch().tender_lines_summary;
    expect(lines.map((l) => [l.tender_line_id, l.apply_order])).toEqual([
      ['tl-a', 1],
      ['tl-b', 3],
    ]);
  });

  it('orders an apply_order tie by tender_line_id, so a re-dispatch reads the same', () => {
    seedSettlement([
      { id: 'tl-z', amount: 3000, change: 0, state: 'applied', order: 1 },
      { id: 'tl-m', amount: 2500, change: 0, state: 'applied', order: 1 },
    ]);
    expect(dispatch().tender_lines_summary.map((l) => l.tender_line_id)).toEqual(['tl-m', 'tl-z']);
    expect(dispatch()).toEqual(dispatch());
  });
});

// ── Finalize ─────────────────────────────────────────────────────────────────

describe('RT-362 — finalize freezes tender_line_id and sequence', () => {
  it('persists them after the existing keys, sequence = rank among the applied lines', () => {
    seedSettlement();
    expect(finalizer().finalize(dispatch()).kind).toBe('finalized');
    expect(persistedSummaryJson()).toBe(FROZEN_JSON);
  });

  it('keeps a summary without identity byte-identical to the legacy shape', () => {
    seedSettlement();
    const input = dispatch();
    const legacy: FinalizeInput = {
      ...input,
      tender_lines_summary: input.tender_lines_summary.map((l) => ({
        tender_type: l.tender_type,
        amount_applied_minor: l.amount_applied_minor,
        ...(l.change_due_minor === undefined ? {} : { change_due_minor: l.change_due_minor }),
      })),
    };
    finalizer().finalize(legacy);
    expect(persistedSummaryJson()).toBe(
      '[{"tender_type":"cash","amount_applied_minor":4000,"change_due_minor":500},' +
        '{"tender_type":"cash","amount_applied_minor":2000,"change_due_minor":0}]',
    );
  });

  it('freezes no identity when one line lacks it (all lines or none)', () => {
    seedSettlement();
    const input = dispatch();
    const [first, second] = input.tender_lines_summary;
    if (first === undefined || second === undefined) throw new Error('expected two lines');
    const secondWithoutId = {
      tender_type: second.tender_type,
      amount_applied_minor: second.amount_applied_minor,
      ...(second.apply_order === undefined ? {} : { apply_order: second.apply_order }),
    };
    finalizer().finalize({ ...input, tender_lines_summary: [first, secondWithoutId] });
    const json = persistedSummaryJson();
    expect(json).not.toContain('tender_line_id');
    expect(json).not.toContain('sequence');
    expect(json).not.toContain('apply_order');
  });

  it('never persists apply_order itself', () => {
    seedSettlement();
    finalizer().finalize(dispatch());
    expect(persistedSummaryJson()).not.toContain('apply_order');
  });

  it('leaves the sale.finalized audit payload shape unchanged', () => {
    seedSettlement();
    finalizer().finalize(dispatch());
    const finalized = captured.find((e) => e.action_category === 'sale.finalized');
    const payload = finalized?.payload as { tender_lines_summary: unknown };
    expect(payload.tender_lines_summary).toEqual([
      { tender_type: 'cash', amount_applied_minor: 4000, change_due_minor: 500 },
      { tender_type: 'cash', amount_applied_minor: 2000, change_due_minor: 0 },
    ]);
  });
});

describe('RT-362 — the frozen identity never changes once the sale is finalized', () => {
  it('a re-finalize of the same handoff is idempotent and does not rewrite the summary', () => {
    seedSettlement();
    const input = dispatch();
    finalizer().finalize(input);
    const reordered: FinalizeInput = {
      ...input,
      tender_lines_summary: input.tender_lines_summary.map((l, i) => ({
        ...l,
        tender_line_id: `other-${String(i)}`,
        apply_order: 10 - i,
      })),
    };
    expect(finalizer().finalize(reordered).kind).toBe('finalized_idempotent');
    expect(persistedSummaryJson()).toBe(FROZEN_JSON);
  });

  it('the sales row refuses an UPDATE of the summary (append-only)', () => {
    seedSettlement();
    finalizer().finalize(dispatch());
    expect(() =>
      db.run("UPDATE sales SET tender_lines_summary_json = '[]' WHERE sale_id = 'sale-1'"),
    ).toThrow(/append-only/);
    expect(persistedSummaryJson()).toBe(FROZEN_JSON);
  });

  it('a replay from the same durable state freezes the same values', () => {
    seedSettlement();
    const first = dispatch();
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSettlement();
    const replayed = dispatch();
    expect(replayed).toEqual(first);
    finalizer().finalize(replayed);
    expect(persistedSummaryJson()).toBe(FROZEN_JSON);
  });
});

// ── Readers: a summary with identity reads exactly like one without ─────────

const LEGACY_JSON =
  '[{"tender_type":"cash","amount_applied_minor":4000,"change_due_minor":0},' +
  '{"tender_type":"cash","amount_applied_minor":1575,"change_due_minor":75}]';
const IDENTIFIED_JSON =
  '[{"tender_type":"cash","amount_applied_minor":4000,"change_due_minor":0,' +
  '"tender_line_id":"tl-a","sequence":1},' +
  '{"tender_type":"cash","amount_applied_minor":1575,"change_due_minor":75,' +
  '"tender_line_id":"tl-b","sequence":2}]';

function saleRow(tender_lines_summary_json: string): SaleRow {
  return {
    sale_id: 'sale-1',
    sale_number: 'TERM-01-2026-05-27-000001',
    receipt_number: 'TERM-01-2026-05-27-000001',
    envelope_handoff_action_id: 'handoff-1',
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    terminal_label: 'TERM-01',
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Layla Hassan',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 5500,
    total_tax_minor: 0,
    total_change_due_minor: 75,
    tender_lines_summary_json,
    settled_at: '2026-05-27T10:00:00.000Z',
    finalized_at: '2026-05-27T10:00:00.500Z',
    tenant_tax_registration_id: 'TRN-100',
    branch_name: 'Maadi Branch',
    branch_address: '12 Road 9, Maadi',
    local_calendar_day: '2026-05-27',
    lines_json: JSON.stringify([
      {
        line_id: 'line-1',
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 1,
        unit_price_minor: 5500,
        line_subtotal_minor: 5500,
        note: null,
        version: 1,
        last_action_id: 'a1',
      },
    ]),
  };
}

describe('RT-362 — existing readers are unaffected by the frozen identity', () => {
  const legacy = saleRow(LEGACY_JSON);
  const identified = saleRow(IDENTIFIED_JSON);

  it.each(['first_print', 'reprint_duplicate', 'preview'] as const)(
    'renders byte-identical %s receipts',
    (variant) => {
      const opts = {
        variant,
        duplicate_copy_sequence_number: 1,
        reprinted_at: '2026-05-28T08:00:00.000Z',
      };
      const before = renderReceipt(deriveReceiptPayload(legacy, opts));
      const after = renderReceipt(deriveReceiptPayload(identified, opts));
      expect(Buffer.from(after.escpos).equals(Buffer.from(before.escpos))).toBe(true);
      expect(after.html).toBe(before.html);
    },
  );

  it('sends the same capture body, before and after the tenders cutoff', () => {
    for (const options of [{}, { tendersSince: '2026-01-01T00:00:00.000Z' }]) {
      expect(JSON.stringify(buildCapturePayload(identified, options))).toBe(
        JSON.stringify(buildCapturePayload(legacy, options)),
      );
    }
    expect(
      buildCapturePayload(identified, { tendersSince: '2026-01-01T00:00:00Z' }).tenders,
    ).toEqual([{ method: 'cash', amountMinor: 5500 }]);
  });

  it('kicks the drawer, proves cash for a return and counts the same drawer cash', () => {
    expect(hasCashTender(IDENTIFIED_JSON)).toBe(hasCashTender(LEGACY_JSON));
    expect(localTenderEvidence(identified)).toBe(localTenderEvidence(legacy));
    expect(localTenderEvidence(identified)).toBe('cash');
    expect(saleNetCashMinor(IDENTIFIED_JSON)).toBe(saleNetCashMinor(LEGACY_JSON));
    expect(saleNetCashMinor(IDENTIFIED_JSON)).toBe(5500);
  });
});
