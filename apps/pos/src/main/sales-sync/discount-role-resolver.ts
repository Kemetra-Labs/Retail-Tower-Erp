/**
 * RT-906 (RT-905 decision, comment 14049) — resolve the approver role of a
 * held discount line from the approving manager's PIN record, and freeze it.
 *
 * For each of the current terminal's pending sales held for a discount with
 * no frozen `approver_role`, and for each such cashier-approval line:
 *
 *   1. its `cart.discount.manager_authorized` audit row, matched as
 *      `freezeLineDiscounts` matched it (tenant, branch, placeholder, cart,
 *      line, amount), and naming the line's approver;
 *   2. that row's `approval_id` → the consumed `cart.discount.manual`
 *      approval on the sale's own tenant, branch and terminal, granted by the
 *      same approver;
 *   3. that approver's PIN record on the sale's own tenant, branch and
 *      terminal, neither revoked nor disabled: its `role`, which `refreshRole`
 *      writes at each online manager / admin sign-in (RT-861).
 *
 * When that role is `manager` or `admin`, one row goes into
 * `sale_discount_role_resolutions` with a local
 * `sale.discount.approver_role_resolved` audit event, in one transaction.
 * Anything else (no row, another approver, no role, a revoked or disabled
 * record, another terminal) resolves nothing: the sale stays held under
 * `discount_capture_unavailable`, never sent with a guessed role and never
 * dead-lettered. A line already resolved is skipped; a repeat insert is a
 * no-op that emits nothing.
 */
import type { DatabaseHandle } from '../db/client.js';
import { SYSTEM_DEVICE_ACTOR_ID, type AuditEvent } from '../../shared/audit/event-shape.js';
import { CAPTURE_APPROVER_ROLES } from './discount-hold.js';
import {
  DISCOUNT_ROLE_SOURCE,
  insertResolutionOnce,
  readResolvedRoles,
  type CaptureApproverRole,
  type DiscountRoleResolution,
  type SaleDiscountRoles,
} from './discount-role-resolutions.js';
import { discountHeldSaleSql } from './sale-sync-state-repo.js';

export interface DiscountRoleResolverDeps {
  db: DatabaseHandle;
  /** Writes the local audit event; called inside the resolution's transaction. */
  emit: (event: AuditEvent) => void;
  now: () => string;
  newEventId: () => string;
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}
interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

/** A held sale that may carry a resolvable line. */
interface HeldSale {
  sale_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  envelope_cart_id: string;
  lines_json: string;
}

/** A cashier-approval discount line frozen with no role. */
interface RolelessDiscount {
  line_id: string;
  placeholder_id: string;
  amount_minor: number;
  approver: string;
}

// The pending set of `countDiscountHeld`, on the current terminal, oldest first.
const HELD_SALES_SQL = `SELECT sa.sale_id AS sale_id, sa.tenant_id AS tenant_id,
         sa.branch_id AS branch_id, sa.terminal_id AS terminal_id,
         sa.envelope_cart_id AS envelope_cart_id, sa.lines_json AS lines_json
       FROM sale_sync_outbox o
       JOIN sales sa ON sa.sale_id = o.sale_id
       LEFT JOIN sale_sync_state s ON s.sale_id = o.sale_id
       WHERE o.tenant_id = ? AND o.branch_id = ? AND o.terminal_id = ?
         AND (s.sale_id IS NULL OR s.sync_status = 'pending')
         AND ${discountHeldSaleSql(true)}
       ORDER BY o.enqueued_at ASC`;

const AUTHORIZED_ROW_SQL = `SELECT payload, approving_supervisor_id FROM audit_events
    WHERE tenant_id = ? AND branch_id = ?
      AND action_category = 'cart.discount.manager_authorized'
      AND json_extract(payload, '$.placeholder_id') = ?
      AND json_extract(payload, '$.cart_id') = ?
      AND json_extract(payload, '$.cart_line_id') = ?
      AND json_extract(payload, '$.amount_minor') = ?
    ORDER BY created_at ASC
    LIMIT 1`;

const APPROVAL_SQL = `SELECT approver_user_id FROM manager_approvals
    WHERE approval_id = ? AND tenant_id = ? AND branch_id = ? AND terminal_id = ?
      AND action_kind = 'cart.discount.manual' AND consumed_at IS NOT NULL`;

const PIN_ROLE_SQL = `SELECT role FROM manager_pin_records
    WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND user_id = ?
      AND revoked_at IS NULL AND disabled_at IS NULL`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(raw: string | null | undefined): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function sameUser(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}

/** A cashier approval frozen with no role: the only kind the resolver may resolve. */
function isRolelessCashierApproval(discount: Record<string, unknown>): boolean {
  return (
    discount['approver_role'] === undefined && discount['authority_source'] === 'cashier_approval'
  );
}

/** The line's discount when it is a well-formed role-less cashier approval; else null. */
function rolelessDiscountOf(line: unknown): RolelessDiscount | null {
  if (!isRecord(line) || !isRecord(line['discount'])) return null;
  const discount = line['discount'];
  if (!isRolelessCashierApproval(discount)) return null;
  const { placeholder_id, amount_minor, approver_operator_id } = discount;
  const lineId = line['line_id'];
  const wellFormed =
    typeof lineId === 'string' &&
    typeof placeholder_id === 'string' &&
    Number.isSafeInteger(amount_minor) &&
    typeof approver_operator_id === 'string';
  return wellFormed
    ? {
        line_id: lineId,
        placeholder_id,
        amount_minor: amount_minor as number,
        approver: approver_operator_id,
      }
    : null;
}

