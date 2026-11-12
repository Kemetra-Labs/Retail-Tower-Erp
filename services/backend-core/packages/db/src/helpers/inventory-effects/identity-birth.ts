/**
 * Tracking Identity birth from ERP evidence (Jira RT-453; RT-50 Gate 7 G7-2,
 * G7-3, owner decision RT-50 comment 11765 Q2: identities are ERP-born only,
 * there is no manual lot registration).
 *
 * Two kinds of ERP evidence birth an identity, each with its edge-map row
 * (`erpnext_tracking_map`) and one `tracking_identity_births` record naming the
 * evidence:
 *   - the Connector tracking master read (`stock-view.yaml` 1.4
 *     `BinEntryTracking`): Batch name, Item, expiry and disabled, recorded
 *     with a 017 stock run's Bin report (`applyTrackingMasterEvidence`, run by
 *     the worker after the report completes);
 *   - an ERP-origin Stock Ledger row carrying a Batch (RT-1288 import), for a
 *     product whose Tracking Profile does not require an expiry (the row
 *     carries none); an expiry-required product's unknown Batch waits for the
 *     tracking master read (`awaiting_identity`).
 *
 * Rules:
 *   - Retail Tower never invents an identity: a birth needs a Batch named by
 *     ERPNext for the Item that maps to the product.
 *   - Idempotent: the edge map is 1:1 and unique per (tenant, kind, ERP name),
 *     so a re-read finds the existing identity and never duplicates it.
 *   - The lot `code` is the ERPNext Batch name exactly as ERPNext reports it
 *     (`lotCodeFromBatchName`; the RT-50 B3 convention: the tenant names each
 *     Batch with the printed lot). The edge map comes from the evidence itself
 *     (identity → that Batch), never from the code (G7-2, 881, 886). A name
 *     that is not a valid code is not born.
 *   - An identity whose code is already taken by an identity of the product
 *     that is mapped to another Batch (or to none) is never re-associated: no
 *     birth, a refusal the caller makes visible.
 *   - A Batch already mapped to an identity of ANOTHER product is refused.
 *   - An expiry change carried by the evidence goes through the governed RT-449
 *     expiry correction, only when that evidence was read after whatever last
 *     set the identity's expiry (an older read never rolls it back) (a correction row, then the identity UPDATE, then one
 *     Safety Revision step `expiry_corrected`), never a silent UPDATE: 0072's
 *     identity guard refuses an expiry change without its correction row.
 *
 * Serial identities are never born here: serial selling stays fail-closed
 * (RT-50 Q11) and no serial evidence is defined.
 *
 * Locking: births of one tenant serialize on a per-tenant advisory
 * transaction lock (`lockIdentityBirth`), taken BEFORE any identity row lock.
 * Order: the stock import report takes the inventory settings key SHARED,
 * then this lock; the worker takes this lock, then the safety lock
 * (`INVENTORY_SAFETY_LOCK_NAMESPACE`, the RT-449 commands' key), then the
 * identity row. No path takes them in another order.
 *
 * Everything runs on the caller's client under its tenant context (RLS).
 */
import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

type Client = Pick<PoolClient, "query">;

/** The advisory-lock namespace of a tenant's identity births. */
export const IDENTITY_BIRTH_LOCK_NAMESPACE = "tracking_identity_birth";
/**
 * The RT-449 safety commands' lock namespace (apps/api `safety-revision.ts`
 * `INVENTORY_SAFETY_LOCK_NAMESPACE`): an ERP-evidence expiry correction is a
 * safety change and serializes with them.
 */
const INVENTORY_SAFETY_LOCK = "inventory_safety";
/** The reason code of an expiry correction carried by ERP evidence. */
export const ERP_EVIDENCE_REASON_CODE = "erp_evidence";

/** The 0045 `tracking_identities_code_shape` rule. */
const MAX_CODE_LENGTH = 128;

/**
 * The lot code of an identity born from an ERPNext Batch: the Batch name
 * exactly as reported, when it is a valid code (1–128 characters, no leading
 * or trailing white space); otherwise null (not born).
 */
