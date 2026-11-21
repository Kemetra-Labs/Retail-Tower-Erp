/**
 * ManagerSalesController — RT-1539 (W8 P-06): the runtime of the P-05 contract
 * `ai-manager-sales-explain.openapi.yaml` 1.0.0-draft.
 *
 *   POST /api/v1/ai/manager-sales/explain  consoleExplainSales
 *
 * Auth: the `console-sales` chain. The HUMAN `cookieAuth` session only (`SessionOnlyAdminGuard`: every
 * bearer is 401, and a cookie POST's `Origin` is checked, 403 `origin_rejected`), `TenantContextGuard`,
 * then `RolesGuard` + `@Roles("owner", "tenant_admin", "store_manager")` (default deny -> 404) and
 * `NoPlatformAdminGuard` (a session platform admin is the same 404). The guards run before request
 * validation, so a refused role is a 404 for any input.
 *
 * Order (the contract's denial order): validate -> kill switch (200 `feature_disabled_system`, before
 * any scope check, so AI off reveals nothing about stores) -> role-aware store scope (404,
 * `scope_too_large` 400; owner and tenant_admin are not narrowed by the active store) -> the Gateway:
 * kill switch again, entitlement, the deterministic match (a refusal ends there, nothing reserved),
 * quota reservation, evidence build, render, settle. The Gateway never rejects; its result is mapped
 * to `answer | refusal | unavailable`, or the 404 for `not_authorized` / `store_out_of_scope`.
 *
 * Idempotency: `@Idempotent("required")`; the key is also the Gateway's reservation key. After a 5xx
 * the client MUST mint a NEW Idempotency-Key: the failed run's reservation was released, but its key
 * is spent (a same-key retry replays the stored outcome or answers 425/409, never runs again).
 *
 * Audit: exactly ONE `ai.manager_sales.explain` event per 200 `answer`, never for a refusal or an
 * `unavailable`. `@Auditable` fires on every 2xx and cannot skip, so the event is enqueued here, after
 * the answer, through the same enqueuer; it is a fire-and-forget (a failure is logged by class and
 * never changes the response). The metadata is the template id, the scope mode, the store count and
 * the range; never a figure, a store name or the question text. The action is deliberately not in the
 * read-action registry (`audit-action-kinds.ts` is GET-only).
 *
 * Logging: nothing here logs the question, a name or a figure.
 */
import { randomUUID } from "node:crypto";

import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Optional,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../audit";
import { Roles, RolesGuard, SessionOnlyAdminGuard } from "../../auth";
import { ROOT_LOGGER } from "../../common/logging.interceptor";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../../console-rate-limit";
import { TenantContextGuard, type TenantContextRequest } from "../../context";
import { Idempotent } from "../../idempotency";
import { AI_GATEWAY_RUNTIME } from "../ai.tokens";
import { AiGateway } from "../gateway/ai-gateway.service";
import type { AiGatewayRuntime } from "../gateway/ai-gateway.types";
import { MSX_FEATURE_ID } from "./msx.constants";
import type { ManagerSalesAnswer } from "./msx.output";
import { ManagerSalesExplainRequestSchema, type ManagerSalesExplainRequest } from "./msx.request";
import { mapResult, type ExplainBody } from "./msx.response";
import { ManagerSalesScope, NOT_FOUND_BODY, NoPlatformAdminGuard } from "./msx.scope";

const MSX_AUDIT_ACTION = "ai.manager_sales.explain";

/** The `ai.manager_sales.explain` metadata: never a figure, a name or the question. */
function auditMetadataOf(answer: ManagerSalesAnswer): Record<string, unknown> {
  return {
    template_id: answer.templateId,
    scope_mode: answer.scope.mode,
    store_count: answer.scope.storeRefs.length,
    from: answer.period.from,
    to: answer.period.to,
  };
}

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ManagerSalesController {
  constructor(
    private readonly gateway: AiGateway,
    private readonly scope: ManagerSalesScope,
    @Inject(AI_GATEWAY_RUNTIME) private readonly runtime: AiGatewayRuntime,
    @Optional() @Inject(AUDIT_JOB_ENQUEUER) private readonly audit?: AuditJobEnqueuer,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {}

  /** POST — a deterministic, cited, tier-0 answer, a typed refusal, or a typed gateway `unavailable`. */
  @Post("api/v1/ai/manager-sales/explain")
  @UseGuards(RolesGuard, NoPlatformAdminGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Idempotent("required")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  // RT-1526 §7: an aggregate over up to 31 business days of every store in scope.
  @ConsoleRateLimit("expensiveRead")
  async explain(
    @Req() request: TenantContextRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(ManagerSalesExplainRequestSchema)) body: ManagerSalesExplainRequest,
  ): Promise<ExplainBody> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    // The kill switch comes first (the contract's step 0): with AI off, a caller learns nothing about
    // stores, so the scope 404 never fires. The Gateway checks it again.
    if (!this.runtime.isEnabled()) return { kind: "unavailable", family: "gateway", code: "feature_disabled_system" };
    const effective = await this.scope.assertAllowed(ctx, ctx.tenantId, body.storeIds);

    const started = Date.now();
    const result = await this.gateway.run<ManagerSalesAnswer>(MSX_FEATURE_ID, {
      ctx: effective,
      storeIds: body.storeIds,
      correlationId: request.requestId ?? randomUUID(),
      params: { ...body },
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });

    const mapped = mapResult(result);
    if (mapped.kind === "not_found") throw new NotFoundException(NOT_FOUND_BODY);
    if (mapped.kind === "fault") throw new Error(`manager sales run failed: ${mapped.reason}`);
    if (mapped.body.kind !== "answer") return mapped.body;

    const answer: ManagerSalesAnswer = {
      ...mapped.body,
      ledger: { ...mapped.body.ledger, latency_ms: Math.max(0, Date.now() - started) },
    };
    this.emitAudit(request, ctx.tenantId, answer);
    return answer;
  }

  /** Fire-and-forget: the response never waits for, or fails on, the audit queue. */
  private emitAudit(request: TenantContextRequest, tenantId: string, answer: ManagerSalesAnswer): void {
    if (this.audit === undefined) return;
    const logFailure = (err: unknown): void => {
      // Class only, never the payload: an audit failure is visible but never rejects the request.
      this.logger?.error(
        { component: "manager_sales.audit", action: MSX_AUDIT_ACTION, request_id: request.requestId ?? null, err_class: err instanceof Error ? err.name : typeof err },
        "ManagerSales: audit enqueue failed",
      );
    };
    try {
      this.audit
        .enqueue({
          actor_user_id: request.principal?.userId ?? null,
          actor_label: null,
          tenant_id: tenantId,
          store_id: request.context?.storeId ?? null,
          action: MSX_AUDIT_ACTION,
          target_type: null,
          target_id: null,
          request_id: request.requestId ?? null,
          metadata: auditMetadataOf(answer),
        })
        .catch(logFailure);
    } catch (err) {
      logFailure(err);
    }
  }
}
