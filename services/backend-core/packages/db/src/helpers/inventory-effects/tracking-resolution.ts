/**
 * Tracking Resolution — the in-transaction commit of a resolved sale (Jira
 * RT-451 slice S5; RT-50 DC-2; RT-451 comment 16556 Q1).
 *
 * Runs on the bind's tenant-context client, AFTER the bind recorded its
 * resolution and line bindings (`tracking_resolution_lines`) and set the sale
 * `tracked`, in the same transaction, so all of it commits or rolls back
 * together. From that point the S4 writers see each row-4 line at its bound
 * identity (`sale-effects.ts`), and this commits what a `tracking_unresolved`
 * sale was denied before the bind:
 *
 *   1. The sale's effects and its `sale_post` intent, together (DC-2) — only
 *      when the worker already processed the sale. An unprocessed sale is
 *      still in the sale-processing queue; with its status now `tracked`, the
 *      worker writes both in its own transaction, as for any sale (its
 *      `processed_at IS NULL` guard means it never runs twice).
 *   2. The void and return restores suppressed before the bind (c16556 Q1.2),
 *      through the same writers, in event order. A void now compensates the
 *      exact sale effect (G4-6), or, for a sale the worker has not processed,
 *      restores per line at the bound identity as a void of any unprocessed
 *      sale does. A return lands at the bound identity in `return_inspection`,
 *      or `recall_hold` for an identity ever recalled (Q9; c16538). Credit
 *      reversals create `sale_voids` / `sale_returns` rows, so they are
 *      covered. Every effect keeps its DC-1 key: a restore already written is
 *      not written twice.
 *   3. The reversal intents emitted before the bind (c16556 Q1.1). The posting
 *      consumer defers a reversal until its sale's `sale_post` row exists
 *      (RT-173), so each one is retrying or dead-lettered. This re-emits, ONCE
 *      per `source_ref_id`, the same `erpnext.posting.requested` payload the
 *      void / refund / return / credit reversal emitted, for every reversal of
 *      the sale with no posting row yet. It never creates a reversal for an
 *      event that did not emit one: the set is read from the sale's own
 *      emitted intents. Downstream the O-3 unique `(tenant_id,
 *      source_ref_id)` keeps the consumer insert idempotent, so an original
 *      that is still retrying and its re-emission make one posting row: each
 *      reversal is posted exactly once. A dead-lettered original stays as the
 *      record of the failed attempts (RT-207).
 *
 * The outbox read is bounded by the sale's creation (an intent of the sale
 * cannot be older), on `outbox_events_tenant_occurred_at_idx`. Pre-bind
 * intents are never `delivered` (the consumer cannot deliver a reversal
 * without its `sale_post` row), so retention cannot have removed them.
 */
import type { PoolClient } from "pg";

import { emit, OUTBOX_EVENT_TYPES } from "../../outbox";
import {
  writeReturnEffects,
  writeSaleLineEffects,
  writeVoidEffects,
  type SaleEffectsOutcome,
} from "./sale-effects";

export interface ResolvedSaleInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleId: string;
  /** The tenant's return landing status (RT-435), read under the settings lock. */
  readonly resolveLandingStatus: (client: PoolClient) => Promise<string>;
}

export interface ResolvedSaleOutcome {
  /** The worker had processed the sale, so the bind wrote its effects and `sale_post`. */
  readonly salePostEmitted: boolean;
  /** Every effect writer's outcome, in write order (sale, voids, returns). */
  readonly effects: readonly SaleEffectsOutcome[];
  /** The `source_ref_id` of each reversal intent re-emitted, in id order. */
  readonly reEmittedReversals: readonly string[];
}

/** Commit what the bind owes a resolved sale. See the module comment. */
export async function commitResolvedSale(client: PoolClient, input: ResolvedSaleInput): Promise<ResolvedSaleOutcome> {
  const scope = { tenantId: input.tenantId, storeId: input.storeId, saleId: input.saleId };
  const sale = await client.query<{ processed: boolean; created_at: Date }>(
    `SELECT processed_at IS NOT NULL AS processed, created_at FROM sales WHERE id = $1 AND store_id = $2`,
    [input.saleId, input.storeId],
  );
  const row = sale.rows[0];
  if (!row) throw new Error("commitResolvedSale: the sale is not in scope");

  const effects: SaleEffectsOutcome[] = [];
  if (row.processed) {
    effects.push(await writeSaleLineEffects(client, scope));
    await emitPosting(client, input, "sale_post", input.saleId);
  }

  const voids = await client.query<{ id: string }>(
    `SELECT id FROM sale_voids WHERE sale_id = $1 ORDER BY voided_at, id`,
    [input.saleId],
  );
  // sequential: every writer runs on this one transaction client.
  for (const v of voids.rows) effects.push(await writeVoidEffects(client, { ...scope, voidId: v.id }));
  const returns = await client.query<{ id: string }>(
    `SELECT id FROM sale_returns WHERE sale_id = $1 ORDER BY returned_at, id`,
    [input.saleId],
  );
  for (const r of returns.rows) {
    effects.push(
      await writeReturnEffects(client, { ...scope, returnId: r.id, resolveLandingStatus: input.resolveLandingStatus }),
    );
  }

  const pending = await client.query<{ source_ref_id: string }>(
    `SELECT DISTINCT o.payload->>'source_ref_id' AS source_ref_id
       FROM outbox_events o
      WHERE o.tenant_id = $1
        AND o.occurred_at >= $3::timestamptz - interval '1 day'
        AND o.event_type = $4
        AND o.payload->>'kind' = 'reversal'
        AND o.payload->>'sale_id' = $2::text
        AND NOT EXISTS (SELECT 1 FROM erpnext_posting_status p
                         WHERE p.tenant_id = $1 AND p.source_ref_id::text = o.payload->>'source_ref_id')
      ORDER BY 1`,
    [input.tenantId, input.saleId, row.created_at, OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED],
  );
  const reEmittedReversals = pending.rows.map((r) => r.source_ref_id);
  for (const sourceRefId of reEmittedReversals) await emitPosting(client, input, "reversal", sourceRefId);

  return { salePostEmitted: row.processed, effects, reEmittedReversals };
}

/** The `erpnext.posting.requested` intent, with the payload every producer emits (IDs only). */
async function emitPosting(
  client: PoolClient,
  input: ResolvedSaleInput,
  kind: "sale_post" | "reversal",
  sourceRefId: string,
): Promise<void> {
  await emit(client, {
    eventType: OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED,
    tenantId: input.tenantId,
    storeId: input.storeId,
    payload: { sale_id: input.saleId, store_id: input.storeId, kind, source_ref_id: sourceRefId },
    correlationId: null,
  });
}