export function lotCodeFromBatchName(batchName: string): string | null {
  if (batchName.length === 0 || [...batchName].length > MAX_CODE_LENGTH) return null;
  return batchName === batchName.trim() ? batchName : null;
}

/** Serialize the tenant's identity births (released at commit / rollback). */
export async function lockIdentityBirth(client: Client, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    IDENTITY_BIRTH_LOCK_NAMESPACE,
    tenantId,
  ]);
}

export type BirthRefusal =
  /** The Batch is mapped to an identity of another product. */
  | "batch_of_other_product"
  /** The Batch name is not a valid lot code. */
  | "code_unrepresentable"
  /** The product requires an expiry and the evidence carries none. */
  | "expiry_required"
  /** The product already has an identity with this code, not mapped to this Batch. */
  | "code_taken";

export type BirthOutcome =
  | { readonly kind: "born"; readonly identityId: string }
  | {
      readonly kind: "existing";
      readonly identityId: string;
      readonly expiryDate: string | null;
    }
  | { readonly kind: "refused"; readonly reason: BirthRefusal };

export interface BatchBirthInput {
  readonly tenantId: string;
  readonly productId: string;
  readonly erpnextItemRef: string;
  readonly batchName: string;
  /** `YYYY-MM-DD` from the evidence, or null when it carries none. */
  readonly expiryDate: string | null;
}

/**
 * Find or birth the batch identity of `batchName` for the product. The caller
 * holds `lockIdentityBirth` and records the birth (`recordIdentityBirth`) when
 * the outcome is `born`.
 */
export async function birthBatchIdentity(client: Client, input: BatchBirthInput): Promise<BirthOutcome> {
  const mapped = await client.query<{ id: string; tenant_product_ref: string; expiry_date: string | null }>(
    `SELECT i.id, i.tenant_product_ref, i.expiry_date::text AS expiry_date
       FROM erpnext_tracking_map m
       JOIN tracking_identities i ON i.id = m.tracking_identity_id AND i.tenant_id = m.tenant_id
      WHERE m.kind = 'batch' AND m.erpnext_ref = $1`,
    [input.batchName],
  );
  const existing = mapped.rows[0];
  if (existing !== undefined) {
    if (existing.tenant_product_ref !== input.productId) return { kind: "refused", reason: "batch_of_other_product" };
    return { kind: "existing", identityId: existing.id, expiryDate: existing.expiry_date };
  }
  const code = lotCodeFromBatchName(input.batchName);
  if (code === null) return { kind: "refused", reason: "code_unrepresentable" };
  const product = await client.query<{ expiry_required: boolean }>(
    `SELECT expiry_required FROM tenant_products WHERE id = $1`,
    [input.productId],
  );
  if (product.rows[0]?.expiry_required === true && input.expiryDate === null) {
    return { kind: "refused", reason: "expiry_required" };
  }
  const identityId = randomUUID();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date, origin)
     VALUES ($1, $2, $3, 'batch', $4, $5::date, 'erp_external')
     ON CONFLICT (tenant_id, tenant_product_ref, kind, code) DO NOTHING
     RETURNING id`,
    [identityId, input.tenantId, input.productId, code, input.expiryDate],
  );
  // The code is taken by an identity this Batch does not map to: never re-associated.
  if (inserted.rows.length === 0) return { kind: "refused", reason: "code_taken" };
  await client.query(
    `INSERT INTO erpnext_tracking_map (id, tenant_id, tracking_identity_id, kind, erpnext_ref)
     VALUES ($1, $2, $3, 'batch', $4)`,
    [randomUUID(), input.tenantId, identityId, input.batchName],
  );
  return { kind: "born", identityId };
}

export type BirthEvidence =
  | { readonly source: "tracking_master"; readonly reconciliationRunId: string }
  | { readonly source: "stock_import"; readonly importRowId: string };

/** Record the ERP evidence a born identity came from (one per identity). */
export async function recordIdentityBirth(
  client: Client,
  input: {
    readonly tenantId: string;
    readonly identityId: string;
    readonly productId: string;
    readonly erpnextItemRef: string;
    readonly batchName: string;
    readonly evidence: BirthEvidence;
  },
): Promise<void> {
  const e = input.evidence;
  await client.query(
    `INSERT INTO tracking_identity_births
       (id, tenant_id, tracking_identity_id, tenant_product_ref, source, reconciliation_run_id, import_row_id,
        erpnext_item_ref, erpnext_batch_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      input.tenantId,
      input.identityId,
      input.productId,
      e.source,
      e.source === "tracking_master" ? e.reconciliationRunId : null,
      e.source === "stock_import" ? e.importRowId : null,
      input.erpnextItemRef,
      input.batchName,
    ],
  );
}

