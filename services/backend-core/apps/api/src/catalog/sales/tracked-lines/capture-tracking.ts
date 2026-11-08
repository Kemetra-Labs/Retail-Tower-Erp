/**
 * Jira RT-451 slice S3 — capture tracking, the database side (migration 0089;
 * `pos-sales/sales.yaml` 1.21.0-draft `captureSale`; captain decision RT-451
 * comment 16262). Every function runs on the capture's tenant-context
 * transaction client (FORCE RLS):
 *
 *   - {@link readTrackedSellingOn}: tracked selling is on only while the
 *     deployment gate AND the tenant's switch (0086) are on (OD-T1). While it
 *     is off, a line carrying `tracking` is a 400 and no line is classified
 *     (OD-T4).
 *   - {@link lockProductProfiles}: the per-product capture/profile lock
 *     (RT-451 comment 11790). Under READ COMMITTED the first sale line of a
 *     product and a Tracking Profile change could both commit without either
 *     seeing the other. Capture takes the product's key SHARED, the profile
 *     setter EXCLUSIVE, both before they probe, so only one of the two
 *     commits against the state the other would change: a capture that
 *     follows a profile change reads the new profile, and a profile change
 *     that follows a capture sees its line and is `tracking_profile_locked`.
 *   - {@link classifyCaptureLines}: reads the facts of each line and applies
 *     the G7-9 rules (`capture-tracking.rules.ts`).
 *   - {@link writeSaleLineFindings}: appends the row-2 and row-3 findings,
 *     one per (line, kind, cause).
 */
import type { PoolClient } from "pg";

import type { CaptureSaleLineDto } from "../dto/capture-sale-request.dto";
import { isTrackedSellingEnabled } from "./tracked-selling-gate";
import {
  classifyCapturedLine,
  type CapturedIdentityFacts,
  type LineClassification,
  type LineFinding,
} from "./capture-tracking.rules";

/** The advisory-lock namespace of a product's Tracking Profile (capture SHARED, setter EXCLUSIVE). */
export const TRACKING_PROFILE_LOCK_NAMESPACE = "tracking_profile";

const LOCK_KEY_SQL = `hashtextextended($1 || ':' || $2::text || ':' || p::text, 0)`;

/** Tracked selling is on for the tenant: the deployment gate AND the tenant's switch. */
export async function readTrackedSellingOn(client: PoolClient, tenantId: string): Promise<boolean> {
  if (!isTrackedSellingEnabled()) return false;
  const r = await client.query<{ enabled: boolean }>(
    `SELECT COALESCE((SELECT tracked_selling_enabled FROM tenant_inventory_settings WHERE tenant_id = $1), false)
              AS enabled`,
    [tenantId],
  );
  return r.rows[0]?.enabled === true;
}

/**
 * Take the products' profile keys for the rest of the transaction, in id
 * order (so two captures never wait on each other in a cycle; SHARED keys
 * never block each other anyway). `exclusive` is the profile setter's mode.
 */
export async function lockProductProfiles(
  client: PoolClient,
  tenantId: string,
  productIds: ReadonlyArray<string>,
  mode: "shared" | "exclusive",
): Promise<void> {
  const ids = [...new Set(productIds)].sort();
  if (ids.length === 0) return;
  const fn = mode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock";
  await client.query(
    `SELECT ${fn}(${LOCK_KEY_SQL}) FROM unnest($3::uuid[]) WITH ORDINALITY AS u(p, n) ORDER BY n`,
    [TRACKING_PROFILE_LOCK_NAMESPACE, tenantId, ids],
  );
}

/** The sale being classified, as stored by the capture. */
export interface ClassifiedSale {
  readonly tenantId: string;
  readonly storeId: string;
  /** The sale's stored business date (`YYYY-MM-DD`). */
  readonly businessDate: string;
  /** The sale's `occurredAt` (holds are judged at it). */
  readonly occurredAt: string;
  readonly lines: ReadonlyArray<CaptureSaleLineDto>;
}

interface ProductRow {
  readonly id: string;
  readonly tracking_mode: string;
  readonly expiry_required: boolean;
}

interface IdentityRow {
  readonly id: string;
  readonly product_id: string;
  readonly expiry_date: string | null;
  readonly has_edge_map: boolean;
}

interface HoldRow {
  readonly identity_id: string;
  readonly kind: "quality_hold" | "recall_hold";
  readonly id: string;
}

