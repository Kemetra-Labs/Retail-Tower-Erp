/**
 * RT-1557 — the route of `provisioning-feed.yaml` (1.1.0-draft) that adopts an existing
 * connector registration as provisioner-managed:
 *
 *   POST /api/v1/platform/tenants/{tenant_id}/connector-instances/{id}/adopt   platformAdoptConnectorRegistration
 *
 * Auth: the HUMAN `cookieAuth` session only (`SessionOnlyAdminGuard`: a bearer is 401, a
 * cookie POST without a trusted `Origin` is 403 `origin_rejected`), then
 * `PlatformAdminGuard` (`users.is_platform_admin`, read from the database: 403 `forbidden`).
 * Not behind `TenantContextGuard`: a platform admin acts on any tenant, so the tenant is in
 * the path and the registration table's tenant RLS is satisfied by the path tenant. As a
 * route without `TenantContextGuard` it is not covered by support-session enforcement
 * (`support-session.coverage.ts`), like the other platform routes.
 */
import { Controller, ConflictException, Header, HttpCode, NotFoundException, Param, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { z } from "zod";

import { PlatformAdminGuard } from "../audit";
import { type AuthedRequest, SessionOnlyAdminGuard } from "../auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit";
import { type AdoptedRegistrationBody, ConnectorAdoptionService } from "./connector-adoption.service";

const UuidPipe = new ZodValidationPipe(z.string().uuid());

@Controller("api/v1/platform/tenants/:tenant_id/connector-instances/:id")
@UseGuards(SessionOnlyAdminGuard, PlatformAdminGuard)
export class ConnectorAdoptionController {
  constructor(private readonly service: ConnectorAdoptionService) {}

  @Post("adopt")
  @HttpCode(200)
  @ConsoleRateLimit("incidentControl")
  @Header("Cache-Control", "no-store")
  async adopt(
    @Req() request: AuthedRequest,
    @Param("tenant_id", UuidPipe) tenantId: string,
    @Param("id", UuidPipe) instanceId: string,
  ): Promise<AdoptedRegistrationBody> {
    const principal = request.principal;
    if (principal?.kind !== "session") throw new UnauthorizedException("Unauthorized");
    const result = await this.service.adopt({
      tenantId: tenantId.toLowerCase(),
      instanceId: instanceId.toLowerCase(),
      actorUserId: principal.userId,
      requestId: request.requestId ?? null,
    });
    switch (result.kind) {
      case "ok":
        return result.body;
      case "not_found":
        throw new NotFoundException({ code: "not_found", message: "Not Found" });
      case "disabled":
        throw new ConflictException({ code: "registration_disabled", message: "The connector registration is disabled." });
      case "already_managed":
        throw new ConflictException({
          code: "already_managed",
          message: "The connector registration is already managed and was not adopted by this caller.",
        });
    }
  }
}
