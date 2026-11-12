/**
 * RT-453 — tracking-grain reconciliation lines of one 017 stock run (RT-50
 * G7-12, extending RT-428 / M-6; RT-428 comment 11774).
 *
 * For a store with a per-identity anchor (tracked activation taken), a
 * batch-tracked product reconciles at (tenant, bucket, item, tracking
 * identity) instead of (tenant, bucket, item); every other product keeps the
 * RT-428 product grain. Per identity:
 *
 *   expected_erp_book = identity anchor line + its effects since − pending ERP − pending Retail
 *
 * against the run's batch-wise Bin evidence for the identity's ERPNext Batch
 * (`stock-view.yaml` 1.4 `BinEntryBatch.quantity`), classed with the RT-428
 * classifier (match, the pending classes, stale snapshot, divergence, UOM,
 * negative, dp2_only). The Connector omits a Batch whose book quantity is
 * zero (RT-918), so a Batch missing from an entry that carries tracking
 * evidence is a zero, not an absence.
 *
 * The tracking-mismatch class (`tracking_mismatch`, one line per product)
 * names what keeps the product from reconciling at tracking grain:
 *   - `tracking_evidence_missing`: its Bin entry has no `tracking` (an older
 *     Connector: tracking UNKNOWN); its identity lines are not compared;
 *   - `erp_flags_disagree`: the ERP Item flags disagree with the profile;
 *   - `batch_without_identity`: a reported Batch maps to no identity of the
 *     product (not born yet, or another product's);
 *   - `untracked_effects`: effects without an identity since the anchor.
 *
 * Explanatory only: nothing here changes an effect, an identity or ERP stock
 * (no automatic correction). Quantities stay exact strings (§III).
 */
import { readIdentityPositions, readUntrackedTrackedEffects, type IdentityPosition } from "@data-pulse-2/db";
import type { PoolClient } from "pg";

import { classifyPendingAware, type PendingAwareClass } from "./pending-aware-classify";

/** The tracking-mismatch class (0102 CHECK; `reconciliation.yaml` 1.7.0-draft). */
export const TRACKING_MISMATCH_CLASS = "tracking_mismatch";

type TrackingGrainClass = PendingAwareClass | "erpnext_only" | typeof TRACKING_MISMATCH_CLASS;

type TrackingMismatchReason =
  | "tracking_evidence_missing"
  | "erp_flags_disagree"
  | "batch_without_identity"
  | "untracked_effects";

interface TrackingGrainLine {
  readonly mismatchClass: TrackingGrainClass;
  /** The product ref (the contract's `sourceRef` of a stock line). */
  readonly sourceRefId: string;
  readonly detail: Record<string, unknown>;
}

export interface TrackingGrainResult {
  readonly lines: readonly TrackingGrainLine[];
  /** The products reconciled at tracking grain: the caller drops their product-grain line. */
  readonly trackedProducts: ReadonlySet<string>;
}

interface EntryEvidence {
  readonly product: string;
  readonly stockUom: string | null;
  readonly hasEvidence: boolean;
  readonly flagsAgree: boolean;
  /** Batch name → book quantity (exact string). */
  readonly batches: ReadonlyMap<string, string>;
}

interface RunEvidence {
  readonly readAt: string | null;
  /** Batch-tracked products' entries, by product. */
  readonly entries: ReadonlyMap<string, EntryEvidence>;
  /** Batch name → the identity it maps to, with that identity's product. */
  readonly batchIdentity: ReadonlyMap<string, { readonly identityId: string; readonly product: string }>;
}

interface EvidenceDbRow {
  read_at: string | null;
  product: string;
  stock_uom: string | null;
  has_evidence: boolean;
  flags_agree: boolean;
  batches: Array<{ name: string; quantity: string }> | null;
}