/** Classify every line of a first capture (tracked selling on); one result per line, in order. */
export async function classifyCaptureLines(
  client: PoolClient,
  sale: ClassifiedSale,
): Promise<LineClassification[]> {
  const productIds = uniq(sale.lines.map((l) => l.tenantProductRef));
  const identityIds = uniq(sale.lines.map((l) => l.tracking?.identityId));
  const validationIds = uniq(sale.lines.map((l) => l.tracking?.validationId));

  const products = await byId<ProductRow>(
    client,
    `SELECT id::text AS id, tracking_mode, expiry_required FROM tenant_products WHERE id = ANY($1::uuid[])`,
    [productIds],
  );
  // Batch identities only, as the TLV and the lot lookup: a serial identity
  // is never a lot (Q11), so it reads as unknown.
  const identities = await byId<IdentityRow>(
    client,
    `SELECT i.id::text AS id, i.tenant_product_ref::text AS product_id, i.expiry_date::text AS expiry_date,
            EXISTS (SELECT 1 FROM erpnext_tracking_map m
                     WHERE m.tenant_id = i.tenant_id AND m.tracking_identity_id = i.id) AS has_edge_map
       FROM tracking_identities i
      WHERE i.tenant_id = $1 AND i.id = ANY($2::uuid[]) AND i.kind = 'batch'`,
    [sale.tenantId, identityIds],
  );
  // An accepted TLV record of this tenant and store; its identity is matched per line.
  const validations = await byId<{ id: string; identity_id: string }>(
    client,
    `SELECT id::text AS id, resolved_identity_id::text AS identity_id
       FROM tracked_line_validations
      WHERE tenant_id = $1 AND store_id = $2 AND id = ANY($3::uuid[]) AND outcome = 'accepted'`,
    [sale.tenantId, sale.storeId, validationIds],
  );
  const holds = await activeHoldsAt(client, sale.tenantId, identityIds, sale.occurredAt);

  return sale.lines.map((line) => {
    const product = line.tenantProductRef === undefined ? undefined : products.get(line.tenantProductRef);
    const tracking = line.tracking;
    const identityRow = tracking === undefined ? undefined : identities.get(tracking.identityId);
    const identity: CapturedIdentityFacts | null =
      identityRow === undefined
        ? null
        : { productId: identityRow.product_id, expiryDate: identityRow.expiry_date, hasEdgeMap: identityRow.has_edge_map };
    const validation = tracking?.validationId === undefined ? undefined : validations.get(tracking.validationId);
    const lineHolds = tracking === undefined ? undefined : holds.get(tracking.identityId);
    return classifyCapturedLine({
      productId: line.tenantProductRef ?? null,
      trackingMode: product?.tracking_mode ?? null,
      expiryRequired: product?.expiry_required ?? false,
      hasTracking: tracking !== undefined,
      identity,
      validationSent: tracking?.validationId !== undefined,
      validationMatches: validation !== undefined && validation.identity_id === tracking?.identityId,
      qualityHoldId: lineHolds?.quality_hold ?? null,
      recallHoldId: lineHolds?.recall_hold ?? null,
      businessDate: sale.businessDate,
    });
  });
}

/**
 * The holds of each identity active at `at`: placed at or before it and not
 * released by then. One per kind (the latest placed), since a finding is one
 * per (line, kind, cause).
 */
async function activeHoldsAt(
  client: PoolClient,
  tenantId: string,
  identityIds: ReadonlyArray<string>,
  at: string,
): Promise<Map<string, { quality_hold?: string; recall_hold?: string }>> {
  const out = new Map<string, { quality_hold?: string; recall_hold?: string }>();
  if (identityIds.length === 0) return out;
  const r = await client.query<HoldRow>(
    `SELECT DISTINCT ON (tracking_identity_id, kind)
            tracking_identity_id::text AS identity_id, kind, id::text AS id
       FROM tracking_holds
      WHERE tenant_id = $1 AND tracking_identity_id = ANY($2::uuid[])
        AND placed_at <= $3::timestamptz AND (released_at IS NULL OR released_at > $3::timestamptz)
      ORDER BY tracking_identity_id, kind, placed_at DESC, id DESC`,
    [tenantId, identityIds, at],
  );
  for (const row of r.rows) {
    out.set(row.identity_id, { ...out.get(row.identity_id), [row.kind]: row.id });
  }
  return out;
}

/** One stored line and the findings its classification produced. */
export interface LineFindingsToWrite {
  readonly saleLineId: string;
  readonly productId: string;
  readonly identityId: string;
  readonly findings: ReadonlyArray<LineFinding>;
}

/** Append the row-2 and row-3 findings of a first capture, one per (line, kind, cause). */
export async function writeSaleLineFindings(
  client: PoolClient,
  sale: { readonly tenantId: string; readonly storeId: string; readonly saleId: string; readonly businessDate: string; readonly occurredAt: string },
  lines: ReadonlyArray<LineFindingsToWrite>,
): Promise<void> {
  const rows = lines.flatMap((l) => l.findings.map((f) => ({ ...f, line: l })));
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO sale_line_findings
       (tenant_id, store_id, sale_id, sale_line_id, tenant_product_ref, tracking_identity_id,
        kind, cause, hold_id, business_date, occurred_at)
     SELECT $1, $2, $3, f.line_id, f.product_id, f.identity_id, f.kind, f.cause, f.hold_id, $4::date, $5::timestamptz
       FROM unnest($6::uuid[], $7::uuid[], $8::uuid[], $9::text[], $10::text[], $11::uuid[])
            AS f(line_id, product_id, identity_id, kind, cause, hold_id)
     ON CONFLICT (sale_line_id, kind, cause) DO NOTHING`,
    [
      sale.tenantId,
      sale.storeId,
      sale.saleId,
      sale.businessDate,
      sale.occurredAt,
      rows.map((r) => r.line.saleLineId),
      rows.map((r) => r.line.productId),
      rows.map((r) => r.line.identityId),
      rows.map((r) => r.kind),
      rows.map((r) => r.cause),
      rows.map((r) => r.holdId),
    ],
  );
}

function uniq(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => v !== undefined))];
}

async function byId<T extends { readonly id: string }>(
  client: PoolClient,
  sql: string,
  params: ReadonlyArray<unknown>,
): Promise<Map<string, T>> {
  const last = params[params.length - 1];
  if (Array.isArray(last) && last.length === 0) return new Map();
  const r = await client.query<T>(sql, params as unknown[]);
  return new Map(r.rows.map((row) => [row.id, row]));
}
