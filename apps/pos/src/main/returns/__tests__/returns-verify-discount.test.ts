/**
 * RT-858 (RT-699 I4, doc 28 §6 "POS returns lookup") — a return of a
 * discounted sale verifies against the net.
 *
 * The capture sends a discounted line at its net `lineAmount` (RT-740 C-A) and
 * Backend-Core stores and serves only that net. The return lookup key
 * (`returns-verify.ts` `snapshotKeys`) therefore uses the frozen net
 * (`line_subtotal_minor − discount.amount_minor`); with the old gross key every
 * discounted sale would fail `isExpectedSale`. A full return quotes the net.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { buildCapturePayload } from '../../sales-sync/capture-payload.js';
import { toWireBody } from '../../sales-sync/create-sale-sync-client.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { isExpectedSale } from '../returns-verify.js';
import { quoteReturn } from '../returns-quote.js';
import { readSaleBody, type WireSale } from '../returns-wire.js';
import type { ContractSaleLine } from './__contract__/sales-returns.contract.js';
import { SALE_REF, saleBody } from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

function discount(over: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'percent',
    value: 10,
    amount_minor: 250,
    placeholder_id: 'dp-1',
    reason_code: 'promotion',
    authority_source: 'manager_session',
    approver_role: 'manager',
    approver_operator_id: 'mgr-1',
    ...over,
  };
}

/** Three lines: 10% off 2 × 12.50, a free line, and an undiscounted one. */
const LINES = [
  {
    line_id: 'l-1',
    item_ref: 'p-1',
    display_name: 'Zinc',
    quantity: 2,
    unit_price_minor: 1250,
    line_subtotal_minor: 2500,
    discount: discount({}),
  },
  {
    line_id: 'l-2',
    item_ref: 'p-2',
    display_name: 'Aspirin',
    quantity: 1,
    unit_price_minor: 500,
    line_subtotal_minor: 500,
    discount: discount({ value: 100, amount_minor: 500, reason_code: 'near_expiry_or_damaged' }),
  },
  {
    line_id: 'l-3',
    item_ref: 'p-3',
    display_name: 'Vitamin C',
    quantity: 3,
    unit_price_minor: 1999,
    line_subtotal_minor: 5997,
  },
];
const NET_TOTAL = 2250 + 0 + 5997;

/** Postgres `numeric(19,scale)::text` of an exact decimal string. */
function pgNumericText(value: string, scale: number): string {
  const [int = '0', frac = ''] = value.split('.');
  return `${int}.${frac.padEnd(scale, '0')}`;
}

function lineRef(i: number): string {
  return `0190f5a2-7b3c-7d4e-8f90-${String(i).padStart(12, '0')}`;
}

/** The sale as Backend-Core serves it back after capturing this body (net lines). */
function servedSale(linesJson: string): WireSale {
  const db = freshSalesSyncDb();
  try {
    seedSale(db, { sale_id: 'rt-1', lines_json: linesJson, subtotal_minor: NET_TOTAL });
    const row = nn(bindSalesRepository(handleFor(db)).readById('rt-1'));
    const body = toWireBody(buildCapturePayload(row), 'EGP');
    const served: ContractSaleLine[] = body.lines.map((l, i) => ({
      lineRef: lineRef(i),
      lineName: l.lineName,
      unitPrice: pgNumericText(l.unitPrice, 4),
      currencyCode: l.currencyCode,
      quantity: pgNumericText(l.quantity, 6),
      lineAmount: pgNumericText(l.lineAmount, 4),
      taxAmount: null,
      unit: l.unit,
      tenantProductRef: null,
      returnedQuantity: '0',
      returnableQuantity: pgNumericText(l.quantity, 6),
    }));
    return nn(readSaleBody(saleBody({ posTotal: pgNumericText(body.posTotal, 4), lines: served })));
  } finally {
    db.close();
  }
}

const LINES_JSON = JSON.stringify(LINES);
const EXPECTED = { saleRef: SALE_REF, currencyCode: 'EGP', linesJson: LINES_JSON };

describe('RT-858 — return lookup on a discounted sale', () => {
  it('the served net sale verifies against the frozen snapshot', () => {
    expect(isExpectedSale(servedSale(LINES_JSON), EXPECTED)).toBe(true);
  });

  it('a server answer at the gross no longer matches a discounted line', () => {
    const sale = servedSale(LINES_JSON);
    const gross = {
      ...sale,
      lines: sale.lines.map((l, i) => (i === 0 ? { ...l, lineAmount: '25.0000' } : l)),
    };
    expect(isExpectedSale(gross, EXPECTED)).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ['no amount', { kind: 'percent', value: 10 }],
    ['an amount alone', { amount_minor: 250 }],
    ['an amount the kind and value do not give', { kind: 'percent', value: 20, amount_minor: 250 }],
    ['an unknown kind', { kind: 'bogo', value: 10, amount_minor: 250 }],
  ])('a malformed frozen discount (%s) matches nothing (fail closed)', (_name, frozen) => {
    const broken = JSON.stringify([{ ...LINES[0], discount: frozen }, LINES[1], LINES[2]]);
    expect(isExpectedSale(servedSale(LINES_JSON), { ...EXPECTED, linesJson: broken })).toBe(false);
  });

  it('a full return quotes the net, a free line at 0', () => {
    const sale = servedSale(LINES_JSON);
    const result = quoteReturn(sale, [
      { lineRef: lineRef(0), quantity: 2 },
      { lineRef: lineRef(1), quantity: 1 },
    ]);
    expect(result).toMatchObject({
      kind: 'ok',
      quote: {
        totalMinor: 2250,
        lines: [
          { lineRef: lineRef(0), amountMinor: 2250 },
          { lineRef: lineRef(1), amountMinor: 0 },
        ],
      },
    });
  });
});