/** The run's batch-tracked Bin entries (first entry per product) and their Batches. */
async function readRunEvidence(client: PoolClient, runId: string): Promise<RunEvidence> {
  const r = await client.query<EvidenceDbRow>(
    `WITH rep AS (
       SELECT r.summary->'bin_view_report' AS rep FROM erpnext_reconciliation_run r WHERE r.id = $1
     ),
     entries AS (
       SELECT DISTINCT ON (e.value->>'tenant_product_ref')
              (e.value->>'tenant_product_ref')::uuid AS product, e.value AS entry
         FROM rep, jsonb_array_elements(COALESCE(rep.rep->'entries', '[]'::jsonb)) WITH ORDINALITY AS e(value, ord)
        WHERE e.value->>'tenant_product_ref' IS NOT NULL
        ORDER BY e.value->>'tenant_product_ref', e.ord
     )
     SELECT (SELECT rep->>'readAt' FROM rep) AS read_at,
            en.product::text AS product,
            en.entry->>'stockUom' AS stock_uom,
            COALESCE(jsonb_typeof(en.entry->'tracking') = 'object', false) AS has_evidence,
            COALESCE((en.entry->'tracking'->>'hasBatchNo')::boolean IS TRUE
                     AND (en.entry->'tracking'->>'hasSerialNo')::boolean IS NOT TRUE, false) AS flags_agree,
            (SELECT jsonb_agg(jsonb_build_object('name', b->'batchRef'->>'name', 'quantity', b->>'quantity'))
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(en.entry->'tracking'->'batches') = 'array'
                           THEN en.entry->'tracking'->'batches' ELSE '[]'::jsonb END) AS b) AS batches
       FROM entries en
       JOIN tenant_products p ON p.id = en.product AND p.tracking_mode = 'batch'`,
    [runId],
  );
  const entries = new Map<string, EntryEvidence>();
  const names = new Set<string>();
  let readAt: string | null = null;
  for (const row of r.rows) {
    readAt = row.read_at;
    const batches = new Map<string, string>();
    for (const b of row.batches ?? []) {
      if (!batches.has(b.name)) batches.set(b.name, b.quantity);
      names.add(b.name);
    }
    entries.set(row.product, {
      product: row.product,
      stockUom: row.stock_uom,
      hasEvidence: row.has_evidence,
      flagsAgree: row.flags_agree,
      batches,
    });
  }
  if (readAt === null) {
    const ra = await client.query<{ read_at: string | null }>(
      `SELECT summary->'bin_view_report'->>'readAt' AS read_at FROM erpnext_reconciliation_run WHERE id = $1`,
      [runId],
    );
    readAt = ra.rows[0]?.read_at ?? null;
  }
  const batchIdentity = new Map<string, { identityId: string; product: string }>();
  if (names.size > 0) {
    const m = await client.query<{ name: string; identity: string; product: string }>(
      `SELECT m.erpnext_ref AS name, i.id::text AS identity, i.tenant_product_ref::text AS product
         FROM erpnext_tracking_map m
         JOIN tracking_identities i ON i.id = m.tracking_identity_id AND i.tenant_id = m.tenant_id
        WHERE m.kind = 'batch' AND m.erpnext_ref = ANY($1::text[])`,
      [[...names]],
    );
    for (const row of m.rows) batchIdentity.set(row.name, { identityId: row.identity, product: row.product });
  }
  return { readAt, entries, batchIdentity };
}

function isStale(readAt: string | null, latestConfirmedAt: string | null): boolean {
  return readAt !== null && latestConfirmedAt !== null && new Date(readAt) < new Date(latestConfirmedAt);
}

/** The ERP side of one identity: its Batch's quantity, 0 when the evidence omits it, undefined when unknown. */
function binQuantityOf(p: IdentityPosition, entry: EntryEvidence | undefined): string | undefined {
  if (entry === undefined || !entry.hasEvidence) return undefined;
  if (p.erpnextBatchRef === null) return undefined;
  return entry.batches.get(p.erpnextBatchRef) ?? "0";
}

function identityLine(
  p: IdentityPosition,
  entry: EntryEvidence | undefined,
  readAt: string | null,
  mapped: ReadonlySet<string>,
): TrackingGrainLine {
  const binQty = binQuantityOf(p, entry);
  const binUom = entry?.stockUom ?? p.erpStockUom;
  const mismatchClass = classifyPendingAware({
    operationalPosition: p.operationalPosition,
    pendingErp: p.pendingErp,
    pendingRetail: p.pendingRetail,
    expectedErpBook: p.expectedErpBook,
    binQty,
    hasConfirmedMap: mapped.has(p.tenantProductRef),
    uomMismatch: p.operationalUnit !== null && binUom !== null && p.operationalUnit !== binUom,
    snapshotStale: isStale(readAt, p.latestErpConfirmedAt),
  });
  return {
    mismatchClass,
    sourceRefId: p.tenantProductRef,
    // Quantities, units, ERP names and times only — no PII, no money.
    detail: {
      grain: "tracking_identity",
      tracking_identity_id: p.trackingIdentityId,
      erpnext_batch_ref: p.erpnextBatchRef,
      dp2_on_hand: p.operationalPosition,
      erpnext_bin: binQty ?? null,
      expected_erp_book: p.expectedErpBook,
      pending_erp: p.pendingErp,
      pending_retail: p.pendingRetail,
      identity_anchor_generation: p.identityAnchorGeneration,
      snapshot_read_at: readAt,
      latest_erp_confirmed_at: p.latestErpConfirmedAt,
      operational_unit: p.operationalUnit,
      erpnext_stock_uom: binUom,
    },
  };
}

