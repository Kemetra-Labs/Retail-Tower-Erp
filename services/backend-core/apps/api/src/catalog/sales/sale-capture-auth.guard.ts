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
