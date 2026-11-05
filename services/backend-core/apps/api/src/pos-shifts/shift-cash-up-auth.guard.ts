/**
 * ShiftCashUpAuthGuard — the credential gate of the RT-17 cash-up writes
 * ([GATED] approval: Jira RT-17 comments 10760 + 10919 + 10920; contract
 * `pos-shifts.openapi.yaml` 1.1.0-draft, "Authentication").
 *
 * The same two ALTERNATIVE credentials as captureSale (RT-224 Option B,
 * `SaleCaptureAuthGuard`), reused rather than copied:
 *
 *   1. Envelope path: the body carries no `operatorUserId`. The request goes
 *      to `PosOperatorEnvelopeSaleGuard` and nothing else (canonical bearer
 *      auth plus the live operator re-check; the operator is the actor).
 *
 *   2. Device path: the body carries `operatorUserId` (its PRESENCE selects
 *      this path, so an envelope that carries it is the generic 401).
 *        a. `PosDeviceAuthGuard` resolves the bearer to an active device of
 *           an active tenant; scope comes from that row only.
 *        b. The route's strict body schema runs (a malformed body from an
 *           authenticated device is the usual 400).
 *        c. A body only the envelope may send (a forced close) is refused;
 *           the route's stated user (`openingUserId` / `closingUserId`)
 *           must equal the claim (#711 review note 1).
 *        d. `PgOperatorAttributionVerifier` must accept the claim at the
 *           fact's own time (`openedAt` / `occurredAt` / `closedAt`): a covering cashier
 *           admission of this device and store with the RT-224 tolerance and
 *           dating caps, plus the live cashier eligibility rules.
 *        e. Only then is the VERIFIED cashier published as the actor, which
 *           the service records, the idempotency layer scopes the key to and
 *           the audit emitter records.
 *
 * Refusals: a bad, revoked or missing credential on either path is the
 * generic 401; a refused claim from an AUTHENTICATED device is the generic
 * 403 `refused`, one body for every cause (to the POS a device 401 means
 * "device revoked"). The published principal's scope (`pos` here,
 * `pos_operator` on the envelope path) is what the handler reads the path
 * from (PR #713 review #3). A refusal is logged once with allowlisted fields and a
 * fixed event name; never the claimed user, the token, the body or a time.
 *
 * Per-route policy is route metadata (`@ShiftFactRoute`), read straight from
 * the handler: a class-referenced guard is one shared instance. A route
 * without it is a configuration error (500), never a credential refusal. The route
 * also carries `@DeviceBearer()`, so the global FailClosedAuthGuard defers
 * here; route-auth-markers.enforcement.spec.ts lists this guard as a
 * reviewed composite that runs PosDeviceAuthGuard.
 */
import { type ExecutionContext, Inject, Injectable, Optional, SetMetadata } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";
import type { ZodTypeAny } from "zod";

import { CompositePosAuthGuard, type CompositeGate } from "../auth/composite-pos-auth.guard";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../auth/pos-operator-envelope-sale.guard";
import {
  OPERATOR_ATTRIBUTION_VERIFIER,
  type AttributionRefusal,
  type OperatorAttributionVerifier,
} from "../catalog/sales/operator-attribution";
import { selectsDevicePath } from "../catalog/sales/sale-capture-auth.guard";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import type { TenantContextRequest } from "../context/types";
import type { DeviceScope } from "../pos-cashier-admissions/device-scope";

/** How one cash-up route is verified on the device path. */
export interface ShiftFactRouteSpec {
  /** The route's strict body schema (the handler's pipe uses the same one). */
  readonly schema: ZodTypeAny;
  /** The body field holding the fact's POS-clock time: the attribution instant. */
  readonly timeField: string;
  /** The body field naming the stated user, which must equal the claim. */
  readonly actorField?: string;
  /**
   * True for a body only the manager envelope may send (a forced close):
   * on the device path it is the generic 403 `refused`, before the verifier.
   */
  readonly envelopeOnly?: (body: Readonly<Record<string, unknown>>) => boolean;
}

