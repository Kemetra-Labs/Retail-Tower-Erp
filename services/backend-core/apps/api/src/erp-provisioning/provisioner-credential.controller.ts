/**
 * RT-1358 — the platform-admin routes of `provisioning-feed.yaml` for the
 * provisioner credential:
 *
 *   POST /api/v1/platform/erp-provisioner-credentials                      platformIssueProvisionerCredential
 *   POST /api/v1/platform/erp-provisioner-credentials/{hostLabel}/rotate   platformRotateProvisionerCredential
 *   POST /api/v1/platform/erp-provisioner-credentials/{hostLabel}/revoke   platformRevokeProvisionerCredential
 *
 * The HUMAN `cookieAuth` session only (`SessionOnlyAdminGuard`: a bearer is 401, a
 * cookie write without a trusted Origin is 403 `origin_rejected`); the service
 * checks `users.is_platform_admin` (403). The secret comes back once, `no-store`.
 */
import { Body, Controller, Header, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";

import type { AuthedRequest } from "../auth/auth.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { HostLabelSchema, IssueProvisionerCredentialBodySchema } from "./dto/provisioning.dto";
import {
  type IssuedProvisionerCredentialBody,
  ProvisionerCredentialService,
  type RevokedProvisionerCredentialBody,
} from "./provisioner-credential.service";

const HostLabelPipe = new ZodValidationPipe(HostLabelSchema);

@Controller("api/v1/platform/erp-provisioner-credentials")
@UseGuards(SessionOnlyAdminGuard)
export class ProvisionerCredentialController {
  constructor(private readonly service: ProvisionerCredentialService) {}

  @Post()
  @HttpCode(201)
  @ConsoleRateLimit("onboarding")
  @Header("Cache-Control", "no-store")
  async issue(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(IssueProvisionerCredentialBodySchema)) body: { hostLabel: string },
  ): Promise<IssuedProvisionerCredentialBody> {
    return await this.service.issue({ principal: req.principal, hostLabel: body.hostLabel, requestId: req.requestId ?? null });
  }

  @Post(":hostLabel/rotate")
  @HttpCode(201)
  @ConsoleRateLimit("incidentControl")
  @Header("Cache-Control", "no-store")
  async rotate(@Req() req: AuthedRequest, @Param("hostLabel", HostLabelPipe) hostLabel: string): Promise<IssuedProvisionerCredentialBody> {
    return await this.service.rotate({ principal: req.principal, hostLabel, requestId: req.requestId ?? null });
  }

  @Post(":hostLabel/revoke")
  @HttpCode(200)
  @ConsoleRateLimit("incidentControl")
  @Header("Cache-Control", "no-store")
  async revoke(@Req() req: AuthedRequest, @Param("hostLabel", HostLabelPipe) hostLabel: string): Promise<RevokedProvisionerCredentialBody> {
    return await this.service.revoke({ principal: req.principal, hostLabel, requestId: req.requestId ?? null });
  }
}