// ---------------------------------------------------------------------------
// ERP-evidence expiry correction (the governed RT-449 path)
// ---------------------------------------------------------------------------

interface ErpExpiryCorrectionInput {
  readonly tenantId: string;
  readonly identityId: string;
  /** The evidence's expiry (`YYYY-MM-DD`), or null when the Batch has none. */
  readonly expiryDate: string | null;
  /**
   * The 017 stock run whose tracking master read carried the change. It is the
   * correction's `created_by` (an internal actor reference: the evidence, not
   * a person) and keys the command fingerprint.
   */
  readonly reconciliationRunId: string;
  /** When the Connector read this evidence (the run's Bin report `readAt`). */
  readonly evidenceReadAt: string | null;
}

type ErpExpiryCorrectionOutcome =
  | { readonly kind: "corrected"; readonly safetyRevision: number }
  | { readonly kind: "unchanged" }
  /** Older than what last set the expiry (earlier evidence, or a person's correction since). */
  | { readonly kind: "stale" }
  /** The evidence clears the expiry of an identity whose product requires one. */
  | { readonly kind: "refused_required" };

/**
 * Apply an expiry carried by ERP evidence to an existing identity through the
 * governed correction, with history and one Safety Revision step. The caller
 * holds `lockIdentityBirth`; this takes the safety lock, then the identity row.
 */
export async function correctExpiryFromErpEvidence(
  client: Client,
  input: ErpExpiryCorrectionInput,
): Promise<ErpExpiryCorrectionOutcome> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    INVENTORY_SAFETY_LOCK,
    input.tenantId,
  ]);
  const r = await client.query<{ tenant_product_ref: string; expiry_date: string | null; expiry_required: boolean }>(
    `SELECT i.tenant_product_ref, i.expiry_date::text AS expiry_date, p.expiry_required
       FROM tracking_identities i
       JOIN tenant_products p ON p.id = i.tenant_product_ref
      WHERE i.id = $1
        FOR UPDATE OF i`,
    [input.identityId],
  );
  const identity = r.rows[0];
  if (identity === undefined || identity.expiry_date === input.expiryDate) return { kind: "unchanged" };
  const commandFingerprint = createHash("sha256")
    .update(
      [ERP_EVIDENCE_REASON_CODE, input.reconciliationRunId, input.identityId, input.expiryDate ?? ""].join("\n"),
    )
    .digest("hex");
  // A retried run whose correction is already recorded (the expiry moved on since): nothing to do.
  const done = await client.query(`SELECT 1 FROM tracking_identity_expiry_corrections WHERE command_fingerprint = $1`, [
    commandFingerprint,
  ]);
  if ((done.rowCount ?? 0) > 0) return { kind: "unchanged" };
  if (await isStaleEvidence(client, input)) return { kind: "stale" };
  if (input.expiryDate === null && identity.expiry_required) return { kind: "refused_required" };

  const revision = await client.query<{ revision: string }>(
    `INSERT INTO tenant_inventory_safety_revisions (tenant_id, revision) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET revision = tenant_inventory_safety_revisions.revision + 1
     RETURNING revision::text AS revision`,
    [input.tenantId],
  );
  const safetyRevision = Number(revision.rows[0]!.revision);
  await client.query(
    `INSERT INTO tracking_identity_expiry_corrections
       (tenant_id, tracking_identity_id, tenant_product_ref, old_expiry_date, new_expiry_date,
        reason_code, note, command_fingerprint, created_by)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, NULL, $7, $8)`,
    [
      input.tenantId,
      input.identityId,
      identity.tenant_product_ref,
      identity.expiry_date,
      input.expiryDate,
      ERP_EVIDENCE_REASON_CODE,
      commandFingerprint,
      input.reconciliationRunId,
    ],
  );
  await client.query(`UPDATE tracking_identities SET expiry_date = $2::date WHERE id = $1`, [
    input.identityId,
    input.expiryDate,
  ]);
  await client.query(
    `INSERT INTO inventory_safety_changes
       (tenant_id, revision, kind, tracking_identity_id, tenant_product_ref, created_by)
     VALUES ($1, $2, 'expiry_corrected', $3, $4, $5)`,
    [input.tenantId, safetyRevision, input.identityId, identity.tenant_product_ref, input.reconciliationRunId],
  );
  return { kind: "corrected", safetyRevision };
}

