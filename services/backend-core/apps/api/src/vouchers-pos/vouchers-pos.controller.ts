/**
 * VouchersPosController — RT-1112 (RT-1098 slice R-3): Contract V-A
 * (`pos-payments/vouchers.yaml`).
 *
 *   POST /api/pos/v1/vouchers/validate → posValidateVoucher
 *   POST /api/pos/v1/vouchers/redeem   → posRedeemVoucher
 *   POST /api/pos/v1/vouchers/reverse  → posReverseVoucher
 *
 * Order on every route: the device token (generic 401), then on validate and
 * redeem the cashier claim (generic 403 `refused`; redeem first serves a stored
 * successful replay, see `RedeemVoucherAuthGuard`), then the global
 * `IdempotencyInterceptor` (`Idempotency-Key` required, partitioned per device),
 * then the strict body (400 `validation_failure`), then the service. The
 * failed-lookup rate limit (429 with `Retry-After`) is the service's first step
 * on validate and redeem.
 *
 * Idempotency per route:
 *   - validate: the 200 carries the single-use intent token, so its replay record
 *     lives no longer than the intent (`replayTtlSec` = the 240 s intent TTL): a
 *     replay never returns a dead token, and a later same-key retry runs again
 *     and gets a fresh intent. The stored 200 holds the token (an accepted
 *     exception to "hashes only", see the service header).
 *   - redeem: replay sets `idempotent_replayed: true` in the body (contract).
 *   - reverse: replay sets `already_reversed: true` (contract: true on every call
 *     after the first).
 * The routes carry no `@Auditable`: their change events are written in the
 * service transaction (`vouchers-pos-audit.ts`), so a replay never audits twice.
 *
 * The POS voucher tender stays OFF (RT-103): nothing here enables it.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { DeviceBearer } from "../auth/route-auth";
import { Idempotent } from "../idempotency/idempotent.decorator";
import { ContractValidationPipe } from "../vouchers-admin/vouchers-admin.dto";
import { INTENT_TTL_SECONDS } from "./vouchers-pos.queries";
import { RedeemVoucherAuthGuard, ValidateVoucherAuthGuard, type VoucherRequest } from "./voucher-cashier-auth.guard";
import { rateLimitedException, VoucherLookupRateLimited } from "./voucher-lookup-limit";
import {
  RedeemVoucherSchema,
  ReverseVoucherSchema,
  ValidateVoucherSchema,
  type RedeemVoucherBody,
  type RedeemVoucherDto,
  type ReverseVoucherBody,
  type ReverseVoucherDto,
  type ValidateVoucherBody,
  type ValidateVoucherDto,
} from "./vouchers-pos.dto";
import { toHttpRefusal, VoucherRefusal, type VoucherOperation } from "./vouchers-pos.errors";
import { VouchersPosService, type CashierCaller, type DeviceCaller } from "./vouchers-pos.service";

/** The validate replay window: the intent's own lifetime, so a replayed token is never a dead one. */
const VALIDATE_REPLAY_TTL_SEC = INTENT_TTL_SECONDS;

@Controller()
export class VouchersPosController {
  constructor(private readonly vouchers: VouchersPosService) {}

  @Post("api/pos/v1/vouchers/validate")
  @HttpCode(HttpStatus.OK)
  @DeviceBearer()
  @UseGuards(ValidateVoucherAuthGuard)
  @Idempotent("required", { clientScope: "device", replayTtlSec: VALIDATE_REPLAY_TTL_SEC })
  async validate(
    @Req() request: VoucherRequest,
    @Body(new ContractValidationPipe(ValidateVoucherSchema)) body: ValidateVoucherDto,
  ): Promise<ValidateVoucherBody> {
    const caller = cashierCaller(request);
    return answer(request, "validate", () => this.vouchers.validate(caller, body));
  }

  @Post("api/pos/v1/vouchers/redeem")
  @HttpCode(HttpStatus.OK)
  @DeviceBearer()
  @UseGuards(RedeemVoucherAuthGuard)
  @Idempotent("required", { clientScope: "device", replayBodyOverrides: { idempotent_replayed: true } })
  async redeem(
    @Req() request: VoucherRequest,
    @Body(new ContractValidationPipe(RedeemVoucherSchema)) body: RedeemVoucherDto,
  ): Promise<RedeemVoucherBody> {
    const caller = cashierCaller(request);
    return answer(request, "redeem", () => this.vouchers.redeem(caller, body));
  }

  @Post("api/pos/v1/vouchers/reverse")
  @HttpCode(HttpStatus.OK)
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @Idempotent("required", { clientScope: "device", replayBodyOverrides: { already_reversed: true } })
  async reverse(
    @Req() request: VoucherRequest,
    @Body(new ContractValidationPipe(ReverseVoucherSchema)) body: ReverseVoucherDto,
  ): Promise<ReverseVoucherBody> {
    return answer(request, "reverse", () => this.vouchers.reverse(deviceCaller(request), body));
  }
}

/** The device the guard published; fail closed (generic 401) if it did not. */
function deviceCaller(request: VoucherRequest): DeviceCaller {
  const ctx = request.context;
  if (!ctx?.tenantId || !ctx.storeId || !request.posDeviceId) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, storeId: ctx.storeId, deviceId: request.posDeviceId, requestId: request.requestId ?? null };
}

/**
 * The device plus the guard's VERIFIED cashier. A request let through on a
 * stored replay has none; if the interceptor did not replay it after all (the
 * record expired in between), it is refused like an unverified claim.
 */
function cashierCaller(request: VoucherRequest): CashierCaller {
  const device = deviceCaller(request);
  const userId = request.context?.userId;
  if (!userId || request.voucherReplay === true) throw new ForbiddenException({ code: "refused", message: "Forbidden" });
  return { ...device, cashierUserId: userId };
}

/** Map the domain refusals and the lookup limit to their HTTP answers. */
async function answer<T>(request: VoucherRequest, operation: VoucherOperation, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof VoucherRefusal) throw toHttpRefusal(operation, err);
    if (err instanceof VoucherLookupRateLimited) {
      request.res?.setHeader("Retry-After", String(err.retryAfterSeconds));
      throw rateLimitedException();
    }
    throw err;
  }
}
