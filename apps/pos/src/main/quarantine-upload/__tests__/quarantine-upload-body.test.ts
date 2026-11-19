/**
 * RT-1312 Phase 3(c) — what the till uploads for one stranded sale.
 *
 *   • `saleBody` is the capture WIRE body, rebuilt the deterministic way the
 *     drain builds it for `captureSale`: the envelope body, or the device body
 *     (with the cashier's `operatorUserId`) when the sale's own settled event
 *     names one. Its `sourceSystem` / `externalId` are the upload's.
 *   • The reason maps the till's dead-letter reason: `permanent` → `refused`,
 *     `payload_divergence` (capture 409) and `cashier_claim_refused` (device
 *     403) keep their names and their certain status; the code is unknown
 *     (null): the till has never recorded it. A held sale has neither.
 *   • `previousTerminalId` is the sale's terminal when it is not the current
 *     pairing's (required for a held sale), else null.
 *   • A sale the till could not build a sendable body for (decision P1: an
 *     unsendable tender, a corrupt amount, an unreadable snapshot), or whose
 *     cashier cannot be proven (route `hold`), is skipped, never uploaded.
 */
import { describe, expect, it } from 'vitest';

import { buildCapturePayload } from '../../sales-sync/capture-payload.js';
import { toCashierWireBody, toWireBody } from '../../sales-sync/create-sale-sync-client.js';
import { NO_RESOLVED_ROLES } from '../../sales-sync/discount-role-resolutions.js';
import type { SaleRoute } from '../../sales-sync/selling-user-id.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';
import { buildQuarantineUpload, type QuarantineSource } from '../quarantine-upload-body.js';

const CURRENT = 'term-current';
const EARLIER = 'term-earlier';
const NOW = '2026-11-19T12:00:00.000Z';
const RECORDED = '2026-11-19T09:30:00.000Z';
const USER = '0192f5a2-3b4c-7d8e-9f01-0000000000aa';

