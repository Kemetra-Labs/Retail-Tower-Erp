/**
 * PilotReleaseWritesController: RT-1298 runtime of `platformRegisterPilotRelease`
 * and `platformWithdrawPilotRelease` (`pos-pilot-releases.openapi.yaml`):
 *
 *   POST /api/v1/platform/pos-pilot-releases
 *   POST /api/v1/platform/pos-pilot-releases/{releaseId}/withdraw
 *
 * Caller: the owner-run promotion workflow, authenticated by its GitHub OIDC
 * token only (`PromotionWriterGuard`, owner decision D-5a). The class is
 * `@Public()` for the global cookie guard and the OIDC guard IS the
 * authentication: a Console cookie, a device token or any other credential is
 * 401. There is no Origin check and no rate-limit class: the caller is a CI job
 * with no browser. The route is not counted by the pre-auth reporter (that is
 * part of the cookie guard it skips), so there is no per-IP counting here;
 * what is bounded is the outbound key set fetches (a refetch cooldown).
 *
 * Guards run before pipes, so an unauthenticated caller never learns the body
 * schema. The register body's `promotionRunUrl` must name the run that holds
 * the token, in the token's own repository (`run_id`, `repository`): a token for
 * one run cannot register a row for another run or another repository.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { Public } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  IdempotencyKeySchema,
  PilotReleaseRegistrationSchema,
  ReleaseIdParamSchema,
  type PilotReleaseRegistration,
} from "./dto";
import { throwRegistryHttpError } from "./pilot-release-registry.http";
import type { PilotReleaseBody } from "./pilot-release-registry.rows";
import { PilotReleaseRegistryService } from "./pilot-release-registry.service";
import { PromotionWriterGuard, type PromotionRequest } from "./promotion-writer.guard";
import type { PromotionPrincipal } from "./promotion-oidc.verifier";

/** The request after the guard: the verified principal is attached. */
type WriteRequest = PromotionRequest & { readonly requestId?: string };

/** The verified principal the guard attached; a missing one is a wiring bug, never a pass. */
function principalOf(request: WriteRequest): PromotionPrincipal {
  if (request.promotionPrincipal === undefined) throw new ForbiddenException({ code: "forbidden", message: "Forbidden" });
  return request.promotionPrincipal;
}

/** The url of the verified workflow run. */
function runUrlOf(principal: PromotionPrincipal): string {
  return `https://github.com/${principal.repository}/actions/runs/${principal.runId}`;
}

/** True when the url is the verified run (or one of its attempts) in the token's own repository. */
function namesRun(url: string, principal: PromotionPrincipal): boolean {
  const run = runUrlOf(principal);
  return url === run || url.startsWith(`${run}/attempts/`);
}

/** The registry writes the promotion workflow makes. */
@Controller("api/v1/platform/pos-pilot-releases")
@Public()
@UseGuards(PromotionWriterGuard)
export class PilotReleaseWritesController {
  constructor(private readonly registry: PilotReleaseRegistryService) {}

  /** POST: register a release (201 when written, 200 when the stored row already equals the body). */
  @Post()
  @Header("Cache-Control", "no-store")
  async register(
    @Req() request: WriteRequest,
    @Body(new ZodValidationPipe(PilotReleaseRegistrationSchema)) body: PilotReleaseRegistration,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PilotReleaseBody> {
    // A missing or malformed key is a 400 (the ZodError); a retry reuses it and, being an equal body, is a 200.
    IdempotencyKeySchema.parse(request.headers["idempotency-key"]);
    const principal = principalOf(request);
    // The token is for one run of its repository: it cannot register a row that names another run or repository.
    if (!namesRun(body.promotionRunUrl, principal)) {
      throw new ForbiddenException({ code: "forbidden", message: "Forbidden" });
    }
    try {
      const result = await this.registry.register({ body, actor: principal.actor, requestId: request.requestId ?? null });
      res.status(result.created ? 201 : 200);
      return result.release;
    } catch (err) {
      return throwRegistryHttpError(err);
    }
  }

  /** POST: withdraw a release for good (200, also when it was already withdrawn). */
  @Post(":releaseId/withdraw")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async withdraw(
    @Req() request: WriteRequest,
    @Param("releaseId", new ZodValidationPipe(ReleaseIdParamSchema)) releaseId: string,
  ): Promise<PilotReleaseBody> {
    const principal = principalOf(request);
    try {
      return await this.registry.withdraw({
        releaseId,
        actor: principal.actor,
        runUrl: runUrlOf(principal),
        requestId: request.requestId ?? null,
      });
    } catch (err) {
      return throwRegistryHttpError(err);
    }
  }
}
