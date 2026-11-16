/**
 * RT-1423 — the pure count emission rules: which lines are sent (non-zero variance, no refusal, mapped),
 * the ABSOLUTE target, chunks of at most 100 in a stable order, the provenance key, the frozen body and
 * its hash, and the session lifecycle from its chunks.
 */
import {
  COUNT_CHUNK_MAX,
  canonicalJson,
  chunk,
  countBody,
  effectTargetFor,
  payloadHash,
  planEmission,
  provenanceKey,
  sessionOutcome,
  type EmissionCandidate,
} from '../../../src/inventory/count-sessions/count-emission';

const SESSION = '00000000-0000-7000-8000-00000000c0e1';
const STORE = '00000000-0000-7000-8000-00000000570e';
const pid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const cand = (n: number, over: Partial<EmissionCandidate> = {}): EmissionCandidate => ({
  productId: pid(n),
  varianceQuantity: '-3.0000',
  countedQuantity: '7.0000',
  stockingUnit: 'Box',
  refusalCode: null,
  erpnextItemRef: `ITEM-${n}`,
  correctionEffectIds: [`e-${n}`],
  ...over,
});

describe('planEmission', () => {
  it('sends only non-zero, unrefused, mapped lines and says why the others are skipped', () => {
    const plan = planEmission(
      [
        cand(1),
        cand(2, { varianceQuantity: '0.0000' }),
        cand(3, { refusalCode: 'count_line_unmapped' }),
        cand(4, { erpnextItemRef: null }),
        cand(5, { varianceQuantity: '2.5000', countedQuantity: '12.5000' }),
      ],
      'Stores - RT',
    );
    expect(plan.chunks.flat().map((l) => l.productId)).toEqual([pid(1), pid(5)]);
    expect(plan.skipped).toEqual([
      { productId: pid(2), reason: 'zero_variance' },
      { productId: pid(3), reason: 'refused' },
      { productId: pid(4), reason: 'unmapped' },
    ]);
  });

  it('sends the ABSOLUTE counted target, never the Retail variance', () => {
    const [line] = planEmission([cand(1, { varianceQuantity: '-3.0000', countedQuantity: '7.0000' })], 'W').chunks[0]!;
    expect(line!.countedQuantity).toBe('7.0000');
    expect(JSON.stringify(line)).not.toContain('-3');
  });

  it('counting down to zero is a line (the target is 0), counting equal is not', () => {
    const plan = planEmission(
      [cand(1, { varianceQuantity: '-4.0000', countedQuantity: '0.0000' }), cand(2, { varianceQuantity: '0.0000' })],
      'W',
    );
    expect(plan.chunks.flat().map((l) => [l.productId, l.countedQuantity])).toEqual([[pid(1), '0.0000']]);
  });

  it('cuts chunks of at most 100 in product order, whatever the input order', () => {
    const many = Array.from({ length: 205 }, (_, i) => cand(i + 1));
    const plan = planEmission([...many].reverse(), 'W');
    expect(plan.chunks.map((c) => c.length)).toEqual([100, 100, 5]);
    expect(plan.chunks.flat().map((l) => l.productId)).toEqual(many.map((c) => c.productId));
    expect(planEmission(many, 'W').chunks).toEqual(plan.chunks);
  });

  it('exactly 100 lines is one chunk, 101 is two, none is no chunk', () => {
    expect(planEmission(Array.from({ length: 100 }, (_, i) => cand(i + 1)), 'W').chunks).toHaveLength(1);
    expect(planEmission(Array.from({ length: 101 }, (_, i) => cand(i + 1)), 'W').chunks).toHaveLength(2);
    expect(planEmission([cand(1, { varianceQuantity: '0.0000' })], 'W').chunks).toEqual([]);
  });

  it('refuses a chunk size outside 1..100', () => {
    for (const bad of [0, 101, 1.5]) expect(() => planEmission([cand(1)], 'W', bad)).toThrow(RangeError);
  });

  it('keeps the correction effects of each line for the effect-to-intent link', () => {
    const [line] = planEmission([cand(1, { correctionEffectIds: ['a', 'b'] })], 'W').chunks[0]!;
    expect(line!.correctionEffectIds).toEqual(['a', 'b']);
  });
});

