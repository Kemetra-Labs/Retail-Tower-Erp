/**
 * RT-1061 (RT-977 slice 1, decisions D1-D9) — `ConsoleSaleDetail.erpPostingFailure`
 * (`console-sales.openapi.yaml` 1.2.0-draft): why a failed ERPNext posting of
 * a sale failed, and its `repairPosting` handle.
 *
 * Console-only. The shared sale-history SQL, loader and projection
 * (`SALE_SELECT_SQL`, `loadDetail`) are untouched: the PII-suspect
 * `rejection_message` is never read on a POS path. This probe runs in the
 * console read's transaction, only for a sale that already matched the
 * caller's scope, and only when `erpPosting` shows a `failed` side.
 *
 * Probe keys are exactly the detail's joins (RT-977 §4): the sale side is
 * `kind = 'sale_post' AND source_ref_id = <sale>`; the reversal side is
 * `kind = 'reversal' AND source_ref_id = <the sale's sale_voids.id>` (one void
 * per sale, `uq_sale_voids_one_per_sale`). Never `sale_id = ...`: that would
 * attach a return's, refund's or credit-sale return's reason to the void side
 * (D9: those stay on the 017 / 025 backlogs). Both carry the tenant and an
 * explicit `store_id` predicate, on top of tenant RLS.
 *
 * Disclosure (D2, D3): `full` for a session that `repairPosting`'s own gate
 * admits (`POSTING_BACKLOG_ROLES` through the shared tenant role gate,
 * platform-admin session bypass included); `category_only` otherwise
 * (`store_manager`). Under `category_only`, `reason`,
 * `reconciliationDocumentRef` and `repair` are null whatever is stored.
 *
 * Repair handle (D5, RT-977 §5): non-null only under `full`, for a category
 * other than `reconciliation_required` (RT-332), and when `isStoreWritable`
 * (the repair's own store rule: membership scope AND a live store) holds for
 * the sale's store. Every handle returned is one `repairPosting` accepts for
 * the same session.
 *
 * Handling of `reason` (RT-410, D3): returned exactly as stored (sanitised on
 * write); never logged, never in audit metadata, never a metric label.
 */
import type { PoolClient } from "pg";

import type { SaleHistoryDetail } from "../catalog/sales/history/sale-history.projections";

type ErpPostingView = SaleHistoryDetail["erpPosting"];
import { RECONCILIATION_REQUIRED_CATEGORY } from "../catalog/erpnext-posting/erpnext-posting.service";
import { POSTING_BACKLOG_ROLES } from "../catalog/erpnext-reconciliation/posting-backlog-access";
import { isStoreWritable } from "../catalog/erpnext-reconciliation/posting-resolution.writer";
import {
  toBacklogItem,
  type PostingDeadletterRow,
} from "../catalog/erpnext-reconciliation/reconciliation-report.projection";
import { decideTenantRoleGate } from "../auth/tenant-role-gate";
import type { MembershipRepository } from "../context/membership.repository";
import type { ResolvedContext } from "../context/types";

export type ErpPostingDisclosure = "full" | "category_only";

export interface ConsoleErpPostingFailureDetail {
  readonly rejectionCategory: string | null;
  readonly deadLetteredAt: string;
  readonly reason: string | null;
  readonly reconciliationDocumentRef: { readonly doctype: string; readonly name: string } | null;
  readonly repair: { readonly workItemRef: string } | null;
}

export interface ConsoleErpPostingFailure {
  readonly disclosure: ErpPostingDisclosure;
  readonly sale: ConsoleErpPostingFailureDetail | null;
  readonly reversal: ConsoleErpPostingFailureDetail | null;
}

/** A dead-lettered posting row of the sale or of its void's reversal. */
export interface PostingFailureRow extends PostingDeadletterRow {
  readonly status: string;
}

/**
 * $1 tenant, $2 the sale's store, $3 the sale. At most two rows, through
 * `UQ_idx_erpnext_posting_status_source_ref (tenant_id, source_ref_id)`.
 */
