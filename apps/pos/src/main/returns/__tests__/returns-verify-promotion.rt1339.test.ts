/**
 * RT-1339 (RT-286 S7) — a return lookup on a sale that was sold under an automatic offer verifies
 * against the NET the capture sent.
 *
 * The capture sends a reward line at `lineAmount` = gross − `promotion.discountAmount` and
 * Backend-Core serves that net. `returns-verify.ts` must key the frozen line the same way, or every
 * sale with a reward line fails `isExpectedSale` (`sale_mismatch`) and not even its unrelated lines
 * can be returned (found in review of the first RT-1339 commit).
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
import { readSaleBody, type WireSale } from '../returns-wire.js';
import type { ContractSaleLine } from './__contract__/sales-returns.contract.js';
import { SALE_REF, saleBody } from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const OFFER = '0a000000-0000-7000-8000-000000000001';

function promotion(discountMinor: number): Record<string, unknown> {
  return {
    offer_id: OFFER,
    offer_version: 3,
    pack_revision: 118,
    offer_name_ar: 'عرض',
    percent_off: 40,
    discount_minor: discountMinor,
  };
}

/** E4 plus an unrelated product: A x1 (rest), A x1 (reward, 60.00 off), and B x2 with no offer. */
const LINES = [
  {
    line_id: 'l-1',
    item_ref: '0b000000-0000-7000-8000-000000000001',
    display_name: 'A',
    quantity: 1,
    unit_price_minor: 15_000,
    line_subtotal_minor: 15_000,
    promotion: promotion(0),
  },
  {
    line_id: 'l-1-r1',
    item_ref: '0b000000-0000-7000-8000-000000000001',
    display_name: 'A',
    quantity: 1,
    unit_price_minor: 15_000,
    line_subtotal_minor: 15_000,
    promotion: promotion(6_000),
  },
  {
    line_id: 'l-2',
    item_ref: '0b000000-0000-7000-8000-000000000002',
    display_name: 'B',
    quantity: 2,
    unit_price_minor: 1_000,
    line_subtotal_minor: 2_000,
  },
];
const NET_TOTAL = 15_000 + 9_000 + 2_000;

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

describe('RT-1339 — return lookup on a sale with a reward line', () => {
  it('the served net sale verifies against the frozen snapshot', () => {
    expect(isExpectedSale(servedSale(LINES_JSON), EXPECTED)).toBe(true);
  });

  it('a server answer at the gross no longer matches a reward line', () => {
    const sale = servedSale(LINES_JSON);
    const gross = {
      ...sale,
      lines: sale.lines.map((l, i) => (i === 1 ? { ...l, lineAmount: '150.0000' } : l)),
    };
    expect(isExpectedSale(gross, EXPECTED)).toBe(false);
  });

  it.each<[string, Record<string, unknown> | string]>([
    ['a discount above the gross', promotion(15_001)],
    ['a negative discount', promotion(-1)],
    ['a fractional discount', promotion(0.5)],
    ['a promotion that is not an object', 'x'],
  ])('a malformed frozen promotion (%s) matches nothing (fail closed)', (_name, frozen) => {
    const broken = JSON.stringify([LINES[0], { ...LINES[1], promotion: frozen }, LINES[2]]);
    expect(isExpectedSale(servedSale(LINES_JSON), { ...EXPECTED, linesJson: broken })).toBe(false);
  });

  it('a promotion beside a manual discount matches nothing (OD-5, fail closed)', () => {
    const both = JSON.stringify([
      LINES[0],
      {
        ...LINES[1],
        discount: { kind: 'percent', value: 10, amount_minor: 1_500 },
      },
      LINES[2],
    ]);
    expect(isExpectedSale(servedSale(LINES_JSON), { ...EXPECTED, linesJson: both })).toBe(false);
  });
});
