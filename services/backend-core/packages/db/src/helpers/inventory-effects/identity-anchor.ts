/**
 * The per-identity Inventory Anchor at tracked activation, and the
 * identity-grain operational positions it bases (Jira RT-453; RT-50 G7-12,
 * RT-289 DC-8, owner decision RT-50 comment 11765 Q13).
 *
 * At tracked activation the Inventory Anchor is taken per identity from
 * ERP-confirmed batch-wise state per bucket (V1: one bucket per store, Gate 4
 * Q2). Like the RT-427 product anchor it is metadata, never a movement (779):
 * the identity's effects recorded after its watermark count on top of it.
 *
 * `anchorTrackedIdentities` (operator CLI `inventory-effects anchor-identities`),
 * all or nothing, on the caller's tenant-context client:
 *   1. takes the tenant settings key EXCLUSIVE, as sale-effects activation
 *      does, so every in-flight sale / void / return / import writer (SHARED)
 *      finishes first;
 *   2. refuses unless sale effects are active (the store's product anchor
 *      exists, RT-427) and every live store passes the RT-427 snapshot
 *      preconditions (`storePreconditionRefusal`: mapped, a complete snapshot
 *      of that warehouse read after the last posted ERP document, nothing in
 *      flight);
 *   3. refuses unless, in each store's snapshot, every Bin entry of a
 *      batch-tracked product carries the tracking evidence
 *      (`tracking_evidence_missing`: an older Connector, tracking UNKNOWN),
 *      its ERP flags agree with the profile (`tracking_flags_disagree`), and
 *      every Batch it reports maps to an identity of that product
 *      (`identities_unborn`: birth runs first, from the 017 run's tracking
 *      master read);
 *   4. writes, per store, the next generation: one line per reported Batch at
 *      its identity, the batch-wise book quantity exactly as reported, with
 *      coverage counts (the identity effects it absorbs, the Batches).
 *
 * Nothing is switched on here. The anchor is a Q13 precondition of tracked
 * selling; turning the switch on stays a separate owner act.
 *
 * Identity-grain position (`readIdentityPositions`), per store and identity of
 * the store's latest identity anchor:
 *
 *   operational_position = anchor line + the identity's effects since the anchor
 *   expected_erp_book    = operational_position − pending ERP − pending Retail
 *
 * with the RT-428 pending terms. "Since the anchor" (`SINCE_IDENTITY_ANCHOR`):
 *   - an ERP-origin effect (RT-1288 import) counts when its Stock Ledger
 *     `creation` (`occurred_at`) is after the anchor snapshot's `readAt`: the
 *     snapshot's batch quantity already holds every earlier one, whenever it
 *     was imported (an import received after activation but created before
 *     the read must not count twice, and one created after the read but
 *     imported before activation must count);
 *   - every other effect counts as the RT-427 `SINCE_ANCHOR` rule counts it.
 *
 * Read-only except `anchorTrackedIdentities`. Quantities are exact NUMERIC
 * text, never a JS number.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  STORE_FACTS_SQL,
  storePreconditionRefusal,
  type ActivationRefusalCode,
  type StoreFactsRow,
} from "./activation";
import { positionTerms, type PositionTerms } from "./pending-aware";
import { INVENTORY_SETTINGS_LOCK_NAMESPACE } from "./sale-effects";

type Client = Pick<PoolClient, "query">;

export type IdentityAnchorRefusalCode =
  | Exclude<ActivationRefusalCode, "already_active">
  | "sale_effects_inactive"
  | "no_product_anchor"
  | "tracking_evidence_missing"
  | "tracking_flags_disagree"
  | "identities_unborn";

export interface IdentityAnchorRefusal {
  readonly code: IdentityAnchorRefusalCode;
  /** The stores that fail the precondition (empty for tenant-wide codes). */
  readonly storeIds: readonly string[];
  /** For a tracking refusal: the ERPNext Item / Batch names at fault (no PII). */
  readonly detail?: ReadonlyArray<{ readonly erpnextItemRef: string; readonly erpnextBatchRef?: string }>;
}

export interface AnchoredIdentityStore {
  readonly storeId: string;
  readonly identityAnchorId: string;
  readonly generation: number;
  readonly sourceRunId: string;
  readonly lines: number;
  readonly absorbedIdentityEffects: number;
}