/** The sale's role-less cashier-approval lines; none for an unreadable snapshot. */
function rolelessDiscounts(linesJson: string): RolelessDiscount[] {
  const lines = parseJson(linesJson);
  if (!Array.isArray(lines)) return [];
  return lines
    .map(rolelessDiscountOf)
    .filter((discount): discount is RolelessDiscount => discount !== null);
}

/** What a resolution needs: the approval it came from, its approver and their role. */
interface ResolvedApprover {
  approval_id: string;
  approver_user_id: string;
  approver_role: CaptureApproverRole;
}

export function createDiscountRoleResolver(deps: DiscountRoleResolverDeps): SaleDiscountRoles {
  const { db } = deps;

  /** Step 1: the line's audit row's `approval_id`, when the row names the line's approver. */
  function approvalIdOf(sale: HeldSale, discount: RolelessDiscount): string | null {
    const row = (
      db.prepare(AUTHORIZED_ROW_SQL) as PrepareGet<{
        payload: string | null;
        approving_supervisor_id: string | null;
      }>
    ).get(
      sale.tenant_id,
      sale.branch_id,
      discount.placeholder_id,
      sale.envelope_cart_id,
      discount.line_id,
      discount.amount_minor,
    );
    const payload = parseJson(row?.payload);
    const approvalId = isRecord(payload) ? payload['approval_id'] : undefined;
    if (
      typeof approvalId !== 'string' ||
      !sameUser(row?.approving_supervisor_id, discount.approver)
    ) {
      return null;
    }
    return approvalId;
  }

  /**
   * Steps 1–3. The line's approver's live record role is read first, by key:
   * a sale that never resolves (the decided residual) costs one lookup a tick.
   * Only then the audit row and the approval, which must name the same user.
   */
  function approverOf(sale: HeldSale, discount: RolelessDiscount): ResolvedApprover | null {
    const scope = [sale.tenant_id, sale.branch_id, sale.terminal_id];
    const userId = discount.approver.toLowerCase();
    const role = (db.prepare(PIN_ROLE_SQL) as PrepareGet<{ role: unknown }>).get(
      ...scope,
      userId,
    )?.role;
    if (!CAPTURE_APPROVER_ROLES.has(role)) return null;
    const approvalId = approvalIdOf(sale, discount);
    if (approvalId === null) return null;
    const approval = (db.prepare(APPROVAL_SQL) as PrepareGet<{ approver_user_id: string }>).get(
      approvalId,
      ...scope,
    );
    if (approval === undefined || !sameUser(approval.approver_user_id, userId)) return null;
    return {
      approval_id: approvalId,
      approver_user_id: userId,
      approver_role: role as CaptureApproverRole,
    };
  }

  function auditEventOf(
    sale: HeldSale,
    resolution: DiscountRoleResolution,
    approverUserId: string,
  ): AuditEvent {
    return {
      event_id: deps.newEventId(),
      tenant_id: sale.tenant_id,
      branch_id: sale.branch_id,
      originating_terminal_id: sale.terminal_id,
      acting_operator_id: SYSTEM_DEVICE_ACTOR_ID,
      session_id: null,
      shift_id: null,
      action_category: 'sale.discount.approver_role_resolved',
      created_at: resolution.resolved_at,
      approving_supervisor_id: approverUserId,
      payload: { ...resolution },
    };
  }

  // One transaction: the resolution and its audit event land together, or neither.
  const writeOnce = db.transaction(
    (sale: HeldSale, resolution: DiscountRoleResolution, approverUserId: string): boolean => {
      if (!insertResolutionOnce(db, resolution)) return false;
      deps.emit(auditEventOf(sale, resolution, approverUserId));
      return true;
    },
  );

  /** Resolves each of the sale's unresolved role-less lines it can; returns how many. */
  function resolveSale(sale: HeldSale, resolvedAt: string): number {
    const already = readResolvedRoles(db, sale.sale_id);
    let written = 0;
    for (const discount of rolelessDiscounts(sale.lines_json)) {
      if (already.has(discount.placeholder_id)) continue;
      const approver = approverOf(sale, discount);
      if (approver === null) continue;
      const resolution: DiscountRoleResolution = {
        sale_id: sale.sale_id,
        placeholder_id: discount.placeholder_id,
        approval_id: approver.approval_id,
        approver_role: approver.approver_role,
        source: DISCOUNT_ROLE_SOURCE,
        resolved_at: resolvedAt,
      };
      if (writeOnce(sale, resolution, approver.approver_user_id)) written += 1;
    }
    return written;
  }

  return {
    resolve(scope) {
      const held = (db.prepare(HELD_SALES_SQL) as PrepareAll<HeldSale>).all(
        scope.tenantId,
        scope.branchId,
        scope.terminalId,
      );
      if (held.length === 0) return 0;
      const resolvedAt = deps.now();
      return held.reduce((sum, sale) => sum + resolveSale(sale, resolvedAt), 0);
    },
    rolesFor(saleId) {
      return readResolvedRoles(db, saleId);
    },
  };
}