describe('provenance key and frozen body', () => {
  it('has no chunk suffix for a one-chunk count and a 1-based suffix above one', () => {
    expect(provenanceKey(SESSION, 1, 1)).toBe(`count:${SESSION}`);
    expect(provenanceKey(SESSION, 2, 3)).toBe(`count:${SESSION}:2`);
    expect(() => provenanceKey(SESSION, 0, 2)).toThrow(RangeError);
    expect(() => provenanceKey(SESSION, 3, 2)).toThrow(RangeError);
  });

  it('builds the strict CountPosting body with the frozen stamp and sequential lineSeq', () => {
    const lines = planEmission([cand(1), cand(2)], 'Stores - RT').chunks[0]!;
    const body = countBody({
      sessionId: SESSION,
      storeId: STORE,
      chunk: 1,
      chunkTotal: 2,
      postingDatetime: '2026-11-16T09:30:00.000001Z',
      lines,
    });
    expect(body).toMatchObject({
      countSessionRef: SESSION,
      chunk: 1,
      chunkCount: 2,
      storeId: STORE,
      postingDatetime: '2026-11-16T09:30:00.000001Z',
    });
    const out = (body as { lines: Array<Record<string, unknown>> }).lines;
    expect(out.map((l) => l['lineSeq'])).toEqual([1, 2]);
    expect(out[0]).toEqual({
      lineSeq: 1,
      erpnextItemRef: { doctype: 'Item', name: 'ITEM-1' },
      warehouseRef: { doctype: 'Warehouse', name: 'Stores - RT' },
      countedQuantity: '7.0000',
      unit: 'Box',
    });
    expect(JSON.stringify(body)).not.toMatch(/valuation|rate|variance/i);
  });

  it('refuses an empty or oversized chunk body', () => {
    const base = { sessionId: SESSION, storeId: STORE, chunk: 1, chunkTotal: 1, postingDatetime: 'x' };
    expect(() => countBody({ ...base, lines: [] })).toThrow(RangeError);
    const lines = planEmission(Array.from({ length: COUNT_CHUNK_MAX + 1 }, (_, i) => cand(i + 1)), 'W').chunks.flat();
    expect(() => countBody({ ...base, lines })).toThrow(RangeError);
  });

  it('hashes the canonical body: property order does not matter, content does', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const h = payloadHash({ a: 1, b: 2 });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(payloadHash({ b: 2, a: 1 })).toBe(h);
    expect(payloadHash({ a: 1, b: 3 })).not.toBe(h);
  });

  it('chunk() splits and never mutates', () => {
    const src = [1, 2, 3, 4, 5];
    expect(chunk(src, 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(src).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('sessionOutcome', () => {
  const ok = { status: 'posted', hasRejectedLine: false } as const;
  const noop = { status: 'verified_noop', hasRejectedLine: false } as const;
  const pending = { status: 'pending', hasRejectedLine: false } as const;

  it('is confirmed only when every chunk is posted or a verified no-op with no rejected line', () => {
    expect(sessionOutcome([ok, noop])).toBe('confirmed');
    expect(sessionOutcome([ok, pending])).toBe('posting');
    expect(sessionOutcome([])).toBe('confirmed');
  });

  it('a posted chunk with a rejected line is never fully confirmed', () => {
    expect(sessionOutcome([{ status: 'posted', hasRejectedLine: true }])).toBe('needs_attention');
    expect(sessionOutcome([{ status: 'verified_noop', hasRejectedLine: true }, ok])).toBe('needs_attention');
  });

  it('a dead-lettered or reconciled chunk is needs_attention even while others still post', () => {
    expect(sessionOutcome([{ status: 'permanently_rejected', hasRejectedLine: false }, pending])).toBe('needs_attention');
  });

  it('a line refused at approval keeps the session in needs_attention, even with no chunk', () => {
    expect(sessionOutcome([], true)).toBe('needs_attention');
    expect(sessionOutcome([ok], true)).toBe('needs_attention');
    expect(sessionOutcome([ok, noop], false)).toBe('confirmed');
  });

  it('maps a line result to the effect target: only rejected stays rejected', () => {
    expect(effectTargetFor('adjusted')).toBe('confirmed');
    expect(effectTargetFor('verified_noop')).toBe('confirmed');
    expect(effectTargetFor('rejected')).toBe('rejected');
  });
});
