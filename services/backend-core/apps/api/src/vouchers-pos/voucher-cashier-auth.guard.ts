/**
 * The credential gates of V-A validate and redeem — RT-1112, contract
 * `pos-payments/vouchers.yaml` (RT-1110 "Authentication boundary").
 *
 * Device scheme only (no envelope path, unlike captureSale):
 *   a. `PosDeviceAuthGuard` resolves the bearer to an active device of an
 *      active tenant; tenant, store and device come from that row only. A
 *      missing, invalid or revoked token is the generic 401.
 *   b. Redeem only (owner decision 1, RT-1112 c16636): a stored SUCCESSFUL
 *      redeem of this device, `Idempotency-Key` and exact body is replayed
 *      BEFORE the admission check, so a till that retries after its cashier
 *      signed out still gets its `redemption_id`. The lookup is the
 *      `IdempotencyInterceptor`'s own store key (device partition, route
 *      template, header) and body fingerprint, read-only. Only a stored 200
 *      skips the check: a miss, an in-flight claim, a different body or a
 *      lookup failure goes on to step c FIRST, so a refused claim never learns
 *      anything from a 409 or a 425. Validate never skips the check.
 *   c. The strict body (400 `validation_failure`; the handler's pipe parses it
 *      again).
 *   d. The cashier claim (`operatorUserId`): a cashier admission of this device,
 *      store and user live at the server's current time, plus the live cashier
 *      eligibility (membership, role, store access), the TLV's verifier
 *      (`PgTrackedLineCashierVerifier`), reused. Checked before any code or
 *      token is looked up. A refusal is the generic 403 `refused`, one body for
 *      every cause, logged once with allowlisted fields and a fixed event name
 *      (never the claimed user, the token, the code or the body).
 *   e. Only then is the VERIFIED cashier published as the actor.
 *
 * The routes carry `@DeviceBearer()` so the global FailClosedAuthGuard defers
 * here; route-auth-markers.enforcement.spec.ts lists both as reviewed gates that
 * run PosDeviceAuthGuard.
 */
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { IdempotencyKeyStore, type Logger } from "@data-pulse-2/shared";
import type { ZodTypeAny } from "zod";

import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import {
  TRACKED_LINE_CASHIER_VERIFIER,
  type TrackedLineCashierRefusal,
  type TrackedLineCashierVerifier,
} from "../catalog/sales/tracked-lines/tracked-line-cashier";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import type { TenantContextRequest } from "../context/types";
import { bodyFingerprint, deviceClientKey, IDEMPOTENCY_KEY_STORE } from "../idempotency/idempotency.interceptor";
import { isNonReplayableMarker } from "../idempotency/non-replayable";
import { composeStoreKey } from "../idempotency/store-key";
import { deviceScopeOf, type DeviceScope } from "../pos-cashier-admissions/device-scope";
import { ContractValidationPipe } from "../vouchers-admin/vouchers-admin.dto";
import { RedeemVoucherSchema, ValidateVoucherSchema } from "./vouchers-pos.dto";

/** The interceptor's key shape (`IdempotencyInterceptor`, KEY_REGEX). */
const IDEMPOTENCY_KEY_FORMAT = /^[\x21-\x7E]{16,128}$/;

/** The refusal log's fixed `event` per cause (redaction matrix §3.4 `event`). */
const VOUCHER_CLAIM_REFUSAL_EVENTS: Readonly<Record<TrackedLineCashierRefusal, string>> = {
  no_live_admission: "voucher.claim_refused.no_live_admission",
  membership_inactive: "voucher.claim_refused.membership_inactive",
  user_deleted: "voucher.claim_refused.user_deleted",
  role_ineligible: "voucher.claim_refused.role_ineligible",
  store_inactive: "voucher.claim_refused.store_inactive",
  store_not_accessible: "voucher.claim_refused.store_not_accessible",
  profile_incomplete: "voucher.claim_refused.profile_incomplete",
};

/** Set on a redeem request the guard let through on a stored replay (no cashier verified). */
export interface VoucherRequest extends TenantContextRequest {
  voucherReplay?: true;
}

abstract class VoucherCashierAuthGuard implements CanActivate {
  private readonly pipe: ContractValidationPipe<ZodTypeAny>;

