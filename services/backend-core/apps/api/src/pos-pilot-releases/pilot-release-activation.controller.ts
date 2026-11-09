/**
 * PilotReleaseActivationController: RT-1298 runtime of
 * `platformActivatePilotRelease` (`pos-pilot-releases.openapi.yaml`):
 *
 *   POST /api/v1/platform/pos-pilot-releases/{releaseId}/activate
 *
 * Caller: a platform admin on the Console session cookie, as the pilot allowlist
 * routes (`PilotTenantsController`): `SessionOnlyAdminGuard` (human cookie only;
 * an unsafe request needs a trusted `Origin`, RT-430), then `PlatformAdminGuard`.
 * Not the promotion workflow: registering a release never makes it downloadable,
 * a person activates it. The write-class rate limit applies. No body.
 */
import { Controller, Header, HttpCode, Param, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";

import { PlatformAdminGuard } from "../audit/platform-admin.guard";
import type { AuthedRequest } from "../auth/auth.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { ReleaseIdParamSchema } from "./dto";
import { throwRegistryHttpError } from "./pilot-release-registry.http";
import type { PilotReleaseBody } from "./pilot-release-registry.rows";
import { PilotReleaseRegistryService } from "./pilot-release-registry.service";

/** The platform-admin route that makes one registered release the current pilot release. */
@Controller("api/v1/platform/pos-pilot-releases")
@UseGuards(SessionOnlyAdminGuard, PlatformAdminGuard)
export class PilotReleaseActivationController {
  constructor(private readonly registry: PilotReleaseRegistryService) {}

  /** POST: activate the release (200, also when it is already the current one). */
  @Post(":releaseId/activate")
  @HttpCode(200)
  // RT-1298: platformActivatePilotRelease (audited change).
  @ConsoleRateLimit("write")
  @Header("Cache-Control", "no-store")
  async activate(
    @Req() request: AuthedRequest,
    @Param("releaseId", new ZodValidationPipe(ReleaseIdParamSchema)) releaseId: string,
  ): Promise<PilotReleaseBody> {
    const principal = request.principal;
    if (principal?.kind !== "session") throw new UnauthorizedException("Unauthorized");
    try {
      return await this.registry.activate({ releaseId, userId: principal.userId, requestId: request.requestId ?? null });
    } catch (err) {
      return throwRegistryHttpError(err);
    }
  }
}
