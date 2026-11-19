/**
 * RT-1312 Phase 3(c) — one pass of the quarantine uploader.
 *
 * Inertness (the c16621 ordering constraint: a till stops counting a row once it
 * is uploaded, so nothing may go before Backend-Core advertises the revision
 * that includes the upload and the Console can show the queue):
 *   • no heartbeat reply yet, or a revision below the floor → the pass touches
 *     nothing: no store read, no token read, no request;
 *   • the revision is read live on every pass, so a later reply that drops it
 *     (a 400 clears the ack, an older Backend-Core) stops the uploads again.
 * Then, per stranded sale (dead-lettered, or held after a re-pair), oldest first:
 *   uploaded (200 / 201)     → marked uploaded; never uploaded again
 *   refused (400 / 409 / 413)→ marked refused; never retried automatically
 *   retry (401 / 404 / 429 / 5xx) → stays pending, attempts + 1, next attempt
 *                              after the backoff (or `Retry-After`); the pass
 *                              stops, so a failing server gets one request
 *   unreachable              → the pass stops, the row is untouched
 * A sale with no sendable body is skipped without a request, does not use up the
 * batch, and is PARKED (due again in an hour), so a branch full of them is not
 * rebuilt on every pass. A re-pair during the pass stops it: nothing more is sent
 * under an identity the candidates were not classified for.
 */
import { describe, expect, it } from 'vitest';

import type { SaleRow } from '../../sales/repositories/sales.repository.js';
import type {
  QuarantineReceipt,
  QuarantineUploadBody,
  QuarantineUploadClient,
  QuarantineUploadOutcome,
} from '../quarantine-upload-client.js';
import {
  QUARANTINE_UPLOAD_MIN_REVISION,
  createQuarantineUploader,
  type QuarantineCandidate,
  type QuarantineUploadStore,
  type QuarantineUploaderDeps,
} from '../quarantine-upload-drain.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-current' };
const BACKOFF = { baseMs: 5_000, maxMs: 300_000 };

function saleRow(saleId: string, over: Partial<SaleRow> = {}): SaleRow {
  return {
    sale_id: saleId,
    sale_number: `SN-${saleId}`,
    receipt_number: `R-${saleId}`,
    envelope_handoff_action_id: `handoff-${saleId}`,
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'term-current',
    terminal_label: 'Till 1',
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Operator One',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary_json: '[]',
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
        quantity: 1,
        unit_price_minor: 1500,
        line_subtotal_minor: 1500,
      },
    ]),
    ...over,
  };
}

function dead(saleId: string, attempts = 0): QuarantineCandidate {
  return {
    saleId,
    attempts,
    source: {
      kind: 'dead_letter',
      category: 'permanent',
      tillRecordedAt: '2026-11-19T09:00:00.000Z',
    },
  };
}

function held(saleId: string): QuarantineCandidate {
  return { saleId, attempts: 0, source: { kind: 'held' } };
}

interface Marks {
  uploaded: Array<{ saleId: string; status: number; receipt: QuarantineReceipt | null }>;
  refused: Array<{ saleId: string; status: number }>;
  retried: Array<{ saleId: string; status: number | null; nextAttemptAt: string }>;
  parked: Array<{ saleId: string; nextAttemptAt: string }>;
}

function fakeStore(candidates: QuarantineCandidate[]) {
  const marks: Marks = { uploaded: [], refused: [], retried: [], parked: [] };
  const calls = { listCandidates: 0 };
  const store: QuarantineUploadStore = {
    listCandidates: () => {
      calls.listCandidates += 1;
      return candidates;
    },
    markUploaded: (saleId, _scope, status, receipt) => {
      marks.uploaded.push({ saleId, status, receipt });
    },
    markRefused: (saleId, _scope, status) => {
      marks.refused.push({ saleId, status });
    },
    markRetry: (saleId, _scope, status, nextAttemptAt) => {
      marks.retried.push({ saleId, status, nextAttemptAt });
    },
    markParked: (saleId, _scope, nextAttemptAt) => {
      marks.parked.push({ saleId, nextAttemptAt });
    },
  };
  return { store, marks, calls };
}

function fakeClient(answers: QuarantineUploadOutcome[]) {
  const sent: Array<{ token: string; body: QuarantineUploadBody }> = [];
  const client: QuarantineUploadClient = {
    upload: (token, body) => {
      sent.push({ token, body });
      return Promise.resolve(answers.shift() ?? { kind: 'uploaded', status: 201, receipt: null });
    },
  };
  return { client, sent };
}

function setup(
  candidates: QuarantineCandidate[],
  answers: QuarantineUploadOutcome[] = [],
  over: Partial<QuarantineUploaderDeps> = {},
) {
  const s = fakeStore(candidates);
  const c = fakeClient(answers);
  const reads = { token: 0, revision: 0 };
  const uploader = createQuarantineUploader({
    store: s.store,
    client: c.client,
    scope: () => SCOPE,
    readToken: () => {
      reads.token += 1;
      return Promise.resolve('device-token');
    },
    readRevision: () => {
      reads.revision += 1;
      return QUARANTINE_UPLOAD_MIN_REVISION;
    },
    loadSale: (saleId) => saleRow(saleId),
    routeOf: () => ({ kind: 'envelope' }),
    rolesOf: () => new Map(),
    cutoffs: { tendersSince: null, receiptSince: null },
    now: () => NOW,
    isStopped: () => false,
    backoff: BACKOFF,
    ...over,
  });
  return { ...s, ...c, reads, uploader };
}