export type IdentityAnchorOutcome =
  | { readonly kind: "anchored"; readonly activatedAt: string; readonly stores: readonly AnchoredIdentityStore[] }
  | { readonly kind: "refused"; readonly refusal: IdentityAnchorRefusal };

export interface AnchorTrackedIdentitiesInput {
  readonly tenantId: string;
  /** The operator who takes the anchor (a user id; recorded on each anchor). */
  readonly actorId: string;
}

/**
 * Per tracked Bin entry of run $1 (a batch-tracked product, by the anchor's
 * unique-map rule) and per Batch it reports: the evidence state and the
 * identity the Batch maps to. An entry with no Batches yields one row with a
 * null batch.
 */
const TRACKED_ENTRIES_SQL = `
WITH entries AS (
  SELECT DISTINCT ON (item) item, tracking, uom FROM (
    SELECT COALESCE(e.value->'erpnextItemRef'->>'name', e.value->>'erpnextItemRef') AS item,
           e.value->'tracking' AS tracking, e.value->>'stockUom' AS uom, e.ordinality
      FROM erpnext_reconciliation_run r,
           jsonb_array_elements(r.summary->'bin_view_report'->'entries') WITH ORDINALITY AS e(value, ordinality)
     WHERE r.id = $1) x
   ORDER BY item, ordinality
),
unique_map AS (
  SELECT m.erpnext_item_ref AS item, min(m.tenant_product_id::text)::uuid AS product
    FROM erpnext_item_map m
   WHERE m.state = 'confirmed' AND m.retired_at IS NULL
   GROUP BY m.erpnext_item_ref
  HAVING count(*) = 1
)
SELECT e.item, um.product::text AS product, e.uom,
       jsonb_typeof(e.tracking) = 'object' AS has_evidence,
       COALESCE((e.tracking->>'hasBatchNo')::boolean IS TRUE
                AND (e.tracking->>'hasSerialNo')::boolean IS NOT TRUE, false) AS flags_agree,
       b.value->'batchRef'->>'name' AS batch,
       b.value->>'quantity' AS quantity,
       i.id AS identity_id
  FROM entries e
  JOIN unique_map um ON um.item = e.item
  JOIN tenant_products p ON p.id = um.product AND p.tracking_mode = 'batch'
  LEFT JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(e.tracking->'batches') = 'array' THEN e.tracking->'batches' ELSE '[]'::jsonb END)
       AS b(value) ON true
  LEFT JOIN erpnext_tracking_map m ON m.kind = 'batch' AND m.erpnext_ref = b.value->'batchRef'->>'name'
  LEFT JOIN tracking_identities i ON i.id = m.tracking_identity_id AND i.tenant_product_ref = um.product
 ORDER BY e.item, batch`;

interface TrackedEntryRow {
  item: string;
  product: string;
  uom: string | null;
  has_evidence: boolean | null;
  flags_agree: boolean;
  batch: string | null;
  quantity: string | null;
  identity_id: string | null;
}

interface StoreTracked {
  readonly store: StoreFactsRow;
  readonly baseAnchorId: string;
  readonly rows: readonly TrackedEntryRow[];
}

function refused(refusal: IdentityAnchorRefusal): IdentityAnchorOutcome {
  return { kind: "refused", refusal };
}

/** The first tracking refusal over every store, in rule order, or null. */
function trackingRefusal(stores: readonly StoreTracked[]): IdentityAnchorRefusal | null {
  const checks: Array<[IdentityAnchorRefusalCode, (r: TrackedEntryRow) => boolean, boolean]> = [
    ["tracking_evidence_missing", (r) => r.has_evidence !== true, false],
    ["tracking_flags_disagree", (r) => r.has_evidence === true && !r.flags_agree, false],
    ["identities_unborn", (r) => r.flags_agree && r.batch !== null && r.identity_id === null, true],
  ];
  for (const [code, test, withBatch] of checks) {
    const storeIds: string[] = [];
    const detail: Array<{ erpnextItemRef: string; erpnextBatchRef?: string }> = [];
    for (const s of stores) {
      const bad = s.rows.filter(test);
      if (bad.length === 0) continue;
      storeIds.push(s.store.store_id);
      for (const r of bad) {
        detail.push(withBatch && r.batch !== null ? { erpnextItemRef: r.item, erpnextBatchRef: r.batch } : { erpnextItemRef: r.item });
      }
    }
    if (storeIds.length > 0) return { code, storeIds, detail: dedupe(detail) };
  }
  return null;
}

