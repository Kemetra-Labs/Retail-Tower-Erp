/**
 * InvitationAcceptController — `POST /api/v1/invitations/accept` (RT-937 item 4).
 *
 * PUBLIC: the single-use accept token in the body is the credential, so the
 * route carries `@Public()` and none of the console guards of
 * `InvitationsController` (it has no session, no tenant and no role yet).
 *
 *   - rate-limited per IP before any work, failing closed on a limiter outage
 *     (RT-628 posture), because the route can create a user;
 *   - a foreign `Origin` is refused (login CSRF: a NEW invitee gets a session
 *     cookie), a missing one is admitted, exactly as for sign-in (RT-430);
 *   - the session cookie is set for a NEW user only. An existing user gains the
 *     membership and gets no cookie;
 *   - the response is the Membership. It never carries the token, the password or
 *     a provider detail.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";

import { setSessionCookie } from "../auth/auth.controller";
import type { AuthedRequest } from "../auth/auth.guard";
import { assertTrustedOrigin } from "../auth/origin-check";
import {
  enforcePublicLimit,
  readPublicAuthLimiterTimeoutMs,
} from "../auth/public-auth-limiter";
import { RATE_LIMIT_BUCKETS, RateLimiter } from "../auth/rate-limit";
import { Public } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { InvitationAcceptSchema, type InvitationAcceptDto } from "./invitation.dto";
import { InvitationsService, type AcceptInvitationInput } from "./invitations.service";

@Controller("api/v1/invitations")
export class InvitationAcceptController {
  /** RT-628: bound on each public-auth limiter call, read once at boot. */
  private readonly limiterTimeoutMs = readPublicAuthLimiterTimeoutMs();

  constructor(
    private readonly invitations: InvitationsService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Public()
  @Post("accept")
  @HttpCode(HttpStatus.OK)
  async accept(
    @Body(new ZodValidationPipe(InvitationAcceptSchema)) body: InvitationAcceptDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object> {
    assertTrustedOrigin(req, { allowMissing: true });
    await enforcePublicLimit(
      this.rateLimiter,
      {
        bucketName: "invitation_accept_ip",
        identifier: clientIp(req),
        bucket: RATE_LIMIT_BUCKETS.invitationAcceptPerIp,
      },
      this.limiterTimeoutMs,
      res,
    );

    const input: AcceptInvitationInput = {
      token: body.token,
      ...(body.password !== undefined ? { password: body.password } : {}),
      ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
    };
    const { tenantId, membership, session } = await this.invitations.acceptInvitation(input);

    if (session) setSessionCookie(res, session.sessionCredential, session.absoluteExpiresAt);

    return {
      id: membership.membershipId,
      tenant_id: tenantId,
      user_id: membership.user.id,
      role_code: membership.roleCode,
      store_access_kind: membership.storeAccessKind,
      accessible_store_ids: membership.accessibleStoreIds,
      revoked_at: membership.revokedAt ? membership.revokedAt.toISOString() : null,
    };
  }
}

function clientIp(req: AuthedRequest): string {
  // Express honours `trust proxy`; fall back to the socket address for tests and dev.
  return String(req.ip ?? req.socket?.remoteAddress ?? "unknown");
}