describe('quarantine uploader — inert until Backend-Core advertises the revision', () => {
  it('the floor is revision 3: the one after the sale_queue revision', () => {
    expect(QUARANTINE_UPLOAD_MIN_REVISION).toBe(3);
  });

  it.each([null, 1, 2])('revision %s → nothing is read and nothing is sent', async (revision) => {
    const t = setup([dead('sale-1')], [], { readRevision: () => revision });
    expect(await t.uploader.drain()).toEqual({ kind: 'idle' });
    expect(t.calls.listCandidates).toBe(0);
    expect(t.reads.token).toBe(0);
    expect(t.sent).toHaveLength(0);
    expect(t.marks).toEqual({ uploaded: [], refused: [], retried: [], parked: [] });
  });

  it('revision 3 uploads, and 4 does too', async () => {
    for (const revision of [3, 4]) {
      const t = setup([dead('sale-1')], [], { readRevision: () => revision });
      expect((await t.uploader.drain()).kind).toBe('progress');
      expect(t.sent).toHaveLength(1);
    }
  });

  it('reads the revision live on every pass', async () => {
    let revision: number | null = 3;
    const t = setup([dead('sale-1')], [], { readRevision: () => revision });
    expect((await t.uploader.drain()).kind).toBe('progress');
    revision = null; // a 400 cleared the heartbeat ack
    expect((await t.uploader.drain()).kind).toBe('idle');
    expect(t.sent).toHaveLength(1);
  });

  it('does nothing when unpaired, with no device token, or once stopped', async () => {
    for (const over of [
      { scope: () => null },
      { readToken: () => Promise.resolve(null) },
      { isStopped: () => true },
    ] satisfies Array<Partial<QuarantineUploaderDeps>>) {
      const t = setup([dead('sale-1')], [], over);
      expect((await t.uploader.drain()).kind).toBe('idle');
      expect(t.sent).toHaveLength(0);
    }
  });
});

describe('quarantine uploader — the answers', () => {
  it('uploads a dead-lettered and a held sale, oldest first, with the device token', async () => {
    const t = setup([dead('sale-1'), held('sale-2')], [], {
      loadSale: (saleId) => saleRow(saleId, saleId === 'sale-2' ? { terminal_id: 'term-old' } : {}),
    });
    expect(await t.uploader.drain()).toEqual({ kind: 'progress' });
    expect(t.sent.map((s) => s.body.reason.kind)).toEqual(['refused', 'held_previous_pairing']);
    expect(t.sent.map((s) => s.token)).toEqual(['device-token', 'device-token']);
    expect(t.sent[1]?.body.previousTerminalId).toBe('term-old');
    expect(t.marks.uploaded.map((m) => m.saleId)).toEqual(['sale-1', 'sale-2']);
  });

  it('marks a 200 / 201 uploaded with its receipt and goes on', async () => {
    const receipt = { quarantineRef: 'ref-1', state: 'open' };
    const t = setup(
      [dead('sale-1'), dead('sale-2')],
      [
        { kind: 'uploaded', status: 201, receipt },
        { kind: 'uploaded', status: 200, receipt: null },
      ],
    );
    expect(await t.uploader.drain()).toEqual({ kind: 'progress' });
    expect(t.marks.uploaded).toEqual([
      { saleId: 'sale-1', status: 201, receipt },
      { saleId: 'sale-2', status: 200, receipt: null },
    ]);
  });

  it('marks a final refusal refused and goes on to the next sale', async () => {
    const t = setup([dead('sale-1'), dead('sale-2')], [{ kind: 'refused', status: 409 }]);
    expect(await t.uploader.drain()).toEqual({ kind: 'progress' });
    expect(t.marks.refused).toEqual([{ saleId: 'sale-1', status: 409 }]);
    expect(t.marks.uploaded.map((m) => m.saleId)).toEqual(['sale-2']);
  });

  it('a retryable answer charges the row with the backoff and stops the pass', async () => {
    const t = setup([dead('sale-1', 2), dead('sale-2')], [{ kind: 'retry', status: 503 }]);
    expect(await t.uploader.drain()).toEqual({ kind: 'retry' });
    // attempt 3 → 5 s doubling twice = 20 s
    expect(t.marks.retried).toEqual([
      {
        saleId: 'sale-1',
        status: 503,
        nextAttemptAt: new Date(NOW.getTime() + 20_000).toISOString(),
      },
    ]);
    expect(t.sent).toHaveLength(1);
  });

  it('honours Retry-After when it is longer than the backoff', async () => {
    const t = setup([dead('sale-1')], [{ kind: 'retry', status: 429, retryAfterMs: 120_000 }]);
    await t.uploader.drain();
    expect(t.marks.retried[0]?.nextAttemptAt).toBe(new Date(NOW.getTime() + 120_000).toISOString());
  });

  it('an unreachable server stops the pass and leaves the row untouched', async () => {
    const t = setup([dead('sale-1'), dead('sale-2')], [{ kind: 'unreachable' }]);
    expect(await t.uploader.drain()).toEqual({ kind: 'undelivered' });
    expect(t.marks).toEqual({ uploaded: [], refused: [], retried: [], parked: [] });
    expect(t.sent).toHaveLength(1);
  });

  it('writes nothing once stopped while a request was in flight', async () => {
    let stopped = false;
    const inner = fakeClient([]);
    const latching: QuarantineUploadClient = {
      upload: async (token, body) => {
        const answer = await inner.client.upload(token, body);
        stopped = true;
        return answer;
      },
    };
    const t = setup([dead('sale-1')], [], { isStopped: () => stopped, client: latching });
    await t.uploader.drain();
    expect(inner.sent).toHaveLength(1);
    expect(t.marks.uploaded).toEqual([]);
  });
});