  protected constructor(
    private readonly device: Pick<CanActivate, "canActivate">,
    private readonly cashier: TrackedLineCashierVerifier,
    schema: ZodTypeAny,
    private readonly operation: "posValidateVoucher" | "posRedeemVoucher",
    protected readonly logger?: Pick<Logger, "warn">,
  ) {
    this.pipe = new ContractValidationPipe(schema);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<VoucherRequest>();
    await this.device.canActivate(context);
    const scope = deviceScopeOf(request);
    if (await this.servesStoredReplay(request, scope)) {
      request.voucherReplay = true;
      return true;
    }
    const body = this.pipe.transform(request.body, { type: "body" }) as { operatorUserId: string };
    const verdict = await this.cashier.verify(scope, body.operatorUserId);
    if (!verdict.ok) {
      this.logger?.warn(
        {
          event: VOUCHER_CLAIM_REFUSAL_EVENTS[verdict.cause],
          request_id: request.requestId ?? null,
          tenant_id: scope.tenantId,
          store_id: scope.storeId,
          status: 403,
          outcome: "failure",
        },
        `${this.operation}: operator claim refused`,
      );
      throw new ForbiddenException({ code: "refused", message: "Forbidden" });
    }
    publishCashier(request, scope, body.operatorUserId);
    return true;
  }

  /** Step b. Validate: never. */
  protected abstract servesStoredReplay(request: VoucherRequest, scope: DeviceScope): Promise<boolean>;
}

@Injectable()
export class ValidateVoucherAuthGuard extends VoucherCashierAuthGuard {
  // Class-referenced on the route, so reflection-instantiated: explicit tokens.
  constructor(
    @Inject(PosDeviceAuthGuard) device: PosDeviceAuthGuard,
    @Inject(TRACKED_LINE_CASHIER_VERIFIER) cashier: TrackedLineCashierVerifier,
    @Optional() @Inject(ROOT_LOGGER) logger?: Pick<Logger, "warn">,
  ) {
    super(device, cashier, ValidateVoucherSchema, "posValidateVoucher", logger);
  }

  protected async servesStoredReplay(): Promise<boolean> {
    return false;
  }
}

@Injectable()
export class RedeemVoucherAuthGuard extends VoucherCashierAuthGuard {
  constructor(
    @Inject(PosDeviceAuthGuard) device: PosDeviceAuthGuard,
    @Inject(TRACKED_LINE_CASHIER_VERIFIER) cashier: TrackedLineCashierVerifier,
    @Inject(IDEMPOTENCY_KEY_STORE) private readonly replays: IdempotencyKeyStore,
    @Optional() @Inject(ROOT_LOGGER) logger?: Pick<Logger, "warn">,
  ) {
    super(device, cashier, RedeemVoucherSchema, "posRedeemVoucher", logger);
  }

  /**
   * True only for a stored successful 200 of this device, key and exact body.
   * The interceptor then replays it (its own lookup, same key).
   */
  protected async servesStoredReplay(request: VoucherRequest, scope: DeviceScope): Promise<boolean> {
    const raw = request.headers["idempotency-key"];
    const headerValue = Array.isArray(raw) ? raw[0] : raw;
    if (typeof headerValue !== "string" || !IDEMPOTENCY_KEY_FORMAT.test(headerValue)) return false;
    const clientId = deviceClientKey(scope.deviceId);
    const req = request as unknown as { method: string; route?: { path?: string }; url: string; params?: Record<string, unknown> };
    const storeKey = composeStoreKey(
      { method: req.method.toUpperCase(), routePath: req.route?.path ?? req.url, params: req.params },
      clientId,
      headerValue,
    );
    try {
      const found = await this.replays.findOrCreate(scope.tenantId, null, clientId, storeKey, bodyFingerprint(request.body));
      return found.hit === true && found.entry.result.status === 200 && !isNonReplayableMarker(found.entry.result.body);
    } catch (err) {
      // Fail toward the full check: a lookup failure never skips the admission.
      this.logger?.warn({ err, event: "voucher.redeem.replay_lookup_failed" }, "posRedeemVoucher: replay lookup failed; checking the claim");
      return false;
    }
  }
}

/** Step e: the verified cashier is the actor; scope stays the device's. */
function publishCashier(request: TenantContextRequest, scope: DeviceScope, userId: string): void {
  request.context = { userId, tenantId: scope.tenantId, storeId: scope.storeId, isPlatformAdmin: false, source: "token" };
  request.principal = { kind: "token", tokenId: scope.deviceId, tenantId: scope.tenantId, userId, storeId: scope.storeId, scope: "pos" };
}
