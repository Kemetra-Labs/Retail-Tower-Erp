/**
 * Jira RT-451 slice S2 — the TLV's cashier claim (`posValidateTrackedLine`,
 * device path; `pos-sales/tracked-lines.yaml`, "Cashier claim").
 *
 * The contract: "The server accepts the claim only if a cashier admission of
 * this device and store for that user is live at the server's current time and
 * the cashier is still eligible, the same rules as `captureSale`'s
 * `operatorUserId` without the back-dating window, because a TLV is online."
 *
 * So, under the device's tenant (RLS), with no till-supplied time at all:
 *
 *   1. a `cashier_admissions` row of the device's tenant and store, the SAME
 *      device and the claimed user, live NOW:
 *
 *        created_at <= now() < LEAST(ended_at, expires_at)
 *
 *      the admissions service's own liveness (a row is expired once
 *      `expires_at <= now` and ended from `ended_at` on; LEAST ignores a NULL
 *      `ended_at`). No clock-skew tolerance and no back-dating window: both
 *      bounds and the instant are server times (captureSale's
 *      `COVERING_ADMISSION_SQL` widens its window only because `occurredAt`
 *      is the till's clock);
 *   2. the cashier is still eligible, LIVE: the RT-113 BC2 predicate set
 *      (`CashierEligibilityRepository`), reused, not copied.
 *
 * Refusal causes are a closed set, logged as fixed event names and never
 * returned: every refusal is the generic 403 `refused`.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import {
  CashierEligibilityRepository,
  type CashierEligibilityReader,
  type RefusalReason,
} from "../../../pos-cashier-admissions/cashier-eligibility";
import type { DeviceScope } from "../../../pos-cashier-admissions/device-scope";

export type TrackedLineCashierRefusal = "no_live_admission" | RefusalReason;

export type TrackedLineCashierVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: TrackedLineCashierRefusal };

export interface TrackedLineCashierVerifier {
  verify(scope: DeviceScope, userId: string): Promise<TrackedLineCashierVerdict>;
}

export const TRACKED_LINE_CASHIER_VERIFIER = Symbol.for("api.sales.trackedLineCashierVerifier");

/** The refusal log's fixed `event` per cause (redaction matrix §3.4 `event`). */
export const TRACKED_LINE_CASHIER_REFUSAL_EVENTS: Readonly<Record<TrackedLineCashierRefusal, string>> = {
  no_live_admission: "tracked_line.validate.operator_refused.no_live_admission",
  membership_inactive: "tracked_line.validate.operator_refused.membership_inactive",
  user_deleted: "tracked_line.validate.operator_refused.user_deleted",
  role_ineligible: "tracked_line.validate.operator_refused.role_ineligible",
  store_inactive: "tracked_line.validate.operator_refused.store_inactive",
  store_not_accessible: "tracked_line.validate.operator_refused.store_not_accessible",
  profile_incomplete: "tracked_line.validate.operator_refused.profile_incomplete",
};

/** `$1` tenant, `$2` store, `$3` device, `$4` user: a live admission at the server's now(). */
const LIVE_ADMISSION_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM cashier_admissions
     WHERE tenant_id = $1 AND store_id = $2 AND device_id = $3 AND user_id = $4
       AND created_at <= now()
       AND now() < LEAST(ended_at, expires_at)
  ) AS live`;

export class PgTrackedLineCashierVerifier implements TrackedLineCashierVerifier {
  constructor(
    /** The NOBYPASSRLS domain pool (PG_POOL): every read runs under the device's tenant. */
    private readonly pool: Pool,
    private readonly eligibility: CashierEligibilityReader = new CashierEligibilityRepository(),
  ) {}

  verify(scope: DeviceScope, userId: string): Promise<TrackedLineCashierVerdict> {
    return runWithTenantContext(
      this.pool,
      { tenantId: scope.tenantId, isPlatformAdmin: false },
      async (client): Promise<TrackedLineCashierVerdict> => {
        const live = await client.query<{ live: boolean }>(LIVE_ADMISSION_SQL, [
          scope.tenantId,
          scope.storeId,
          scope.deviceId,
          userId,
        ]);
        if (live.rows[0]?.live !== true) return { ok: false, cause: "no_live_admission" };
        const eligibility = await this.eligibility.check(client, scope, userId);
        if (!eligibility.eligible) return { ok: false, cause: eligibility.reason };
        return { ok: true };
      },
    );
  }
}