function dedupe<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Take the per-identity anchor of every store (see the file header). */
export async function anchorTrackedIdentities(
  client: Client,
  input: AnchorTrackedIdentitiesInput,
): Promise<IdentityAnchorOutcome> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    INVENTORY_SETTINGS_LOCK_NAMESPACE,
    input.tenantId,
  ]);
  const settings = await client.query<{ active: boolean }>(
    `SELECT sale_effects_activated_at IS NOT NULL AS active FROM tenant_inventory_settings WHERE tenant_id = $1`,
    [input.tenantId],
  );
  if (settings.rows[0]?.active !== true) return refused({ code: "sale_effects_inactive", storeIds: [] });

  const stores = (await client.query<StoreFactsRow>(STORE_FACTS_SQL)).rows;
  const storeRefusal = storePreconditionRefusal(stores);
  if (storeRefusal !== null) return refused({ code: storeRefusal.code as IdentityAnchorRefusalCode, storeIds: storeRefusal.storeIds });

  const tracked: StoreTracked[] = [];
  const unanchored: string[] = [];
  // sequential: the reads run on the anchor transaction's one client.
  for (const store of stores) {
    const base = await client.query<{ id: string }>(
      `SELECT id FROM inventory_anchors WHERE store_id = $1 ORDER BY generation DESC LIMIT 1`,
      [store.store_id],
    );
    if (base.rows[0] === undefined) {
      unanchored.push(store.store_id);
      continue;
    }
    const rows = (await client.query<TrackedEntryRow>(TRACKED_ENTRIES_SQL, [store.run_id])).rows;
    tracked.push({ store, baseAnchorId: base.rows[0].id, rows });
  }
  if (unanchored.length > 0) return refused({ code: "no_product_anchor", storeIds: unanchored });
  const tracking = trackingRefusal(tracked);
  if (tracking !== null) return refused(tracking);

  const now = (await client.query<{ now: Date }>(`SELECT now() AS now`)).rows[0]!.now;
  const anchored: AnchoredIdentityStore[] = [];
  // sequential: anchors are written on the transaction's one client.
  for (const s of tracked) anchored.push(await writeIdentityAnchor(client, input, s, now));
  return { kind: "anchored", activatedAt: now.toISOString(), stores: anchored };
}

