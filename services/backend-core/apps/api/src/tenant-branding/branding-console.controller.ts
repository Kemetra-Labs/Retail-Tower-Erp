/**
 * TenantBrandingConsoleController — RT-473 S2: the Console operations of
 * tenant-branding.openapi.yaml.
 *
 *   GET    /api/v1/tenants/{tenant_id}/logo          consoleGetTenantLogo
 *   POST   /api/v1/tenants/{tenant_id}/logo/preview  consolePreviewTenantLogo
 *   PUT    /api/v1/tenants/{tenant_id}/logo          consolePutTenantLogo
 *   DELETE /api/v1/tenants/{tenant_id}/logo          consoleDeleteTenantLogo
 *
 * Auth (FR-01): the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard`
 * (any bearer-only request is 401; a cookie write without a trusted `Origin`
 * is 403 `origin_rejected`, RT-430), then `TenantContextGuard`, then
 * `RolesGuard` (`owner` / `tenant_admin`, default deny → 404). A `{tenant_id}`
 * that is not the session's tenant is the same non-disclosing 404 (§II, §XII).
 *
 * The upload body is read in the handler, after the guards (`readLogoBody`).
 * No `@Idempotent`: the contract declares no Idempotency-Key; replays are
 * absorbed by `preview_version` and `expected_revision` (FR-14, FR-14a).
 * Writes audit in their own transaction (FR-15); the read is audited by the
 * interceptor; the preview audits nothing.
 */
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import {
  NoQuerySchema,
  PathIdSchema,
  RemoveQuerySchema,
  SaveQuerySchema,
  type RemoveQuery,
  type SaveQuery,
} from "./branding.query";
import type { LogoPreviewBody, TenantBrandingBody } from "./branding.projections";
import { LogoConflictError, TenantBrandingService, type WriteInput } from "./branding.service";
import { readLogoBody } from "./logo-body";
import { SVG_RENDER_TIMEOUT_MS } from "./logo-config";
import { LogoRejectedError, REJECTION_MESSAGES } from "./logo-refusal";
import { RenderQueueFullError } from "./render-queue";

const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

const CONFLICT_MESSAGES: Readonly<Record<LogoConflictError["code"], string>> = {
  logo_preview_mismatch: "The file no longer produces the previewed version. Preview it again.",
  logo_changed_concurrently: "The logo changed since it was read. Reload and retry.",
};

const LOGO = "api/v1/tenants/:tenant_id/logo";

type UploadRequest = TenantContextRequest & Request;

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard)
@Roles("owner", "tenant_admin")
export class TenantBrandingConsoleController {
  constructor(private readonly service: TenantBrandingService) {}

  @Get(LOGO)
  @Auditable("tenant.logo.read")
  read(
    @Req() request: TenantContextRequest,
    @Param("tenant_id") tenantId: string,
    @Query(new ZodValidationPipe(NoQuerySchema)) _query: Record<string, never>,
  ): Promise<TenantBrandingBody> {
    const id = sessionTenant(request, tenantId);
    annotateAudit(request, { tenant_id: id });
    return this.service.read(id);
  }

  @Post(`${LOGO}/preview`)
  @HttpCode(200)
  @ConsoleRateLimit("jobOrPreview")
  async preview(
    @Req() request: UploadRequest,
    @Param("tenant_id") tenantId: string,
    @Query(new ZodValidationPipe(NoQuerySchema)) _query: Record<string, never>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoPreviewBody> {
    sessionTenant(request, tenantId);
    const bytes = await readLogoBody(request);
    return mapErrors(res, () => this.service.preview(bytes));
  }

  @Put(LOGO)
  @ConsoleRateLimit("jobOrPreview")
  async save(
    @Req() request: UploadRequest,
    @Param("tenant_id") tenantId: string,
    @Query(new ZodValidationPipe(SaveQuerySchema)) query: SaveQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TenantBrandingBody> {
    const input = writer(request, sessionTenant(request, tenantId), query.expected_revision);
    const bytes = await readLogoBody(request);
    return mapErrors(res, () => this.service.save(input, bytes, query.preview_version));
  }

  @Delete(LOGO)
  remove(
    @Req() request: TenantContextRequest,
    @Param("tenant_id") tenantId: string,
    @Query(new ZodValidationPipe(RemoveQuerySchema)) query: RemoveQuery,
  ): Promise<TenantBrandingBody> {
    const input = writer(request, sessionTenant(request, tenantId), query.expected_revision);
    return mapErrors(null, () => this.service.remove(input));
  }
}

/** The session's tenant, when `{tenant_id}` names it; any other tenant is the 404. */
function sessionTenant(request: TenantContextRequest, tenantId: string): string {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  const parsed = PathIdSchema.safeParse(tenantId);
  if (!parsed.success) throw new BadRequestException({ code: "validation_error", message: "tenant_id must be a valid UUID." });
  if (parsed.data !== ctx.tenantId.toLowerCase()) throw new NotFoundException(NOT_FOUND);
  return ctx.tenantId;
}

function writer(request: TenantContextRequest, tenantId: string, expectedRevision: number): WriteInput {
  const actorUserId = request.context?.userId ?? null;
  if (actorUserId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId, actorUserId, requestId: request.requestId ?? null, expectedRevision };
}

/**
 * The logo queue or the SVG renderer is at capacity (render-queue.ts): the
 * contract's retryable `429 rate_limited`
 * (declared on every cookieAuth operation), with `Retry-After` and
 * `Cache-Control: no-store`; `X-Request-Id` is set for every request.
 */
function rendererBusy(res: Response | null): HttpException {
  res?.setHeader("Retry-After", String(Math.ceil(SVG_RENDER_TIMEOUT_MS / 1000)));
  res?.setHeader("Cache-Control", "no-store");
  return new HttpException({ code: "rate_limited", message: "The image renderer is busy. Retry shortly." }, 429);
}

/** The contract's 4xx for a pipeline or precondition refusal, or null (→ 500). */
function toHttpError(err: unknown, res: Response | null): HttpException | null {
  if (err instanceof RenderQueueFullError) return rendererBusy(res);
  if (err instanceof LogoRejectedError) {
    return new HttpException(
      {
        code: err.code,
        message: REJECTION_MESSAGES[err.code],
        ...(err.construct !== null ? { details: { construct: err.construct } } : {}),
      },
      422,
    );
  }
  if (err instanceof LogoConflictError) return new HttpException({ code: err.code, message: CONFLICT_MESSAGES[err.code] }, 409);
  return null;
}

async function mapErrors<T>(res: Response | null, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw toHttpError(err, res) ?? err;
  }
}
