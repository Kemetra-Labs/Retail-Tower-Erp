/**
 * RT-1358 — the four feed operations of `provisioning-feed.yaml`, behind
 * `connectorProvisionerBearer` only (`ProvisionerAuthGuard`):
 *
 *   GET  /api/connector/v1/erpnext/provisioning/requests                       connectorPullProvisioningRequests
 *   POST /api/connector/v1/erpnext/provisioning/requests/{requestId}/steps      connectorAckProvisioningStep
 *   POST /api/connector/v1/erpnext/provisioning/requests/{requestId}/credential connectorIssueProvisionedCredential
 *   POST /api/connector/v1/erpnext/provisioning/requests/{requestId}/outcome    connectorCompleteProvisioning
 *
 * Tenant, actor and lease come from the principal and the request row, never the
 * body or query. The credential route has no `Idempotency-Key`: its repeat rule is
 * the rotation of a never-presented credential, because a replay would have to
 * store the secret. Every refusal there is the same non-disclosing 404.
 */
import { Body, Controller, Get, Header, HttpCode, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";

import { Public } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Idempotent } from "../idempotency/idempotent.decorator";
import {
  OutcomeBodySchema,
  type OutcomeBody,
  type ProvisioningRequestItem,
  PullQuerySchema,
  type PullQuery,
  StepAckBodySchema,
  type StepAckBody,
} from "./dto/provisioning.dto";
import { ProvisionerAuthGuard, type ProvisionerRequest } from "./provisioner-auth.guard";
import { type IssuedCredential, ProvisioningFeedService } from "./provisioning-feed.service";

const UuidPipe = new ZodValidationPipe(z.string().uuid());

function hostOf(req: ProvisionerRequest): string {
  if (!req.provisioner) throw new UnauthorizedException("Unauthorized");
  return req.provisioner.hostLabel;
}

// `@Public()` only opts out of the global opaque-bearer guard, which refuses every scope outside
// BEARER_AUTH_SCOPES: `ProvisionerAuthGuard` is this controller's own, fail-closed authenticator.
@Public()
@Controller("api/connector/v1/erpnext/provisioning")
@UseGuards(ProvisionerAuthGuard)
export class ProvisioningFeedController {
  constructor(private readonly service: ProvisioningFeedService) {}

  @Get("requests")
  @Header("Cache-Control", "no-store")
  async pull(
    @Req() req: ProvisionerRequest,
    @Query(new ZodValidationPipe(PullQuerySchema)) query: PullQuery,
  ): Promise<{ items: ProvisioningRequestItem[]; cursor: string }> {
    return await this.service.pullRequests(hostOf(req), query);
  }

  @Post("requests/:requestId/steps")
  @HttpCode(200)
  @Idempotent("required")
  async ack(
    @Req() req: ProvisionerRequest,
    @Param("requestId", UuidPipe) requestId: string,
    @Body(new ZodValidationPipe(StepAckBodySchema)) body: StepAckBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ requestId: string; step: string; leaseExpiresAt: string }> {
    const out = await this.service.acknowledgeStep(hostOf(req), requestId, body);
    if (out.replayed) res.setHeader("Idempotent-Replayed", "true");
    return out.result;
  }

  @Post("requests/:requestId/credential")
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  async credential(@Req() req: ProvisionerRequest, @Param("requestId", UuidPipe) requestId: string): Promise<IssuedCredential> {
    const issued = await this.service.issueCredential(hostOf(req), requestId, req.requestId ?? null);
    if (issued === null) throw new NotFoundException({ code: "not_found", message: "Not Found" });
    return issued;
  }

  @Post("requests/:requestId/outcome")
  @HttpCode(200)
  @Idempotent("required")
  async outcome(
    @Req() req: ProvisionerRequest,
    @Param("requestId", UuidPipe) requestId: string,
    @Body(new ZodValidationPipe(OutcomeBodySchema)) body: OutcomeBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ requestId: string; outcome: string }> {
    const out = await this.service.reportOutcome(hostOf(req), requestId, body);
    if (out.replayed) res.setHeader("Idempotent-Replayed", "true");
    return { requestId: out.requestId, outcome: out.outcome };
  }
}