/**
 * True when this evidence is not newer than what last set the identity's
 * expiry: the run it was born from, the run of an earlier ERP-evidence
 * correction, or a person's correction (its `created_at`). Runs of different
 * stores, or a retried run, are not processed in read order, so an older read
 * must never roll the expiry back.
 */
async function isStaleEvidence(client: Client, input: ErpExpiryCorrectionInput): Promise<boolean> {
  const r = await client.query<{ stale: boolean }>(
    `WITH last_set AS (
       SELECT COALESCE((run.summary->'bin_view_report'->>'readAt')::timestamptz, b.born_at) AS t
         FROM tracking_identity_births b
         LEFT JOIN erpnext_reconciliation_run run ON run.id = b.reconciliation_run_id
        WHERE b.tracking_identity_id = $1
       UNION ALL
       SELECT CASE WHEN c.reason_code = $3
                   THEN (SELECT (run.summary->'bin_view_report'->>'readAt')::timestamptz
                           FROM erpnext_reconciliation_run run WHERE run.id = c.created_by)
                   ELSE c.created_at END
         FROM tracking_identity_expiry_corrections c
        WHERE c.tracking_identity_id = $1
     )
     -- Evidence with no readAt cannot be ordered: never applied.
     SELECT ($2::timestamptz IS NULL OR COALESCE($2::timestamptz <= (SELECT max(t) FROM last_set), false)) AS stale`,
    [input.identityId, input.evidenceReadAt, ERP_EVIDENCE_REASON_CODE],
  );
  return r.rows[0]!.stale;
}

// ---------------------------------------------------------------------------
// The tracking master read of one 017 stock run
// ---------------------------------------------------------------------------

/** What `applyTrackingMasterEvidence` did, for the run summary and logs (ids and counts only). */
export interface TrackingMasterSummary {
  readonly born: number;
  readonly existing: number;
  readonly expiryCorrected: number;
  readonly refused: ReadonlyArray<{ readonly erpnextBatchRef: string; readonly reason: BirthRefusal | "expiry_required_cleared" }>;
}

interface MasterBatchRow {
  item: string;
  product: string;
  batch: string;
  expiry: string | null;
}

/**
 * The tracking master rows of run $1's complete Bin report: one per Batch of
 * an entry whose Item maps to exactly one confirmed, active product (the
 * anchor's rule) that is batch-tracked, and whose ERP flags agree that the
 * Item is batch-tracked and not serial (a disagreement is a finding, never a
 * birth: `profile_erp_flag_mismatch`). A Batch reported twice for one Item
 * keeps its first entry. An incomplete report yields nothing.
 */