async function writeIdentityAnchor(
  client: Client,
  input: AnchorTrackedIdentitiesInput,
  s: StoreTracked,
  activatedAt: Date,
): Promise<AnchoredIdentityStore> {
  const facts = await client.query<{ n: number; last_received_at: Date | null; g: number }>(
    `SELECT (SELECT count(*)::int FROM stock_movements
              WHERE store_id = $1 AND tracking_identity_id IS NOT NULL) AS n,
            (SELECT max(received_at) FROM stock_movements
              WHERE store_id = $1 AND tracking_identity_id IS NOT NULL) AS last_received_at,
            (SELECT COALESCE(max(generation), 0) + 1 FROM inventory_identity_anchors WHERE store_id = $1) AS g`,
    [s.store.store_id],
  );
  const f = facts.rows[0]!;
  // One line per identity: the contract lists a Batch at most once per Item; keep the first if not.
  const seen = new Set<string>();
  const lines = s.rows.filter((r) => {
    if (r.batch === null || r.identity_id === null || r.uom === null || seen.has(r.identity_id)) return false;
    seen.add(r.identity_id);
    return true;
  });
  const identityAnchorId = randomUUID();
  const coverage = {
    preAnchorIdentityEffects: { count: f.n, lastReceivedAt: f.last_received_at?.toISOString() ?? null },
    trackedBinEntries: new Set(s.rows.map((r) => r.item)).size,
    batches: lines.length,
  };
  await client.query(
    `INSERT INTO inventory_identity_anchors
       (id, tenant_id, store_id, generation, base_anchor_id, source_run_id, snapshot_read_at,
        snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      identityAnchorId,
      input.tenantId,
      s.store.store_id,
      f.g,
      s.baseAnchorId,
      s.store.run_id,
      s.store.read_at,
      s.store.recorded_at,
      s.store.snap_ref,
      activatedAt,
      JSON.stringify(coverage),
      input.actorId,
    ],
  );
  if (lines.length > 0) {
    await client.query(
      `INSERT INTO inventory_identity_anchor_lines
         (id, identity_anchor_id, tenant_id, tracking_identity_id, tenant_product_ref, quantity,
          erp_stock_uom, erpnext_batch_ref)
       SELECT gen_random_uuid(), $1, $2, (l->>'identity')::uuid, (l->>'product')::uuid,
              (l->>'quantity')::numeric, l->>'uom', l->>'batch'
         FROM jsonb_array_elements($3::jsonb) AS l`,
      [
        identityAnchorId,
        input.tenantId,
        JSON.stringify(
          lines.map((r) => ({ identity: r.identity_id, product: r.product, quantity: r.quantity, uom: r.uom, batch: r.batch })),
        ),
      ],
    );
  }
  return {
    storeId: s.store.store_id,
    identityAnchorId,
    generation: f.g,
    sourceRunId: s.store.run_id!,
    lines: lines.length,
    absorbedIdentityEffects: f.n,
  };
}

// ---------------------------------------------------------------------------
// Identity-grain positions (G7-12), read-only
// ---------------------------------------------------------------------------

/**
 * The effects an identity anchor does not cover (see the file header).
 * Expects `mv` (stock_movements) and `ia` (the identity anchor).
 */
export const SINCE_IDENTITY_ANCHOR = `(CASE WHEN mv.origin = 'erp_external'
         THEN mv.occurred_at > ia.snapshot_read_at
         ELSE (mv.event_type IN ('sale', 'sale_void', 'sale_return') OR mv.received_at >= ia.activated_at) END)`;

/** CTE body: each store's latest identity anchor of an activated tenant (optionally one store $1). */
const IDENTITY_ANCHOR_CTE = `
ianchor AS (
  SELECT DISTINCT ON (a.store_id) a.id, a.store_id, a.generation, a.activated_at, a.snapshot_read_at
    FROM inventory_identity_anchors a
    JOIN tenant_inventory_settings s
      ON s.tenant_id = a.tenant_id AND s.sale_effects_activated_at IS NOT NULL
   WHERE ($1::uuid IS NULL OR a.store_id = $1::uuid)
   ORDER BY a.store_id, a.generation DESC
)`;

/** One identity's position at a store (the RT-428 terms at identity grain). */
export interface IdentityPosition extends PositionTerms {
  readonly storeId: string;
  readonly trackingIdentityId: string;
  readonly tenantProductRef: string;
  readonly identityAnchorGeneration: number;
  /** The identity's ERPNext Batch (edge map); null when it has none. */
  readonly erpnextBatchRef: string | null;
}

const IDENTITY_POSITIONS_SQL = `
WITH ${IDENTITY_ANCHOR_CTE},
imoves AS (
  SELECT ia.store_id, mv.tracking_identity_id AS identity,
         sum(mv.quantity) AS total,
         COALESCE(sum(mv.quantity) FILTER (WHERE i.state IN ('pending', 'rejected', 'reconciliation_required')), 0)
           AS pending_erp,
         COALESCE(sum(mv.quantity) FILTER (WHERE i.state IS NULL OR i.state = 'not_posted'), 0) AS pending_retail,
         max(i.erp_confirmed_at) FILTER (WHERE i.state = 'confirmed') AS latest_confirmed_at,
         min(mv.stocking_unit) AS unit
    FROM ianchor ia
    JOIN stock_movements mv
      ON mv.store_id = ia.store_id AND mv.tracking_identity_id IS NOT NULL AND ${SINCE_IDENTITY_ANCHOR}
    LEFT JOIN inventory_effect_integration i ON i.effect_id = mv.id
   GROUP BY ia.store_id, mv.tracking_identity_id
),
ikeys AS (
  SELECT ia.store_id, l.tracking_identity_id AS identity FROM ianchor ia
    JOIN inventory_identity_anchor_lines l ON l.identity_anchor_id = ia.id
  UNION SELECT store_id, identity FROM imoves
)
SELECT k.store_id, k.identity::text AS tracking_identity_id, ti.tenant_product_ref::text AS tenant_product_ref,
       ia.generation,
       COALESCE(l.quantity, 0)::text AS anchor_quantity,
       (COALESCE(l.quantity, 0) + COALESCE(m.total, 0))::text AS operational_position,
       COALESCE(m.pending_erp, 0)::text AS pending_erp,
       COALESCE(m.pending_retail, 0)::text AS pending_retail,
       (COALESCE(l.quantity, 0) + COALESCE(m.total, 0)
         - COALESCE(m.pending_erp, 0) - COALESCE(m.pending_retail, 0))::text AS expected_erp_book,
       m.latest_confirmed_at, m.unit, l.erp_stock_uom, map.erpnext_ref AS batch
  FROM ikeys k
  JOIN ianchor ia ON ia.store_id = k.store_id
  JOIN tracking_identities ti ON ti.id = k.identity
  LEFT JOIN inventory_identity_anchor_lines l ON l.identity_anchor_id = ia.id AND l.tracking_identity_id = k.identity
  LEFT JOIN imoves m ON m.store_id = k.store_id AND m.identity = k.identity
  LEFT JOIN erpnext_tracking_map map ON map.tracking_identity_id = k.identity
 ORDER BY k.store_id, ti.tenant_product_ref, k.identity`;

interface IdentityPositionDbRow {
  store_id: string;
  tracking_identity_id: string;
  tenant_product_ref: string;
  generation: number;
  anchor_quantity: string;
  operational_position: string;
  pending_erp: string;
  pending_retail: string;
  expected_erp_book: string;
  latest_confirmed_at: Date | null;
  unit: string | null;
  erp_stock_uom: string | null;
  batch: string | null;
}

/**
 * The identity-grain position of every identity of one store (or of every
 * store with an identity anchor when `storeId` is null). Empty when the store
 * has no identity anchor (tracked activation not taken).
 */
export async function readIdentityPositions(client: Client, storeId: string | null): Promise<IdentityPosition[]> {
  const r = await client.query<IdentityPositionDbRow>(IDENTITY_POSITIONS_SQL, [storeId]);
  return r.rows.map((row) => ({
    storeId: row.store_id,
    trackingIdentityId: row.tracking_identity_id,
    tenantProductRef: row.tenant_product_ref,
    identityAnchorGeneration: row.generation,
    ...positionTerms(row),
    erpnextBatchRef: row.batch,
  }));
}

/** Whether the store has an identity anchor (tracked activation taken) under an activated tenant. */
export async function hasIdentityAnchor(client: Client, storeId: string): Promise<boolean> {
  const r = await client.query<{ anchored: boolean }>(
    `WITH ${IDENTITY_ANCHOR_CTE} SELECT EXISTS (SELECT 1 FROM ianchor) AS anchored`,
    [storeId],
  );
  return r.rows[0]!.anchored;
}

/**
 * Per batch-tracked product of the store: the quantity of its effects WITHOUT
 * an identity since the store's identity anchor (`untracked_effect_on_tracked_product`
 * in the tracking grain: they belong to no identity line). Empty without an
 * identity anchor.
 */
export async function readUntrackedTrackedEffects(
  client: Client,
  storeId: string,
): Promise<Array<{ readonly tenantProductRef: string; readonly quantity: string; readonly effects: number }>> {
  const r = await client.query<{ product: string; quantity: string; effects: number }>(
    `WITH ${IDENTITY_ANCHOR_CTE}
     SELECT mv.tenant_product_ref::text AS product, sum(mv.quantity)::text AS quantity, count(*)::int AS effects
       FROM ianchor ia
       JOIN stock_movements mv
         ON mv.store_id = ia.store_id AND mv.tracking_identity_id IS NULL AND ${SINCE_IDENTITY_ANCHOR}
       JOIN tenant_products p ON p.id = mv.tenant_product_ref AND p.tracking_mode <> 'none'
      GROUP BY mv.tenant_product_ref
      ORDER BY mv.tenant_product_ref`,
    [storeId],
  );
  return r.rows.map((x) => ({ tenantProductRef: x.product, quantity: x.quantity, effects: x.effects }));
}