export const POSTING_FAILURE_SQL = `
  SELECT p.id::text AS id, p.kind, p.status, p.rejection_category, p.sale_id::text AS sale_id,
         p.source_system, p.external_id, p.updated_at,
         p.reconciliation_document_ref, p.rejection_message
    FROM erpnext_posting_status p
   WHERE p.tenant_id = $1::uuid AND p.store_id = $2::uuid
     AND p.status = 'permanently_rejected'
     AND (
           (p.kind = 'sale_post' AND p.source_ref_id = $3::uuid)
        OR (p.kind = 'reversal' AND p.source_ref_id = (
              SELECT v.id FROM sale_voids v
               WHERE v.sale_id = $3::uuid AND v.tenant_id = $1::uuid AND v.store_id = $2::uuid))
         )`;

/** Whether the posting view shows a failed side: the only case the probe runs. */
export function hasFailedPosting(view: ErpPostingView): boolean {
  return view.sale === "failed" || view.reversal === "failed";
}

/** One dead-letter as the console shows it to a session of `disclosure`. */
export function toFailureDetail(
  row: PostingFailureRow,
  disclosure: ErpPostingDisclosure,
  storeWritable: boolean,
): ConsoleErpPostingFailureDetail {
  const item = toBacklogItem(row);
  const full = disclosure === "full";
  const repairable = full && storeWritable && item.rejectionCategory !== RECONCILIATION_REQUIRED_CATEGORY;
  return {
    rejectionCategory: item.rejectionCategory,
    deadLetteredAt: item.deadLetteredAt,
    reason: full ? item.reason : null,
    reconciliationDocumentRef: full ? item.reconciliationDocumentRef : null,
    repair: repairable ? { workItemRef: item.workItemRef } : null,
  };
}

/** The field from the probed rows (at most one per kind). */
export function toErpPostingFailure(
  rows: ReadonlyArray<PostingFailureRow>,
  disclosure: ErpPostingDisclosure,
  storeWritable: boolean,
): ConsoleErpPostingFailure {
  const side = (kind: "sale_post" | "reversal"): ConsoleErpPostingFailureDetail | null => {
    const row = rows.find((r) => r.kind === kind && r.status === "permanently_rejected");
    return row === undefined ? null : toFailureDetail(row, disclosure, storeWritable);
  };
  return { disclosure, sale: side("sale_post"), reversal: side("reversal") };
}

export interface PostingFailureInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
  /** The matched sale's store and ref. */
  readonly storeId: string;
  readonly saleRef: string;
  readonly erpPosting: ErpPostingView;
}

/** The disclosure tier of this session: `repairPosting`'s own role gate. */
export async function disclosureOf(
  client: PoolClient,
  memberships: MembershipRepository,
  input: Pick<PostingFailureInput, "tenantId" | "context">,
): Promise<ErpPostingDisclosure> {
  const decision = await decideTenantRoleGate(
    {
      principal: { kind: input.context.source, userId: input.context.userId },
      contextIsPlatformAdmin: input.context.isPlatformAdmin,
      tenantId: input.tenantId,
      accepted: POSTING_BACKLOG_ROLES,
    },
    {
      isPlatformAdmin: (userId) => memberships.isPlatformAdmin(userId),
      roleCodeInTenant: (userId, tenantId) => memberships.findRoleCodeForUserInTenant(userId, tenantId, client),
    },
  );
  return decision.allowed ? "full" : "category_only";
}

/**
 * `erpPostingFailure` of a matched sale: null unless `erpPosting` shows a
 * failed side. Runs on the console read's tenant-scoped client.
 */
export async function loadErpPostingFailure(
  client: PoolClient,
  memberships: MembershipRepository,
  input: PostingFailureInput,
): Promise<ConsoleErpPostingFailure | null> {
  if (!hasFailedPosting(input.erpPosting)) return null;
  const rows = (
    await client.query<PostingFailureRow>(POSTING_FAILURE_SQL, [input.tenantId, input.storeId, input.saleRef])
  ).rows;
  const disclosure = await disclosureOf(client, memberships, input);
  const storeWritable =
    disclosure === "full" && rows.length > 0
      ? await isStoreWritable(client, memberships, input, input.storeId)
      : false;
  return toErpPostingFailure(rows, disclosure, storeWritable);
}