const MASTER_ROWS_SQL = `
WITH report AS (
  SELECT r.summary->'bin_view_report' AS rep FROM erpnext_reconciliation_run r WHERE r.id = $1
),
entries AS (
  SELECT COALESCE(e.value->'erpnextItemRef'->>'name', e.value->>'erpnextItemRef') AS item,
         e.value->'tracking' AS tracking, e.ordinality AS ord
    FROM report, jsonb_array_elements(COALESCE(report.rep->'entries', '[]'::jsonb)) WITH ORDINALITY AS e(value, ordinality)
   WHERE jsonb_typeof(report.rep) = 'object'
     AND (report.rep->'complete') IS DISTINCT FROM 'false'::jsonb
     AND jsonb_typeof(e.value->'tracking') = 'object'
),
unique_map AS (
  SELECT m.erpnext_item_ref AS item, min(m.tenant_product_id::text)::uuid AS product
    FROM erpnext_item_map m
   WHERE m.state = 'confirmed' AND m.retired_at IS NULL
   GROUP BY m.erpnext_item_ref
  HAVING count(*) = 1
)
SELECT DISTINCT ON (en.item, b.value->'batchRef'->>'name')
       en.item, um.product::text AS product, b.value->'batchRef'->>'name' AS batch,
       NULLIF(b.value->>'expiryDate', '') AS expiry
  FROM entries en
  JOIN unique_map um ON um.item = en.item
  JOIN tenant_products p ON p.id = um.product AND p.tracking_mode = 'batch'
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(en.tracking->'batches', '[]'::jsonb)) WITH ORDINALITY AS b(value, ordinality)
 WHERE (en.tracking->>'hasBatchNo')::boolean IS TRUE
   AND (en.tracking->>'hasSerialNo')::boolean IS NOT TRUE
   AND b.value->'batchRef'->>'name' IS NOT NULL
 ORDER BY en.item, b.value->'batchRef'->>'name', en.ord, b.ordinality`;

/**
 * Birth every identity the run's tracking master read names and is not known
 * yet, and apply the expiry it carries to the ones that are (G7-3; the RT-449
 * governed correction). Idempotent: a re-run of the same run finds every
 * identity existing with the same expiry. Takes `lockIdentityBirth`.
 */
export async function applyTrackingMasterEvidence(
  client: Client,
  input: { readonly tenantId: string; readonly runId: string },
): Promise<TrackingMasterSummary> {
  const rows = (await client.query<MasterBatchRow>(MASTER_ROWS_SQL, [input.runId])).rows;
  if (rows.length === 0) return { born: 0, existing: 0, expiryCorrected: 0, refused: [] };
  const readAt = (
    await client.query<{ read_at: string | null }>(
      `SELECT summary->'bin_view_report'->>'readAt' AS read_at FROM erpnext_reconciliation_run WHERE id = $1`,
      [input.runId],
    )
  ).rows[0]?.read_at ?? null;
  await lockIdentityBirth(client, input.tenantId);
  let born = 0;
  let existing = 0;
  let expiryCorrected = 0;
  const refused: Array<TrackingMasterSummary["refused"][number]> = [];
  // sequential: births share the transaction's one client and each later one reads the earlier ones' rows.
  for (const row of rows) {
    const outcome = await birthBatchIdentity(client, {
      tenantId: input.tenantId,
      productId: row.product,
      erpnextItemRef: row.item,
      batchName: row.batch,
      expiryDate: row.expiry,
    });
    if (outcome.kind === "refused") {
      refused.push({ erpnextBatchRef: row.batch, reason: outcome.reason });
      continue;
    }
    if (outcome.kind === "born") {
      born += 1;
      await recordIdentityBirth(client, {
        tenantId: input.tenantId,
        identityId: outcome.identityId,
        productId: row.product,
        erpnextItemRef: row.item,
        batchName: row.batch,
        evidence: { source: "tracking_master", reconciliationRunId: input.runId },
      });
      continue;
    }
    existing += 1;
    if (outcome.expiryDate === row.expiry) continue;
    const corrected = await correctExpiryFromErpEvidence(client, {
      tenantId: input.tenantId,
      identityId: outcome.identityId,
      expiryDate: row.expiry,
      reconciliationRunId: input.runId,
      evidenceReadAt: readAt,
    });
    if (corrected.kind === "corrected") expiryCorrected += 1;
    else if (corrected.kind === "refused_required") {
      refused.push({ erpnextBatchRef: row.batch, reason: "expiry_required_cleared" });
    }
  }
  return { born, existing, expiryCorrected, refused };
}
