/**
 * SaleCaptureAuthGuard — captureSale's credential gate (RT-224 Option B;
 * [GATED] approval: Jira RT-224 comment 10889).
 *
 * captureSale accepts two ALTERNATIVE credentials (sales.yaml 1.5.0-draft):
 *
 *   1. Envelope path (unchanged, 031): the body carries no `operatorUserId`.
 *      The request goes to PosOperatorEnvelopeSaleGuard and to nothing else,
 *      so a manager/admin sale behaves exactly as before: canonical bearer
 *      auth, live re-verification, the operator as actor.
 *
 *   2. Device path: the body carries `operatorUserId` (its PRESENCE selects
 *      this path; an envelope request that carries it is therefore refused).
 *        a. PosDeviceAuthGuard resolves the bearer to an active device of an
 *           active tenant (RT-213) and publishes its tenant, store and
 *           device. Never the request's.
 *        b. The body is validated with the captureSale pipe, so a malformed
 *           body from an AUTHENTICATED device is the usual 400 (the pipe runs
 *           again in the handler; it is pure). An unauthenticated device
 *           never reaches this step: authentication comes first.
 *        c. The attribution verifier must accept (device scope, claimed user,
 *           occurredAt): a covering cashier admission of this device and
 *           store (with the rev709 clock-skew tolerance and dating caps),
 *           plus the live cashier eligibility rules.
 *        d. Only then is the VERIFIED user published as the actor
 *           (`request.context.userId`, `request.principal.userId`), which is
 *           what the controller records as `created_by`, the idempotency
 *           layer scopes the key to, and the audit emitter records as actor.
 *
 * Refusals (RT-224 rev709 F1):
 *   - a bad, revoked or missing credential on either path (including an
 *     envelope that carries `operatorUserId`, which is not a device token) is
 *     the same generic 401;
 *   - a refused cashier claim from an AUTHENTICATED device is the generic 403
 *     `refused`, one body for every cause (no factor disclosure). It must not
 *     be a 401: to the POS a device 401 means "device revoked" (RT-113 D4/D8)
 *     and wipes the offline grants. This mirrors the cashier-admissions API
 *     (401 bad device, generic 403 `refused` ineligible user).
 * A refused claim is logged once with allowlisted fields only (signals.md §4
 * / redaction matrix §3.4): never the claimed user, the token, the body,
 * occurredAt or admissionCheckAt (RT-225).
 *
 * The route carries @DeviceBearer() so the global FailClosedAuthGuard defers
 * to this guard (its opaque-token lookup would reject a device token). Both
 * paths authenticate here; route-auth-markers.enforcement.spec.ts lists this
 * guard as a reviewed composite that runs PosDeviceAuthGuard.
 */
import { type ExecutionContext, Inject, Injectable, Optional } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";

import { CompositePosAuthGuard, type CompositeGate } from "../../auth/composite-pos-auth.guard";
import { PosDeviceAuthGuard } from "../../auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../auth/pos-operator-envelope-sale.guard";
import { ROOT_LOGGER } from "../../common/logging.interceptor";
import type { TenantContextRequest } from "../../context/types";
import type { DeviceScope } from "../../pos-cashier-admissions/device-scope";
import { CaptureSaleRequestPipe } from "./dto/capture-sale-request.pipe";
import { RecordVoidRequestSchema } from "./dto/record-void-request.dto";
import {
  TRACKED_LINE_CASHIER_VERIFIER,
  type TrackedLineCashierRefusal,
  type TrackedLineCashierVerifier,
} from "./tracked-lines/tracked-line-cashier";
import {
  ATTRIBUTION_REFUSAL_EVENTS,
  OPERATOR_ATTRIBUTION_VERIFIER,
  type OperatorAttributionVerifier,
} from "./operator-attribution";

/** The body field whose presence selects the device path (sales.yaml). */
export const OPERATOR_USER_ID_FIELD = "operatorUserId";

/** True when the JSON body object carries `operatorUserId` (any value). */
export function selectsDevicePath(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.hasOwn(body, OPERATOR_USER_ID_FIELD)
  );
}

/**
 * The flow (selection, envelope, device first, publish) is
 * CompositePosAuthGuard's (RT-1229); this class supplies the body selector
 * and steps b and c.
 */
@Injectable()
export class SaleCaptureAuthGuard extends CompositePosAuthGuard {
  private readonly bodyPipe = new CaptureSaleRequestPipe();

  // A class-referenced @UseGuards enhancer is reflection-instantiated, so
  // every dependency is an explicit, module-resolvable token (SalesModule
  // provides all four; ROOT_LOGGER is app-wide and optional).
  constructor(
    @Inject(PosOperatorEnvelopeSaleGuard) envelope: CompositeGate,
    @Inject(PosDeviceAuthGuard) device: CompositeGate,
    @Inject(OPERATOR_ATTRIBUTION_VERIFIER) private readonly attribution: OperatorAttributionVerifier,
    @Optional() @Inject(ROOT_LOGGER) logger?: Pick<Logger, "warn">,
  ) {
    super(envelope, device, logger);
  }

  /** captureSale has no per-route policy. */
  protected routeOf(_context: ExecutionContext): undefined {
    return undefined;
  }

  /** captureSale: `operatorUserId` in the body (any value) selects the device path. */
  protected carriesCashierSelector(request: TenantContextRequest): boolean {
    return selectsDevicePath(request.body);
  }