type Flag = (product: string, reason: TrackingMismatchReason, extra?: Record<string, unknown>) => void;

/**
 * One batch-tracked entry's Batches: an `erpnext_only` line for a known
 * identity with ERP stock and no position since the anchor, and the flags
 * that keep the product from tracking grain (no evidence, flags that
 * disagree, a Batch with no identity of the product).
 */
function entryLines(
  entry: EntryEvidence,
  evidence: RunEvidence,
  compared: ReadonlySet<string>,
  flag: Flag,
): TrackingGrainLine[] {
  if (!entry.hasEvidence) {
    flag(entry.product, "tracking_evidence_missing");
    return [];
  }
  if (!entry.flagsAgree) flag(entry.product, "erp_flags_disagree");
  const lines: TrackingGrainLine[] = [];
  const orphans: string[] = [];
  for (const [batch, quantity] of entry.batches) {
    const identity = evidence.batchIdentity.get(batch);
    if (identity === undefined || identity.product !== entry.product) {
      orphans.push(batch);
    } else if (!compared.has(identity.identityId)) {
      lines.push({
        mismatchClass: "erpnext_only",
        sourceRefId: entry.product,
        detail: {
          grain: "tracking_identity",
          tracking_identity_id: identity.identityId,
          erpnext_batch_ref: batch,
          dp2_on_hand: null,
          erpnext_bin: quantity,
          snapshot_read_at: evidence.readAt,
        },
      });
    }
  }
  if (orphans.length > 0) flag(entry.product, "batch_without_identity", { erpnext_batch_refs: orphans.sort() });
  return lines;
}

/**
 * The tracking-grain lines of the store's batch-tracked products, for a store
 * with an identity anchor (the caller checks it and otherwise keeps the
 * RT-428 product grain).
 */
export async function trackingGrainLines(
  client: PoolClient,
  input: { readonly runId: string; readonly storeId: string; readonly mapped: ReadonlySet<string> },
): Promise<TrackingGrainResult> {
  const positions = await readIdentityPositions(client, input.storeId);
  const evidence = await readRunEvidence(client, input.runId);
  const untracked = await readUntrackedTrackedEffects(client, input.storeId);
  const reasons = new Map<string, { reasons: Set<TrackingMismatchReason>; detail: Record<string, unknown> }>();
  const flag: Flag = (product, reason, extra = {}) => {
    const cur = reasons.get(product) ?? { reasons: new Set<TrackingMismatchReason>(), detail: {} };
    cur.reasons.add(reason);
    Object.assign(cur.detail, extra);
    reasons.set(product, cur);
  };

  // An identity of a product whose entry has no tracking evidence is not comparable (flagged below).
  const comparable = positions.filter((p) => evidence.entries.get(p.tenantProductRef)?.hasEvidence !== false);
  const lines: TrackingGrainLine[] = comparable.map((p) =>
    identityLine(p, evidence.entries.get(p.tenantProductRef), evidence.readAt, input.mapped),
  );
  const compared = new Set(comparable.map((p) => p.trackingIdentityId));
  for (const entry of evidence.entries.values()) lines.push(...entryLines(entry, evidence, compared, flag));
  for (const u of untracked) {
    flag(u.tenantProductRef, "untracked_effects", { untracked_quantity: u.quantity, untracked_effects: u.effects });
  }
  for (const [product, r] of reasons) {
    lines.push({
      mismatchClass: TRACKING_MISMATCH_CLASS,
      sourceRefId: product,
      detail: { grain: "tracking", reasons: [...r.reasons].sort(), ...r.detail, snapshot_read_at: evidence.readAt },
    });
  }
  const trackedProducts = new Set<string>([
    ...positions.map((p) => p.tenantProductRef),
    ...evidence.entries.keys(),
    ...untracked.map((u) => u.tenantProductRef),
  ]);
  return { lines, trackedProducts };
}
