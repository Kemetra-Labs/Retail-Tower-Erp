/**
 * RedistributionProposalsController — Jira RT-1600 (W9 slice A, N3): the six operations of the RT-1599 contract
 * `inventory/redistribution-proposals.yaml` under `/api/inventory/v1/redistribution-proposals`.
 *
 *   POST /                         createRedistributionProposal   201 proposed, 200 nothing_to_move   jobOrPreview
 *   GET  /                         listRedistributionProposals                                        cheapRead
 *   GET  /{proposalId}             getRedistributionProposal                                          cheapRead
 *   POST /{proposalId}/review      reviewRedistributionProposal   200 (shadow)                        write
 *   POST /{proposalId}/accept      acceptRedistributionProposal   200 (live)                          write
 *   POST /{proposalId}/reject      rejectRedistributionProposal   200                                 write
 *
 * Guards, in order: the human cookie session, the tenant context, the role (owner / tenant_admin; any other role is
 * the non-disclosing 404, the `RolesGuard` default), then the dark-launch allowlists (`RedistributionPhaseGuard`: off
 * the shadow list, or off the live list for accept, is the same 404). The service adds the store-scope gate: a
 * store-scoped owner or tenant_admin is the same 404 (`redistribution-scope.ts`). The guards run before the idempotency
 * interceptor, so a refusal claims no key. Every command is `@Idempotent('required')`. Bodies are strict Zod DTOs;
 * tenant and actor come from the session, never the body.
 *
 * Imports of other modules go through their root ports (RT-1453).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { Roles, RolesGuard, SessionOnlyAdminGuard } from '../../auth';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ConsoleRateLimit } from '../../console-rate-limit';
import { TenantContextGuard, type TenantContextRequest } from '../../context';
import { Idempotent } from '../../idempotency';
import { RedistributionPhaseGuard, RequiresLivePhase } from './redistribution-phase.guard';
import { RedistributionProposalsService, type RedistributionCaller } from './redistribution-proposals.service';

const Uuid = z.string().uuid();
const distinct = (ids: readonly string[]): boolean => new Set(ids.map((id) => id.toLowerCase())).size === ids.length;

/** Contract `ComputeRedistributionProposalCommand`. */
const ComputeSchema = z
  .object({ storeIds: z.array(Uuid).min(2).max(200).refine(distinct, 'storeIds must be unique').optional() })
  .strict();

/** Contract `ReviewRedistributionProposalCommand`. */
const ReviewSchema = z
  .object({
    lineDecisions: z
      .array(
        z
          .object({
            lineId: Uuid,
            decision: z.enum(['would_accept', 'would_reject']),
            note: z.string().min(1).max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

/** Contract `AcceptRedistributionProposalCommand`. */
const AcceptSchema = z
  .object({ lineIds: z.array(Uuid).min(1).max(1000).refine(distinct, 'lineIds must be unique') })
  .strict();

/** Contract `RejectRedistributionProposalCommand`. */
const RejectSchema = z.object({ reason: z.string().min(1).max(500).regex(/\S/, 'reason must not be blank') }).strict();

const ListQuerySchema = z
  .object({
    state: z.enum(['open', 'reviewed', 'partially_accepted', 'accepted', 'rejected', 'expired', 'superseded']).optional(),
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const ProposalId = (): ParameterDecorator => Param('proposalId', new ZodValidationPipe(Uuid));

const PROPOSALS = 'api/inventory/v1/redistribution-proposals';
const PROPOSAL = `${PROPOSALS}/:proposalId`;

/** The session's tenant and actor; a request without both is 401 (the guards normally refuse it first). */
function sessionCaller({ context }: TenantContextRequest): RedistributionCaller {
  const tenantId = context?.tenantId ?? null;
  const userId = context?.userId ?? null;
  if (context === undefined || tenantId === null || userId === null) throw new UnauthorizedException('Unauthorized');
  return { tenantId, userId, context };
}

@Controller()
// The contract's only security scheme is the `dp2_session` cookie: any bearer, even a privileged `dashboard_api`
// token, is 401 before the tenant, role or allowlist checks (review, PR #901).
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard, RedistributionPhaseGuard)
export class RedistributionProposalsController {
  constructor(private readonly service: RedistributionProposalsService) {}

  @Post(PROPOSALS)
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin')
  @ConsoleRateLimit('jobOrPreview')
  @Idempotent('required')
  async createRedistributionProposal(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(ComputeSchema)) body: z.infer<typeof ComputeSchema>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.service.compute(sessionCaller(request), body.storeIds);
    // 201 when a proposal was stored, 200 when nothing needs to move (the interceptor replays the status it saw).
    response.status(result.status);
    return result.body;
  }

  @Get(PROPOSALS)
  @Roles('owner', 'tenant_admin')
  @ConsoleRateLimit('cheapRead')
  async listRedistributionProposals(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListQuerySchema)) query: z.infer<typeof ListQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return await this.service.list(sessionCaller(request), {
      state: query.state ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
  }

  @Get(PROPOSAL)
  @Roles('owner', 'tenant_admin')
  @ConsoleRateLimit('cheapRead')
  async getRedistributionProposal(
    @Req() request: TenantContextRequest,
    @ProposalId() proposalId: string,
  ): Promise<Record<string, unknown>> {
    return await this.service.get(sessionCaller(request), proposalId);
  }

  @Post(`${PROPOSAL}/review`)
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'tenant_admin')
  @ConsoleRateLimit('write')
  @Idempotent('required')
  async reviewRedistributionProposal(
    @Req() request: TenantContextRequest,
    @ProposalId() proposalId: string,
    @Body(new ZodValidationPipe(ReviewSchema)) body: z.infer<typeof ReviewSchema>,
  ): Promise<Record<string, unknown>> {
    return await this.service.review(sessionCaller(request), proposalId, body.lineDecisions);
  }

  @Post(`${PROPOSAL}/accept`)
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'tenant_admin')
  @ConsoleRateLimit('write')
  @RequiresLivePhase()
  @Idempotent('required')
  async acceptRedistributionProposal(
    @Req() request: TenantContextRequest,
    @ProposalId() proposalId: string,
    @Body(new ZodValidationPipe(AcceptSchema)) body: z.infer<typeof AcceptSchema>,
  ): Promise<Record<string, unknown>> {
    return await this.service.accept(sessionCaller(request), proposalId, body.lineIds);
  }

  @Post(`${PROPOSAL}/reject`)
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'tenant_admin')
  @ConsoleRateLimit('write')
  @Idempotent('required')
  async rejectRedistributionProposal(
    @Req() request: TenantContextRequest,
    @ProposalId() proposalId: string,
    @Body(new ZodValidationPipe(RejectSchema)) body: z.infer<typeof RejectSchema>,
  ): Promise<Record<string, unknown>> {
    return await this.service.reject(sessionCaller(request), proposalId, body.reason);
  }
}
