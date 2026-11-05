/**
 * CompositePosAuthGuard — the shared decision flow of the reviewed POS
 * composites (RT-1229): SaleCaptureAuthGuard (RT-224), ShiftCashUpAuthGuard
 * (RT-17) and SaleHistoryAuthGuard (RT-539). Each accepts two ALTERNATIVE
 * credentials, and the flow below is the same for all three:
 *
 *   0. the route's own policy is read first (a guard may refuse a
 *      misconfigured route here, before any credential is checked);
 *   1. the request selects a path by the PRESENCE of a cashier selector
 *      (a body field or a header, per guard);
 *   2. envelope path: `PosOperatorEnvelopeSaleGuard` alone (canonical bearer
 *      auth plus the live operator re-verify, RT-137; the operator is the
 *      actor). A guard may wrap its refusal (the sale history's probe);
 *   3. device path: `PosDeviceAuthGuard` FIRST (a bad, revoked or missing
 *      credential is its generic 401 before anything else is read), then the
 *      device's scope (tenant, store, device from the device row only);
 *   4. the guard's own claim check (body or header validation, then the
 *      attribution verifier or admission selector). Any refusal is the
 *      generic 403 `refused`, one body for every cause, logged once with
 *      allowlisted fields (to the POS a device 401 means "device revoked");
 *   5. only then is the VERIFIED cashier published as the actor, with the
 *      device's scope (principal scope `pos`).
 *
 * Each subclass keeps its class name and its own `@Inject` constructor (the
 * guards are class-referenced, so reflection-instantiated) and supplies only
 * its differences: the selector, the claim check, and optionally the route
 * policy and the envelope path. route-auth-markers.enforcement.spec.ts lists
 * the subclasses as the reviewed composites that run PosDeviceAuthGuard.
 *
 * Security seams (RT-1229 review): a subclass must NOT override
 * `canActivate`, which is what guarantees that the device guard runs before
 * any claim check and that only a verified cashier is published. An
 * `envelopePath` override (today only the sale history's device probe) must
 * rethrow the envelope's refusal unless it refuses with its own 403. It is
 * a new composite and needs its own security review.
 */
import { type CanActivate, type ExecutionContext, ForbiddenException } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";

import type { TenantContextRequest } from "../context/types";
import { deviceScopeOf, type DeviceScope } from "../pos-cashier-admissions/device-scope";

/** A collaborating guard, as the composites call it. */
export type CompositeGate = Pick<CanActivate, "canActivate">;

export abstract class CompositePosAuthGuard<Route = undefined> implements CanActivate {
  protected constructor(
    protected readonly envelope: CompositeGate,
    protected readonly device: CompositeGate,
    protected readonly logger?: Pick<Logger, "warn">,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.routeOf(context);
    const request = context.switchToHttp().getRequest<TenantContextRequest>();
    if (!this.carriesCashierSelector(request)) {
      return this.envelopePath(context, request, route);
    }

    await this.device.canActivate(context);
    const scope = deviceScopeOf(request);
    const userId = await this.verifiedCashier(request, scope, route);
    publishCashier(request, scope, userId);
    return true;
  }

  /** The route's policy; runs before any credential is checked. */
  protected abstract routeOf(context: ExecutionContext): Route;

  /** True when the request carries the cashier selector (the device path). */
  protected abstract carriesCashierSelector(request: TenantContextRequest): boolean;

  /**
   * The authenticated device's claimed cashier, verified: the user to
   * publish as the actor. Throws the guard's 400 or 403 on a refusal.
   */
  protected abstract verifiedCashier(
    request: TenantContextRequest,
    scope: DeviceScope,
    route: Route,
  ): Promise<string>;

  /** The envelope path: the envelope guard alone. */
  protected async envelopePath(
    context: ExecutionContext,
    _request: TenantContextRequest,
    _route: Route,
  ): Promise<boolean> {
    return (await this.envelope.canActivate(context)) as boolean;
  }

  /** Log a refused claim once, with allowlisted fields and a fixed event name. */
  protected logRefusal(request: TenantContextRequest, scope: DeviceScope, event: string, message: string): void {
    this.logger?.warn(
      {
        event,
        request_id: request.requestId ?? null,
        tenant_id: scope.tenantId,
        store_id: scope.storeId,
        status: 403,
        outcome: "failure",
      },
      message,
    );
  }

  /** The generic claim refusal: the cashier-admissions `refused` body (RT-224 rev709 F1). */
  protected refused(): ForbiddenException {
    return new ForbiddenException({ code: "refused", message: "Forbidden" });
  }
}

/** The verified cashier becomes the actor; scope stays the device's. */
function publishCashier(request: TenantContextRequest, scope: DeviceScope, userId: string): void {
  request.context = {
    userId,
    tenantId: scope.tenantId,
    storeId: scope.storeId,
    isPlatformAdmin: false,
    source: "token",
  };
  request.principal = {
    kind: "token",
    tokenId: scope.deviceId,
    tenantId: scope.tenantId,
    userId,
    storeId: scope.storeId,
    scope: "pos",
  };
}
