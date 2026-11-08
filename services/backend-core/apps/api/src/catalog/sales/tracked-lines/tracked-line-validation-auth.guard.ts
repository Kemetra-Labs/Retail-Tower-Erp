/**
 * TrackedLineValidationAuthGuard — the credential gate of the TLV
 * (`posValidateTrackedLine`, `pos-sales/tracked-lines.yaml`; Jira RT-451
 * slice S2).
 *
 * The TLV accepts the two ALTERNATIVE credentials of captureSale (RT-224
 * Option B), with the same selection rule, so the flow is
 * `CompositePosAuthGuard`'s (RT-1229):
 *
 *   1. Envelope path: the body carries no `operatorUserId`. The request goes
 *      to `PosOperatorEnvelopeSaleGuard` and nothing else (canonical bearer
 *      auth plus the live operator re-check; the operator is the actor).
 *   2. Device path: the body carries `operatorUserId` (its PRESENCE selects
 *      this path, so an envelope that carries it is the generic 401, and a
 *      device token without it is read as an envelope and fails the same way).
 *        a. `PosDeviceAuthGuard` resolves the bearer to an active device of an
 *           active tenant; scope comes from that row only.
 *        b. The strict TLV body (a malformed body from an authenticated device
 *           is the usual 400; the handler's pipe runs the same schema again).
 *        c. `PgTrackedLineCashierVerifier`: a cashier admission of this device
 *           and store for the claimed user, live at the server's current time
 *           (no back-dating window: a TLV is online), plus the live cashier
 *           eligibility rules.
 *        d. Only then is the VERIFIED cashier published as the actor.
 *
 * Refusals: a bad, revoked or missing credential on either path is the generic
 * 401; a refused claim from an AUTHENTICATED device is the generic 403
 * `refused`, one body for every cause (to the POS a device 401 means "device
 * revoked"), logged once with allowlisted fields and a fixed event name; never
 * the claimed user, the token or the body.
 *
 * The route carries `@DeviceBearer()` so the global FailClosedAuthGuard defers
 * here; route-auth-markers.enforcement.spec.ts lists this guard as a reviewed
 * composite that runs PosDeviceAuthGuard.
 */
import { type ExecutionContext, Inject, Injectable, Optional } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";

import { CompositePosAuthGuard, type CompositeGate } from "../../../auth/composite-pos-auth.guard";
import { PosDeviceAuthGuard } from "../../../auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../../auth/pos-operator-envelope-sale.guard";
import { ROOT_LOGGER } from "../../../common/logging.interceptor";
import type { TenantContextRequest } from "../../../context/types";
import type { DeviceScope } from "../../../pos-cashier-admissions/device-scope";
import { selectsDevicePath } from "../sale-capture-auth.guard";
import {
  TRACKED_LINE_CASHIER_REFUSAL_EVENTS,
  TRACKED_LINE_CASHIER_VERIFIER,
  type TrackedLineCashierVerifier,
} from "./tracked-line-cashier";
import { ValidateTrackedLineRequestSchema } from "./tracked-line-validation.dto";

@Injectable()
export class TrackedLineValidationAuthGuard extends CompositePosAuthGuard {
  /**
   * Class-referenced on the route, so reflection-instantiated: every
   * dependency is an explicit, module-resolvable token (SalesModule), the
   * claim verifier first.
   */
  constructor(
    @Inject(TRACKED_LINE_CASHIER_VERIFIER) private readonly cashier: TrackedLineCashierVerifier,
    @Inject(PosOperatorEnvelopeSaleGuard) envelope: CompositeGate,
    @Inject(PosDeviceAuthGuard) device: CompositeGate,
    @Optional() @Inject(ROOT_LOGGER) logger?: Pick<Logger, "warn">,
  ) {
    super(envelope, device, logger);
  }

  /** The device path is selected by `operatorUserId` in the body (any value), as on captureSale. */
  protected carriesCashierSelector(request: TenantContextRequest): boolean {
    return selectsDevicePath(request.body);
  }

  /** No per-route policy on the TLV. */
  protected routeOf(_context: ExecutionContext): undefined {
    return undefined;
  }

  /** Steps b and c: the strict body (400), then the live claim (generic 403 `refused`). */
  protected async verifiedCashier(request: TenantContextRequest, scope: DeviceScope): Promise<string> {
    const body = ValidateTrackedLineRequestSchema.parse(request.body);
    const userId = body.operatorUserId;
    if (userId === undefined) throw this.refused();
    const verdict = await this.cashier.verify(scope, userId);
    if (!verdict.ok) {
      this.logRefusal(
        request,
        scope,
        TRACKED_LINE_CASHIER_REFUSAL_EVENTS[verdict.cause],
        "posValidateTrackedLine: operator claim refused",
      );
      throw this.refused();
    }
    return userId;
  }
}
