/**
 * SignupsController — RT-1350 slice 3: the two PUBLIC self-signup routes of
 * `packages/contracts/openapi/signups.openapi.yaml`.
 *
 *   POST /api/v1/signups           requestSignup   always 202 for an accepted body
 *   POST /api/v1/signups/complete  completeSignup  201 + the native session cookie
 *
 * Both carry `@Public()`: the human proof (request) and the emailed single-use token
 * (complete) are the credentials. Both refuse a foreign `Origin` (403 `origin_rejected`;
 * a missing one is admitted, as for sign-in), are rate-limited per client IP BEFORE any
 * work, and fail closed with 503 + `Retry-After` on a limiter outage (RT-628, owner
 * ruling O6). Every refusal about the body, the proof or the token is the ONE generic
 * 400, so nothing tells a caller whether an address exists. No token, password or email
 * is logged here.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";

import { Public } from "../auth/route-auth";
import { RATE_LIMIT_BUCKETS, RateLimiter } from "../auth/rate-limit";
import {
  enforcePublicLimit,
  PUBLIC_AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS,
  publicAuthUnavailable,
  readPublicAuthLimiterTimeoutMs,
} from "../auth/public-auth-limiter";
import { clientIpIdentifier } from "../auth/public-auth-keys";
import { assertTrustedOrigin } from "../auth/origin-check";
import type { AuthedRequest } from "../auth/auth.guard";
import { setSessionCookie } from "../auth/auth.controller";
import {
  SignupCompleteSchema,
  SignupRequestSchema,
  SignupValidationPipe,
  signupInvalid,
  type SignupCompleteInput,
  type SignupRequestInput,
} from "./signup.dto";
import { SignupsService } from "./signups.service";

interface SignupCompleteBody {
  readonly tenantId: string;
  readonly membershipRole: "owner";
  readonly entitlement: "restricted";
}

@Controller("api/v1/signups")
export class SignupsController {
  /** RT-628: bound on each public-auth limiter call, read once at boot. */
  private readonly limiterTimeoutMs = readPublicAuthLimiterTimeoutMs();

  constructor(
    private readonly signups: SignupsService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async requestSignup(
    @Body(new SignupValidationPipe(SignupRequestSchema)) body: SignupRequestInput,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    assertTrustedOrigin(req, { allowMissing: true });
    const ip = clientIp(req);
    await enforcePublicLimit(
      this.rateLimiter,
      { bucketName: "signup_create_ip", identifier: clientIpIdentifier(ip), bucket: RATE_LIMIT_BUCKETS.signupCreatePerIp },
      this.limiterTimeoutMs,
      res,
    );
    const outcome = await this.signups.requestSignup(body, { ip, requestId: req.requestId ?? null });
    if (outcome === "invalid") throw signupInvalid();
    if (outcome === "unavailable") throw unavailable(res);
    // "accepted": an empty 202, whether or not a link will be sent.
  }

  @Public()
  @Post("complete")
  @HttpCode(HttpStatus.CREATED)
  async completeSignup(
    @Body(new SignupValidationPipe(SignupCompleteSchema)) body: SignupCompleteInput,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupCompleteBody> {
    assertTrustedOrigin(req, { allowMissing: true });
    const ip = clientIp(req);
    await enforcePublicLimit(
      this.rateLimiter,
      { bucketName: "signup_complete_ip", identifier: clientIpIdentifier(ip), bucket: RATE_LIMIT_BUCKETS.signupCompletePerIp },
      this.limiterTimeoutMs,
      res,
    );
    const result = await this.signups.completeSignup(body, { ip, requestId: req.requestId ?? null });
    if (result.kind === "invalid") throw signupInvalid();
    if (result.kind === "unavailable") throw unavailable(res);

    setSessionCookie(res, result.session.sessionCredential, result.session.absoluteExpiresAt);
    return { tenantId: result.tenantId, membershipRole: "owner", entitlement: "restricted" };
  }
}

/** The O6 outage answer with its `Retry-After`. */
function unavailable(res: Response): Error {
  res.setHeader("Retry-After", String(PUBLIC_AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS));
  return publicAuthUnavailable();
}

function clientIp(req: AuthedRequest): string {
  // Express honours `trust proxy`; fall back to the socket address for tests and dev.
  return String(req.ip ?? req.socket?.remoteAddress ?? "unknown");
}