  /** Steps b and c: the body (400), then the attribution verifier (generic 403 `refused`). */
  protected async verifiedCashier(request: TenantContextRequest, scope: DeviceScope): Promise<string> {
    // b. The body (400 on a malformed body, as the handler's pipe would).
    const body = this.bodyPipe.transform(request.body, { type: "body" });
    const userId = body.operatorUserId;
    if (userId === undefined) throw this.refused();

    // c. The claimed cashier. RT-225: an `admissionCheckAt` (validated by the
    // pipe: device path only, <= occurredAt, at most 7 days before it) is the
    // instant the verifier compares with the window instead of occurredAt.
    const verdict = await this.attribution.verify({
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      deviceId: scope.deviceId,
      userId,
      occurredAt: body.occurredAt,
      ...(body.admissionCheckAt !== undefined ? { admissionCheckAt: body.admissionCheckAt } : {}),
    });
    if (!verdict.ok) {
      this.logRefusal(request, scope, ATTRIBUTION_REFUSAL_EVENTS[verdict.cause], "captureSale: operator attribution refused");
      throw this.refused();
    }
    // d. The verified cashier is the actor (published by the base). Scope stays the device's.
    return userId;
  }
}

/** The refusal log's fixed `event` per cause of recordVoid's cashier claim (redaction matrix §3.4 `event`). */
export const SALE_VOID_CASHIER_REFUSAL_EVENTS: Readonly<Record<TrackedLineCashierRefusal, string>> = {
  no_live_admission: "sale_void.operator_refused.no_live_admission",
  membership_inactive: "sale_void.operator_refused.membership_inactive",
  user_deleted: "sale_void.operator_refused.user_deleted",
  role_ineligible: "sale_void.operator_refused.role_ineligible",
  store_inactive: "sale_void.operator_refused.store_inactive",
  store_not_accessible: "sale_void.operator_refused.store_not_accessible",
  profile_incomplete: "sale_void.operator_refused.profile_incomplete",
};

/**
 * SaleVoidAuthGuard — recordVoid's credential gate (RT-1403, RT-530 owner
 * decision c12029, 2026-10-16; `[GATED: contract]` approval: RT-1403 c18071).
 *
 * It is declared in this file, beside the captureSale gate it mirrors, so it
 * shares that file's reviewed imports of the auth, context and cashier-admission
 * internals (module-boundaries ratchet, RT-1453) instead of adding new ones.
 *
 * recordVoid accepts two ALTERNATIVE credentials, on `CompositePosAuthGuard`
 * (RT-1229), exactly like captureSale:
 *
 *   1. Envelope path (unchanged, RT-530): the body carries no `operatorUserId`.
 *      The request goes to `PosOperatorEnvelopeSaleGuard` and to nothing else,
 *      so a manager or admin void behaves exactly as before.
 *   2. Device path: the body carries `operatorUserId` (its PRESENCE selects
 *      this path; an envelope that carries it is therefore the generic 401).
 *        a. `PosDeviceAuthGuard` resolves the bearer to an active device of an
 *           active tenant; tenant, store and device come from that row only.
 *        b. The strict void body (a malformed body from an authenticated
 *           device is the usual 400; the handler's pipe runs it again).
 *        c. `TrackedLineCashierVerifier` (RT-451 S2, reused): a cashier
 *           admission of THIS device and store for the claimed user, live at
 *           the server's current time (no back-dating window), plus the live
 *           cashier eligibility rules. A void queued while the cashier was
 *           admitted is therefore sent only while the same cashier is admitted
 *           again (RT-530 c12006).
 *        d. Only then is the VERIFIED cashier published as the actor, so the
 *           service's `requesterIsActor`, four-eyes, same-day and eligibility
 *           checks (void-approval.ts) apply unchanged: the requester is bound
 *           to the cashier holding a live admission on the paired device, never
 *           to an id the client merely states.
 *
 * Refusals: a bad, revoked or missing credential on either path is the generic
 * 401; a refused cashier claim from an AUTHENTICATED device is the generic 403
 * `refused` (one body for every cause; to the POS a device 401 means "device
 * revoked"), logged once with allowlisted fields and a fixed event name, never
 * the claimed user, the token or the body.
 *
 * The route carries `@DeviceBearer()` so the global FailClosedAuthGuard defers
 * here; route-auth-markers.enforcement.spec.ts lists this guard as a reviewed
 * composite that runs PosDeviceAuthGuard.
 */
@Injectable()
export class SaleVoidAuthGuard extends CompositePosAuthGuard {
  // Class-referenced on the route, so reflection-instantiated: every
  // dependency is an explicit, module-resolvable token (SalesModule), the
  // claim verifier first.
  constructor(
    @Inject(TRACKED_LINE_CASHIER_VERIFIER) private readonly cashier: TrackedLineCashierVerifier,
    @Inject(PosOperatorEnvelopeSaleGuard) envelope: CompositeGate,
    @Inject(PosDeviceAuthGuard) device: CompositeGate,
    @Optional() @Inject(ROOT_LOGGER) logger?: Pick<Logger, "warn">,
  ) {
    super(envelope, device, logger);
  }

  /** `operatorUserId` in the body (any value) selects the device path, as on captureSale. */
  protected carriesCashierSelector(request: TenantContextRequest): boolean {
    return selectsDevicePath(request.body);
  }

  /** recordVoid has no per-route policy. */
  protected routeOf(_context: ExecutionContext): undefined {
    return undefined;
  }

  /** Steps b and c: the strict body (400), then the live claim (generic 403 `refused`). */
  protected async verifiedCashier(request: TenantContextRequest, scope: DeviceScope): Promise<string> {
    const body = RecordVoidRequestSchema.parse(request.body);
    const userId = body.operatorUserId;
    if (userId === undefined) throw this.refused();
    const verdict = await this.cashier.verify(scope, userId);
    if (!verdict.ok) {
      this.logRefusal(
        request,
        scope,
        SALE_VOID_CASHIER_REFUSAL_EVENTS[verdict.cause],
        "recordVoid: operator claim refused",
      );
      throw this.refused();
    }
    return userId;
  }
}
