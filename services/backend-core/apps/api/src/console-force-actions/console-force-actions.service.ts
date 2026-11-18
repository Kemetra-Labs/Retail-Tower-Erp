/**
 * ConsoleForceActionsService — the Console half of the owner's "force with
 * impact preview" for stuck shifts (RT-1437; RT-1445 = slice B1;
 * `console-force-actions.openapi.yaml`): the open-shifts read, the per-shift
 * impact preview, and the Console force close.
 *
 * Every rule is the POS force close's, over the same `ShiftForceCloseService`
 * and the same repository: one stuck verdict (`readVerdict`) feeds the list,
 * the preview and the write, so the Console and POS views cannot diverge. The
 * caller's role and all-store scope are decided by `ForceActionAccessGuard`
 * before any method here runs; the tenant is the session's.
 *
 * The reads write nothing and take no lock (a snapshot, not a reservation).
 * The write re-evaluates every rule in its own transaction.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../database";
import { formatMoney } from "../common/money/shift-money";
import {
  previewFingerprint,
  readForceCloseFacts,
  readStoreOpenShifts,
  ShiftCashUpError,
  ShiftForceCloseRepository,
  ShiftForceCloseService,
  type ConsoleForceClosedShiftProjection,
  type ForceCloseFacts,
  type ShiftWriteResult,
  type StoreShiftRow,
} from "../pos-shifts";
import { enforceForceActionCap, insertForceActionAudit } from "../console-action-cap/force-action-cap";
import {
  buildOpenShiftSummary,
  toOpenShiftListBody,
  type ForceClosePreviewBody,
  type OpenShiftListBody,
  type OpenShiftRow,
} from "./console-force-actions.projections";

/** `GET /stores/{store_id}/open-shifts` is capped here, as the contract says. */
const OPEN_SHIFT_LIMIT = 200;

/** The tenant, the closing user, their role and the request id of a Console force close. */
export interface ConsoleForceCloseInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorRole: "owner" | "tenant_admin";
  readonly requestId: string | null;
}

/** The store of the session's tenant is absent, deleted or foreign: the non-disclosing 404. */
export class ConsoleStoreNotFoundError extends Error {
  constructor() {
    super("store not found");
    this.name = "ConsoleStoreNotFoundError";
  }
}

@Injectable()
export class ConsoleForceActionsService {
  private readonly repo = new ShiftForceCloseRepository();
  private readonly forceClose: ShiftForceCloseService;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.forceClose = new ShiftForceCloseService(pool, this.repo);
  }

  /** Every open shift of the store with its verdict (D6), judged at one instant. */
  async listOpenShifts(tenantId: string, storeId: string): Promise<OpenShiftListBody> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const store = await client.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [
        storeId,
        tenantId,
      ]);
      if (store.rowCount === 0) throw new ConsoleStoreNotFoundError();
      // The open-shift read and each shift's verdict come from the pos-shifts port (RT-1453): the very
      // SQL the POS force close, the preview and the write use.
      const reads = await readStoreOpenShifts(
        client,
        { tenantId, storeId },
        { limit: OPEN_SHIFT_LIMIT, order: "newest_first", thresholdMinutes: this.forceClose.thresholdMinutes },
      );
      const now = (await client.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now;
      const items: OpenShiftRow[] = reads.map((r) => ({
        shift: r.shift,
        cashierDisplayName: r.cashierDisplayName,
        terminal: r.terminal,
        verdict: r.verdict,
      }));
      return toOpenShiftListBody({ storeId, evaluatedAt: now, thresholdMinutes: this.forceClose.thresholdMinutes, items });
    });
  }

  /** What force-closing the shift would change now; read-only, with the fingerprint the write needs. */
  async previewForceClose(tenantId: string, shiftId: string): Promise<ForceClosePreviewBody> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const shift = await this.repo.findShiftInTenant(client, tenantId, shiftId, false);
      if (shift === null) throw new ShiftCashUpError("shift_not_found");
      const verdict = await this.repo.readVerdict(client, shift, this.rule());
      const facts = await requireFacts(client, shift);
      return {
        shift: buildOpenShiftSummary({
          shift,
          cashierDisplayName: facts.cashierDisplayName,
          terminal: {
            label: facts.terminalLabel,
            lastSeenAt: facts.terminalLastSeenAt,
            trustState: facts.terminalTrustState,
          },
          verdict,
          evaluatedAt: facts.evaluatedAt,
        }),
        recorded: {
          currencyCode: shift.currencyCode,
          openingFloat:
            shift.currencyCode === null || shift.openingFloat === null
              ? null
              : formatMoney({ amount: shift.openingFloat, currencyCode: shift.currencyCode }),
          cashMovementCount: facts.cashMovementCount,
          lastCashMovementReceivedAt: facts.lastCashMovementReceivedAt?.toISOString() ?? null,
          saleCount: facts.saleCount,
          refundExecutionCount: facts.refundExecutionCount,
        },
        effects: {
          willChange: [
            "shift_closed_not_counted",
            "no_cash_up_recorded",
            "terminal_may_open_new_shift",
            "device_retire_replace_move_unblocked",
            "timezone_change_unblocked",
          ],
          willNotChange: [
            "sales_unchanged",
            "refunds_unchanged",
            "cash_movements_unchanged",
            "stock_unchanged",
            "erp_documents_unchanged",
          ],
        },
        reversible: false,
        drawerCashUnaccounted: true,
        caveats: ["offline_facts_not_visible", "terminal_not_notified"],
        previewFingerprint: previewFingerprint(shift, verdict, facts),
        evaluatedAt: facts.evaluatedAt.toISOString(),
      };
    });
  }

  /**
   * The Console force close: `ShiftForceCloseService.forceCloseFromConsole`
   * with the shared D9 cap before the record and the `shift.force_closed`
   * audit row after it, in the same transaction. A replay writes neither.
   */
  async forceCloseShift(
    input: ConsoleForceCloseInput,
    shiftId: string,
    body: { readonly forcedReason: string; readonly previewFingerprint: string },
  ): Promise<ShiftWriteResult<ConsoleForceClosedShiftProjection>> {
    const { tenantId, actorUserId, actorRole, requestId } = input;
    return this.forceClose.forceCloseFromConsole({ tenantId, actorUserId, actorRole }, shiftId, body, {
      beforeRecord: (client) => enforceForceActionCap(client, tenantId),
      afterRecord: (client, event) =>
        insertForceActionAudit(client, {
          tenantId,
          storeId: event.storeId,
          actorUserId,
          requestId,
          action: "shift.force_closed",
          targetType: "shift",
          targetId: event.shiftId,
          metadata: { ...event.audit },
        }),
    });
  }

  /** The same rule the write judges with (one threshold source: `ShiftForceCloseService`). */
  private rule(): { callerTokenId: null; thresholdMinutes: number } {
    return this.forceClose.consoleStuckRule();
  }
}

async function requireFacts(client: PoolClient, shift: StoreShiftRow): Promise<ForceCloseFacts> {
  const facts = await readForceCloseFacts(client, shift);
  if (facts === null) throw new ShiftCashUpError("shift_not_found");
  return facts;
}
