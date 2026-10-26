/**
 * RT-906 (RT-905 decision, comment 14049) — the approver role resolved for a
 * held discount line, frozen in `sale_discount_role_resolutions` (migration
 * 0058).
 *
 * A cashier-path discount frozen with no `approver_role` (its approval came
 * from a PIN record with no role yet, RT-861) is held: `sales.yaml` requires
 * `approverRole` and POS never invents one. Once the approving manager signs
 * in online on the terminal, `refreshRole` writes the role onto the PIN
 * record, and the resolver (`discount-role-resolver.ts`) copies it here, once.
 *
 * Every reader takes the role from the same place: the frozen
 * `lines_json` role first and, only when none is frozen, the resolution of the
 * line's `placeholder_id` (`captureRoleOf` in `discount-hold.ts`). The row is
 * written before the sale's first capture POST and never edited (UPDATE and
 * DELETE are refused by triggers), so every retry under the same
 * `Idempotency-Key` builds the same body whatever the PIN record says later.
 */
import type { DatabaseHandle } from '../db/client.js';

/** The approver roles the capture contract accepts (`CaptureSaleLineDiscount.approverRole`). */
export type CaptureApproverRole = 'manager' | 'admin';

/** One sale's resolved roles, keyed by the line discount's `placeholder_id`. */
export type ResolvedDiscountRoles = ReadonlyMap<string, CaptureApproverRole>;

/** No resolution: every reader then sees the frozen `lines_json` role only. */
export const NO_RESOLVED_ROLES: ResolvedDiscountRoles = new Map();

/** How a role was resolved; the closed set of migration 0058's `source` CHECK. */
export const DISCOUNT_ROLE_SOURCE = 'pin_record_refresh' as const;

/** One row of `sale_discount_role_resolutions`. */
export interface DiscountRoleResolution {
  sale_id: string;
  placeholder_id: string;
  approval_id: string;
  approver_role: CaptureApproverRole;
  source: typeof DISCOUNT_ROLE_SOURCE;
  resolved_at: string;
}

/** The drain's view: resolve what became resolvable in a scope, and read one sale's roles. */
export interface SaleDiscountRoles {
  /** Freezes every role that can now be resolved; returns how many were written. */
  resolve(scope: { tenantId: string; branchId: string; terminalId: string }): number;
  rolesFor(saleId: string): ResolvedDiscountRoles;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}
interface PrepareRun {
  run(...params: unknown[]): { changes: number };
}

const SELECT_ROLES = `SELECT placeholder_id, approver_role FROM sale_discount_role_resolutions
                      WHERE sale_id = ?`;

// Never REPLACE: a conflict keeps the first row (the triggers refuse an edit).
const INSERT_ONCE = `INSERT INTO sale_discount_role_resolutions
                       (sale_id, placeholder_id, approval_id, approver_role, source, resolved_at)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT (sale_id, placeholder_id) DO NOTHING`;

function isCaptureApproverRole(role: unknown): role is CaptureApproverRole {
  return role === 'manager' || role === 'admin';
}

/** The sale's resolved roles; empty when it has none. */
export function readResolvedRoles(
  db: Pick<DatabaseHandle, 'prepare'>,
  saleId: string,
): ResolvedDiscountRoles {
  const rows = (
    db.prepare(SELECT_ROLES) as PrepareAll<{ placeholder_id: string; approver_role: unknown }>
  ).all(saleId);
  const roles = new Map<string, CaptureApproverRole>();
  for (const { placeholder_id, approver_role } of rows) {
    if (isCaptureApproverRole(approver_role)) roles.set(placeholder_id, approver_role);
  }
  return roles;
}

/** Inserts the resolution unless the line already has one; true when this call wrote it. */
export function insertResolutionOnce(
  db: Pick<DatabaseHandle, 'prepare'>,
  row: DiscountRoleResolution,
): boolean {
  const { changes } = (db.prepare(INSERT_ONCE) as PrepareRun).run(
    row.sale_id,
    row.placeholder_id,
    row.approval_id,
    row.approver_role,
    row.source,
    row.resolved_at,
  );
  return changes === 1;
}
