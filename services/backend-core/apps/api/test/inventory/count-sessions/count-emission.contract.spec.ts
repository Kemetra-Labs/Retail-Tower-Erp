/**
 * RT-1423 — what Backend-Core emits is what posting-feed.yaml 1.15.0-draft accepts: the frozen chunk body built
 * by `countBody`, wrapped as the adopted `PostingWorkItem`, validates; a count item carrying a sale, or a body
 * past 100 lines, does not. The ack bodies of the Connector (verified_noop with lines, posted with a rejected
 * line) parse through the strict Zod DTO and a sale ack is unchanged.
 */
import { resolve } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { OutcomeAckBodySchema } from '../../../src/catalog/erpnext-posting/dto/outcome-ack.dto';
import {
  COUNT_SOURCE_SYSTEM,
  countBody,
  payloadHash,
  planEmission,
  provenanceKey,
  type EmissionCandidate,
} from '../../../src/inventory/count-sessions/count-emission';
import { loadOpenApiContracts } from '../../../src/openapi/loader';

const SESSION = '00000000-0000-7000-8000-00000000c0e1';
const STORE = '00000000-0000-7000-8000-00000000570e';
const STAMP = '2026-11-16T09:30:00.000001Z';

const feed = loadOpenApiContracts({
  dir: resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'contracts', 'openapi', 'erpnext-connector'),
}).find((c) => c.id === 'posting-feed')?.document;

function validator(name: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(feed as object), $id: 'posting-feed' });
  return ajv.compile({ $ref: `posting-feed#/components/schemas/${name}` });
}

const cand = (n: number): EmissionCandidate => ({
  productId: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  varianceQuantity: '-3.0000',
  countedQuantity: '7.0000',
  stockingUnit: 'Nos',
  refusalCode: null,
  erpnextItemRef: `ITEM-${n}`,
  correctionEffectIds: [`e${n}`],
});

function workItem(chunkLines: number, total = 1, chunk = 1): Record<string, unknown> {
  const lines = planEmission(Array.from({ length: chunkLines }, (_, i) => cand(i + 1)), 'Stores - RT', 100).chunks[0] ?? [];
  const body = countBody({ sessionId: SESSION, storeId: STORE, chunk, chunkTotal: total, postingDatetime: STAMP, lines });
  return {
    workItemRef: '00000000-0000-7000-8000-00000000c001',
    kind: 'inventory_count',
    sourceSystem: COUNT_SOURCE_SYSTEM,
    externalId: provenanceKey(SESSION, chunk, total),
    payloadHash: payloadHash(body),
    businessDate: '2026-11-16',
    count: body,
    itemCursor: '17',
  };
}

describe('the emitted count work item against posting-feed.yaml 1.15.0-draft', () => {
  it('validates as the adopted PostingWorkItem, for one line, for 100 lines and for a later chunk', () => {
    const v = validator('PostingWorkItem');
    expect(v(workItem(1))).toBe(true);
    expect(v(workItem(100))).toBe(true);
    expect(v(workItem(5, 3, 2))).toBe(true);
  });

  it('validates as the standalone CountWorkItem too', () => {
    expect(validator('CountWorkItem')(workItem(2))).toBe(true);
  });

  it('is refused when it also carries a sale, or when a frozen line carries a valuation field', () => {
    const v = validator('PostingWorkItem');
    expect(v({ ...workItem(1), sale: {} })).toBe(false);
    const item = workItem(1) as { count: { lines: Array<Record<string, unknown>> } };
    item.count.lines[0]!['valuationRate'] = '10';
    expect(v(item)).toBe(false);
  });
});

describe('the Connector ack bodies through the strict Zod DTO', () => {
  const line = (n: number, result: string, extra: Record<string, unknown> = {}) => ({
    lineSeq: n,
    result,
    verifiedQtyAfter: result === 'rejected' ? null : '7',
    refusal: null,
    ...extra,
  });
  const doc = { doctype: 'Stock Reconciliation', name: 'MAT-RECO-2026-00017' };

  it('accepts posted with a document and per-line evidence, including a rejected line', () => {
    const body = {
      outcome: 'posted',
      documentRef: doc,
      lines: [
        line(1, 'adjusted'),
        line(2, 'rejected', { refusal: { code: 'uom_mismatch', ackCategory: 'validation', message: 'unit' } }),
      ],
    };
    expect(OutcomeAckBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts verified_noop with lines and no document; refuses it without lines, with a document, or with an adjusted line', () => {
    expect(OutcomeAckBodySchema.safeParse({ outcome: 'verified_noop', lines: [line(1, 'verified_noop')] }).success).toBe(true);
    expect(OutcomeAckBodySchema.safeParse({ outcome: 'verified_noop' }).success).toBe(false);
    expect(OutcomeAckBodySchema.safeParse({ outcome: 'verified_noop', documentRef: doc, lines: [line(1, 'verified_noop')] }).success).toBe(false);
    expect(OutcomeAckBodySchema.safeParse({ outcome: 'verified_noop', lines: [line(1, 'adjusted')] }).success).toBe(false);
  });

  it('refuses a rejected line without its refusal, an adjusted line without its quantity, and an empty or oversized list', () => {
    const lines = (l: unknown[]) => OutcomeAckBodySchema.safeParse({ outcome: 'posted', documentRef: doc, lines: l }).success;
    expect(lines([{ lineSeq: 1, result: 'rejected', verifiedQtyAfter: null, refusal: null }])).toBe(false);
    expect(lines([{ lineSeq: 1, result: 'adjusted', verifiedQtyAfter: null, refusal: null }])).toBe(false);
    expect(lines([])).toBe(false);
    expect(lines(Array.from({ length: 101 }, (_, i) => line(i + 1, 'adjusted')))).toBe(false);
  });

  it('keeps every sale ack exactly as before', () => {
    expect(OutcomeAckBodySchema.safeParse({ outcome: 'posted', documentRef: { doctype: 'Sales Invoice', name: 'X' } }).success).toBe(true);
    expect(OutcomeAckBodySchema.safeParse({ outcome: 'failed_transient' }).success).toBe(true);
    expect(OutcomeAckBodySchema.safeParse({ outcome: 'posted' }).success).toBe(false);
  });
});