function saleRow(over: Partial<SaleRow> = {}): SaleRow {
  return {
    sale_id: 'sale-1',
    sale_number: 'SN-1',
    receipt_number: 'R-1',
    envelope_handoff_action_id: 'handoff-abc',
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: CURRENT,
    terminal_label: 'Till 1',
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Operator One',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary_json: JSON.stringify([{ kind: 'cash', amount_minor: 1500 }]),
    settled_at: '2026-06-07T10:00:00.000Z',
    finalized_at: '2026-06-07T10:00:00.000Z',
    tenant_tax_registration_id: 'TRN-123',
    branch_name: 'Main',
    branch_address: 'Cairo',
    local_calendar_day: '2026-06-07',
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

const ENVELOPE: SaleRoute = { kind: 'envelope' };
const DEVICE: SaleRoute = { kind: 'device', operatorUserId: USER };
const HOLD: SaleRoute = { kind: 'hold' };

function deadLetter(category: string): QuarantineSource {
  return { kind: 'dead_letter', category, tillRecordedAt: RECORDED };
}

function build(
  over: {
    sale?: SaleRow;
    source?: QuarantineSource;
    route?: SaleRoute;
    tendersSince?: string | null;
  } = {},
) {
  return buildQuarantineUpload({
    sale: over.sale ?? saleRow(),
    source: over.source ?? deadLetter('permanent'),
    route: over.route ?? ENVELOPE,
    currentTerminalId: CURRENT,
    cutoffs: { tendersSince: over.tendersSince ?? null, receiptSince: null },
    resolvedRoles: NO_RESOLVED_ROLES,
    now: NOW,
  });
}

function uploadOf(result: ReturnType<typeof build>) {
  if (result.kind !== 'ok') throw new Error(`expected an upload, got skip: ${result.reason}`);
  return result.upload;
}

describe('quarantine upload body — the stored sale', () => {
  it('is the capture wire body the drain would send on the envelope path', () => {
    const sale = saleRow();
    const upload = uploadOf(build({ sale }));
    const payload = buildCapturePayload(sale, { tendersSince: null, receiptSince: null });
    expect(upload.saleBody).toEqual(toWireBody(payload, 'EGP'));
    expect(upload.sourceSystem).toBe('pos-pulse');
    expect(upload.externalId).toBe(payload.externalId);
    expect(upload.saleBody['externalId']).toBe(upload.externalId);
    expect(upload.saleBody['sourceSystem']).toBe(upload.sourceSystem);
    expect(upload.saleBody).not.toHaveProperty('operatorUserId');
  });

  it('carries the cashier operatorUserId when the sale is a device-path sale', () => {
    const sale = saleRow();
    const upload = uploadOf(build({ sale, route: DEVICE }));
    const payload = buildCapturePayload(sale, { tendersSince: null, receiptSince: null });
    expect(upload.saleBody).toEqual(toCashierWireBody(payload, 'EGP', USER));
    expect(upload.saleBody['operatorUserId']).toBe(USER);
  });

  it('records the till idempotency key (the externalId the till sends) for audit', () => {
    const upload = uploadOf(build());
    expect(upload.idempotencyKey).toBe(upload.externalId);
    expect(upload.idempotencyKey).toMatch(/^[\x21-\x7E]{16,128}$/);
  });
});

describe('quarantine upload body — the reason', () => {
  it('permanent → refused, status and code unknown', () => {
    expect(uploadOf(build({ source: deadLetter('permanent') })).reason).toEqual({
      kind: 'refused',
      httpStatus: null,
      errorCode: null,
    });
  });

  it('payload_divergence → payload_divergence with its certain 409', () => {
    expect(uploadOf(build({ source: deadLetter('payload_divergence') })).reason).toEqual({
      kind: 'payload_divergence',
      httpStatus: 409,
      errorCode: null,
    });
  });

  it('cashier_claim_refused → cashier_claim_refused with its certain 403', () => {
    expect(uploadOf(build({ source: deadLetter('cashier_claim_refused') })).reason).toEqual({
      kind: 'cashier_claim_refused',
      httpStatus: 403,
      errorCode: null,
    });
  });

  it('records when the till dead-lettered the sale', () => {
    expect(uploadOf(build()).tillRecordedAt).toBe(RECORDED);
  });

  it('skips a dead-letter reason it does not know', () => {
    expect(build({ source: deadLetter('something_new') })).toEqual({
      kind: 'skip',
      reason: 'unknown_reason',
    });
  });
});

describe('quarantine upload body — the pairing', () => {
  it('a refused sale of the current pairing has no previousTerminalId', () => {
    expect(uploadOf(build()).previousTerminalId).toBeNull();
  });

  it('a refused sale dead-lettered under an earlier pairing keeps that device', () => {
    const upload = uploadOf(build({ sale: saleRow({ terminal_id: EARLIER }) }));
    expect(upload.previousTerminalId).toBe(EARLIER);
    expect(upload.reason.kind).toBe('refused');
  });

  it('a held sale names the earlier pairing, with no status and no code', () => {
    const upload = uploadOf(
      build({ sale: saleRow({ terminal_id: EARLIER }), source: { kind: 'held' } }),
    );
    expect(upload.reason).toEqual({
      kind: 'held_previous_pairing',
      httpStatus: null,
      errorCode: null,
    });
    expect(upload.previousTerminalId).toBe(EARLIER);
    expect(upload.tillRecordedAt).toBe(NOW);
  });

  it('skips a "held" sale that belongs to the current pairing', () => {
    expect(build({ source: { kind: 'held' } })).toEqual({
      kind: 'skip',
      reason: 'held_without_previous_terminal',
    });
  });
});

describe('quarantine upload body — a sale that cannot be sent faithfully is skipped (P1)', () => {
  it('skips a sale whose cashier cannot be proven (route hold)', () => {
    expect(build({ route: HOLD })).toEqual({ kind: 'skip', reason: 'cashier_unresolved' });
  });

  it('skips a sale with an unreadable line snapshot', () => {
    expect(build({ sale: saleRow({ lines_json: 'not json' }) })).toEqual({
      kind: 'skip',
      reason: 'not_sendable',
    });
  });

  it('skips a sale whose tenders cannot be sent past the tender cutoff', () => {
    expect(
      build({
        sale: saleRow({ tender_lines_summary_json: 'not json' }),
        tendersSince: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ kind: 'skip', reason: 'not_sendable' });
  });

  it('skips a sale with a corrupt amount the wire transform refuses', () => {
    expect(build({ sale: saleRow({ subtotal_minor: 1.5 }) })).toEqual({
      kind: 'skip',
      reason: 'not_sendable',
    });
  });
});