describe('quarantine uploader — a re-pair is never uploaded across', () => {
  it('sends nothing when the pairing changes while the token is read', async () => {
    let terminalId = 'term-old';
    const t = setup([held('s1')], [], {
      scope: () => ({ ...SCOPE, terminalId }),
      readToken: () => {
        terminalId = 'term-new'; // a re-pair completes while the token is read
        return Promise.resolve('device-token');
      },
    });
    expect(await t.uploader.drain()).toEqual({ kind: 'idle' });
    expect(t.calls.listCandidates).toBe(0);
    expect(t.sent).toHaveLength(0);
  });

  it('stops the pass when the pairing changes between two uploads', async () => {
    let terminalId = 'term-current';
    const t = setup([dead('a'), dead('b')], [], {
      scope: () => ({ ...SCOPE, terminalId }),
    });
    const send = t.client.upload.bind(t.client);
    t.client.upload = async (token, body) => {
      const answer = await send(token, body);
      terminalId = 'term-new'; // re-paired after the first upload
      return answer;
    };
    expect(await t.uploader.drain()).toEqual({ kind: 'progress' });
    expect(t.sent).toHaveLength(1);
    expect(t.marks.uploaded.map((m) => m.saleId)).toEqual(['a']);
  });
});

describe('quarantine uploader — a sale with no sendable body', () => {
  it('is skipped without a request, parked for an hour, and does not use up the batch', async () => {
    const skipped: Array<[string, string]> = [];
    const t = setup([dead('bad-1'), dead('bad-2'), dead('good-1'), dead('good-2')], [], {
      batchLimit: 2,
      loadSale: (saleId) => saleRow(saleId, saleId.startsWith('bad') ? { lines_json: 'x' } : {}),
      onSkipped: (saleId, reason) => skipped.push([saleId, reason]),
    });
    expect(await t.uploader.drain()).toEqual({ kind: 'progress' });
    expect(t.marks.uploaded.map((m) => m.saleId)).toEqual(['good-1', 'good-2']);
    expect(skipped).toEqual([
      ['bad-1', 'not_sendable'],
      ['bad-2', 'not_sendable'],
    ]);
    const hourLater = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    expect(t.marks.parked).toEqual([
      { saleId: 'bad-1', nextAttemptAt: hourLater },
      { saleId: 'bad-2', nextAttemptAt: hourLater },
    ]);
    expect(t.marks.retried).toEqual([]);
  });

  it('reports a skipped sale once, not on every pass', async () => {
    const skipped: string[] = [];
    const t = setup([dead('bad-1')], [], {
      loadSale: (saleId) => saleRow(saleId, { lines_json: 'x' }),
      onSkipped: (saleId) => skipped.push(saleId),
    });
    await t.uploader.drain();
    await t.uploader.drain();
    expect(skipped).toEqual(['bad-1']);
  });

  it('skips and parks a sale that is no longer readable', async () => {
    const t = setup([dead('gone')], [], { loadSale: () => null });
    expect(await t.uploader.drain()).toEqual({ kind: 'idle' });
    expect(t.sent).toHaveLength(0);
    expect(t.marks.parked.map((p) => p.saleId)).toEqual(['gone']);
  });

  it('lets go of what is memoized for a parked sale', async () => {
    const settled: string[] = [];
    const t = setup([dead('bad-1')], [], {
      loadSale: (saleId) => saleRow(saleId, { lines_json: 'x' }),
      onSettled: (saleId) => settled.push(saleId),
    });
    await t.uploader.drain();
    expect(settled).toEqual(['bad-1']);
  });

  it('stops after the batch limit of requests', async () => {
    const t = setup([dead('a'), dead('b'), dead('c')], [], { batchLimit: 2 });
    expect(await t.uploader.drain()).toEqual({ kind: 'progress' });
    expect(t.sent).toHaveLength(2);
  });

  it('is idle when nothing is stranded', async () => {
    const t = setup([]);
    expect(await t.uploader.drain()).toEqual({ kind: 'idle' });
  });
});