export const SHIFT_FACT_ROUTE_KEY = "dp2:shift-cash-up:fact-route";

/** Route metadata for ShiftCashUpAuthGuard. */
export const ShiftFactRoute = (spec: ShiftFactRouteSpec) => SetMetadata(SHIFT_FACT_ROUTE_KEY, spec);

/** Why a device-path claim was refused. A closed set, logged and never returned. */
export type ShiftClaimRefusal = AttributionRefusal | "operator_missing" | "actor_mismatch" | "envelope_only";

/** The refusal log's fixed `event` for a cause. */
export function shiftRefusalEvent(cause: ShiftClaimRefusal): string {
  return `shift.cash_up.operator_refused.${cause}`;
}

type FactBody = Record<string, unknown>;

/**
 * The flow (route spec first, selection, envelope, device first, publish) is
 * CompositePosAuthGuard's (RT-1229); this class supplies the route spec, the
 * body selector and steps b to d.
 */
@Injectable()
export class ShiftCashUpAuthGuard extends CompositePosAuthGuard<ShiftFactRouteSpec> {
  constructor(
    @Inject(PosOperatorEnvelopeSaleGuard) envelope: CompositeGate,
    @Inject(PosDeviceAuthGuard) device: CompositeGate,
    @Inject(OPERATOR_ATTRIBUTION_VERIFIER) private readonly attribution: OperatorAttributionVerifier,
    @Optional() @Inject(ROOT_LOGGER) logger?: Pick<Logger, "warn">,
  ) {
    super(envelope, device, logger);
  }

  protected routeOf(context: ExecutionContext): ShiftFactRouteSpec {
    return routeSpecOf(context);
  }

  protected carriesCashierSelector(request: TenantContextRequest): boolean {
    return selectsDevicePath(request.body);
  }

  protected async verifiedCashier(
    request: TenantContextRequest,
    scope: DeviceScope,
    route: ShiftFactRouteSpec,
  ): Promise<string> {
    const body = route.schema.parse(request.body) as FactBody;
    const refusal = await this.refusalOf(scope, route, body);
    if (refusal !== null) {
      this.logRefusal(request, scope, shiftRefusalEvent(refusal), "shift cash-up: operator attribution refused");
      throw this.refused();
    }
    return body["operatorUserId"] as string;
  }

  /** The first refusal cause of a device-path claim, or null when it is accepted. */
  private async refusalOf(
    scope: DeviceScope,
    route: ShiftFactRouteSpec,
    body: FactBody,
  ): Promise<ShiftClaimRefusal | null> {
    const userId = body["operatorUserId"];
    if (typeof userId !== "string") return "operator_missing";
    if (route.envelopeOnly?.(body) === true) return "envelope_only";
    if (route.actorField !== undefined && body[route.actorField] !== userId) return "actor_mismatch";
    const verdict = await this.attribution.verify({
      ...scope,
      userId,
      occurredAt: String(body[route.timeField]),
    });
    return verdict.ok ? null : verdict.cause;
  }
}

/**
 * The route's spec. A route without one is a configuration error, refused
 * before any credential is checked as a plain Error (the generic 500), never
 * a 401: to the POS a device 401 means "device revoked" and wipes its grants
 * (PR #713 review #2). shift-cash-up-auth.guard.unit.spec.ts asserts that
 * every ShiftCashUpController handler behind this guard carries one.
 */
function routeSpecOf(context: ExecutionContext): ShiftFactRouteSpec {
  const spec = Reflect.getMetadata(SHIFT_FACT_ROUTE_KEY, context.getHandler()) as
    | ShiftFactRouteSpec
    | undefined;
  if (spec === undefined) {
    throw new Error("ShiftCashUpAuthGuard: the route has no @ShiftFactRoute spec (configuration error)");
  }
  return spec;
}
