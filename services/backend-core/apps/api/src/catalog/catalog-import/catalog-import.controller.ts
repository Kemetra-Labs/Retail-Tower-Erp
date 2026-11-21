/**
 * CatalogImportController — RT-1505 / RT-1507 (spec 049 slices S4, S5): the operations of
 * `catalog/catalog-import.yaml` 1.0.6-draft that are served.
 *
 *   POST /api/v1/catalog/imports                                    consoleUploadCatalogImport     (RT-1505 part A)
 *   GET  /api/v1/catalog/imports/{batchId}                          consoleGetCatalogImport        (part A)
 *   PUT  /api/v1/catalog/imports/{batchId}/mapping                  consoleSetCatalogImportMapping (part B)
 *   POST /api/v1/catalog/imports/{batchId}/validate                 consoleValidateCatalogImport   (part B)
 *   GET  /api/v1/catalog/imports/{batchId}/rows                     consoleListCatalogImportRows   (part B)
 *   PUT  /api/v1/catalog/imports/{batchId}/rows/{rowNumber}/resolution  consoleResolveCatalogImportRow (RT-1507)
 *   GET  /api/v1/catalog/imports/{batchId}/preview                  consoleGetCatalogImportPreview (RT-1507)
 *   POST /api/v1/catalog/imports/{batchId}/publish                  consolePublishCatalogImport    (RT-1507)
 *   POST /api/v1/catalog/imports/{batchId}/cancel                   consoleCancelCatalogImport     (RT-1507)
 *
 * The other three operations stay `x-runtime-status: contract-only` (no route is registered for them): the file replace,
 * the error report and the template.
 *
 * Auth: `SessionOnlyAdminGuard` (the human cookie session only; every bearer is
 * 401; a write without a trusted `Origin` is 403 `origin_rejected`, RT-430),
 * then `TenantContextGuard`, then `RolesGuard`: `owner` / `tenant_admin` only
 * (Product identity, decision 449). Any other role, a batch of another tenant
 * and an absent batch are the same non-disclosing 404. The tenant and the actor
 * are the session's (§II, §XII).
 *
 * The upload takes the raw file bytes: `ImportUploadIntakeGuard` (last, so it
 * runs after the session, tenant and role guards, on headers alone) reads them
 * and the shared `@Idempotent("required")` interceptor replays on the file's
 * SHA-256 + the canonical query (see the guard). The audit row is the service's,
 * in the write's transaction, so no handler carries `@Auditable`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
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

import type { Response } from "express";

import { Roles, RolesGuard, SessionOnlyAdminGuard } from "../../auth";
import { ConsoleRateLimit } from "../../console-rate-limit";
import { TenantContextGuard, type TenantContextRequest } from "../../context";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Idempotent } from "../../idempotency";
import {
  CatalogImportService,
  ImportBatchNotFoundError,
  ImportBatchOpenError,
  type ImportWriteInput,
} from "./catalog-import.service";
import type { CatalogImportBatchBody } from "./catalog-import.projections";
import { CatalogImportPublishService, type PublishResultBody } from "./catalog-import.publish.service";
import { CatalogImportReviewService, type PreviewBody, type RowResolvedBody } from "./catalog-import.review.service";
import { PublishBodySchema, ResolveBodySchema, RowNumberSchema, type PublishBody, type ResolveBody } from "./import-resolve-body";
import {
  IMPORT_BATCH_REFUSAL_MESSAGES,
  ImportBatchRefusedError,
  InvalidImportCursorError,
} from "./import-batch-refusal";
import { ImportFileRejectedError, IMPORT_FILE_MESSAGES } from "./import-file-rejected";
import { SetMappingBodySchema, ValidateBodySchema, type SetMappingBody, type ValidateBody } from "./import-mapping";
import { RowsQuerySchema, type CatalogImportRowBody } from "./import-row-page";
import { ImportUploadIntakeGuard, type ImportUploadRequest } from "./import-upload-intake.guard";
import { BatchIdSchema } from "./import-upload.query";

const IMPORTS = "api/v1/catalog/imports";

/** The one 404 body of this surface, equal to the `RolesGuard` refusal (§II, §XII). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

type ImportRequest = TenantContextRequest & ImportUploadRequest;

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard)
@Roles("owner", "tenant_admin")
export class CatalogImportController {
  constructor(
    private readonly service: CatalogImportService,
    private readonly review: CatalogImportReviewService,
    private readonly publisher: CatalogImportPublishService,
  ) {}

  @Post(IMPORTS)
  @HttpCode(201)
  @UseGuards(ImportUploadIntakeGuard)
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("jobOrPreview")
  async upload(@Req() request: ImportRequest): Promise<CatalogImportBatchBody> {
    const upload = request.importUpload;
    // The intake guard sets it on every request that reaches the handler; its absence is a wiring bug (500).
    const slot = request.importUploadSlot;
    if (upload === undefined || slot === undefined) throw new Error("import upload intake guard did not run");
    // The client may have gone while the idempotency interceptor ran: its slot is already free, so do no work.
    if (!slot.begin()) throw new BadRequestException({ code: "validation_error", message: "The request was abandoned." });
    try {
      return await this.service.upload(writer(request), upload);
    } catch (err) {
      throw toHttpError(err) ?? err;
    } finally {
      // The slot is held through the parse and the write, even when the client aborted.
      slot.end();
    }
  }

  @Get(`${IMPORTS}/:batchId`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  async get(@Req() request: TenantContextRequest, @Param("batchId") batchId: string): Promise<CatalogImportBatchBody> {
    const id = parseBatchId(batchId);
    return guarded(() => this.service.get(sessionTenant(request), id));
  }

  @Put(`${IMPORTS}/:batchId/mapping`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  async setMapping(
    @Req() request: TenantContextRequest,
    @Param("batchId") batchId: string,
    @Body(new ZodValidationPipe(SetMappingBodySchema)) body: SetMappingBody,
  ): Promise<CatalogImportBatchBody> {
    const id = parseBatchId(batchId);
    return guarded(() => this.service.setMapping(writer(request), id, body));
  }

  @Post(`${IMPORTS}/:batchId/validate`)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("jobOrPreview")
  async validate(
    @Req() request: TenantContextRequest,
    @Param("batchId") batchId: string,
    @Body(new ZodValidationPipe(ValidateBodySchema)) body: ValidateBody,
  ): Promise<CatalogImportBatchBody> {
    const id = parseBatchId(batchId);
    return guarded(() => this.service.validate(writer(request), id, body.expectedVersion));
  }

  @Get(`${IMPORTS}/:batchId/rows`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("expensiveRead")
  async rows(
    @Req() request: TenantContextRequest,
    @Param("batchId") batchId: string,
    @Query() query: unknown,
  ): Promise<{ batchId: string; version: number; items: CatalogImportRowBody[]; nextCursor: string | null }> {
    const id = parseBatchId(batchId);
    // A malformed or unknown query key is a 400 (the ZodError is the global filter's), before any read.
    const parsed = RowsQuerySchema.parse(query);
    return guarded(() => this.service.listRows(sessionTenant(request), id, parsed));
  }

  @Put(`${IMPORTS}/:batchId/rows/:rowNumber/resolution`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  async resolve(
    @Req() request: TenantContextRequest,
    @Param("batchId") batchId: string,
    @Param("rowNumber") rowNumber: string,
    @Body(new ZodValidationPipe(ResolveBodySchema)) body: ResolveBody,
  ): Promise<RowResolvedBody> {
    const id = parseBatchId(batchId);
    const row = parseRowNumber(rowNumber);
    return guarded(() => this.review.resolveRow(writer(request), id, row, body));
  }

  @Get(`${IMPORTS}/:batchId/preview`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("expensiveRead")
  async preview(@Req() request: TenantContextRequest, @Param("batchId") batchId: string): Promise<PreviewBody> {
    const id = parseBatchId(batchId);
    return guarded(() => this.review.preview(sessionTenant(request), id));
  }

  @Post(`${IMPORTS}/:batchId/publish`)
  @HttpCode(200)
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("jobOrPreview")
  async publish(
    @Req() request: TenantContextRequest,
    @Res({ passthrough: true }) res: Response,
    @Param("batchId") batchId: string,
    @Body(new ZodValidationPipe(PublishBodySchema)) body: PublishBody,
  ): Promise<PublishResultBody> {
    const id = parseBatchId(batchId);
    const outcome = await guarded(() => this.publisher.publish(writer(request), id, body));
    // A publish of an already published batch under a new key is a replay of its stored result.
    if (outcome.replayed) res.setHeader("Idempotent-Replayed", "true");
    return outcome.body;
  }

  @Post(`${IMPORTS}/:batchId/cancel`)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  async cancel(
    @Req() request: TenantContextRequest,
    @Param("batchId") batchId: string,
    @Body(new ZodValidationPipe(ValidateBodySchema)) body: ValidateBody,
  ): Promise<CatalogImportBatchBody> {
    const actor = writer(request);
    const { expectedVersion } = body;
    return guarded(() => this.service.cancel(actor, parseBatchId(batchId), expectedVersion));
  }
}

/** The session's tenant (§XII: never from the request), or 401. */
function sessionTenant(request: TenantContextRequest): string {
  const ctx = request.context;
  if (ctx === undefined || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return ctx.tenantId;
}

function writer(request: TenantContextRequest): ImportWriteInput {
  const actorUserId = request.context?.userId ?? null;
  if (actorUserId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: sessionTenant(request), actorUserId, requestId: request.requestId ?? null };
}

/** A path id in lower case, or 400 `validation_error` before any read (a request-shape error: it discloses nothing). */
function parseBatchId(value: string): string {
  if (!BatchIdSchema.safeParse(value).success) {
    throw new BadRequestException({ code: "validation_error", message: "batchId must be a valid UUID" });
  }
  return value.toLowerCase();
}

/** Runs a service call and answers the contract's 4xx for a refusal it raised (anything else is a 500). */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw toHttpError(err) ?? err;
  }
}

/** A path row number from 2, or 400 `validation_error` before any read. */
function parseRowNumber(value: string): number {
  const parsed = RowNumberSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: "validation_error", message: "rowNumber must be an integer of 2 or more" });
  return parsed.data;
}

/** The contract's 4xx for a refusal the service threw, or null (a 500). */
function toHttpError(err: unknown): HttpException | null {
  if (err instanceof ImportBatchNotFoundError) return new NotFoundException(NOT_FOUND);
  if (err instanceof ImportBatchOpenError) {
    return new HttpException(
      { code: "import_batch_open", message: "The tenant already has an open import batch. Resume or cancel it first.", openBatchId: err.openBatchId },
      409,
    );
  }
  if (err instanceof ImportBatchRefusedError) {
    return new HttpException({ code: err.code, message: IMPORT_BATCH_REFUSAL_MESSAGES[err.code] }, err.status);
  }
  if (err instanceof InvalidImportCursorError) {
    return new BadRequestException({ code: "validation_error", message: err.message });
  }
  if (err instanceof ImportFileRejectedError) {
    const status = err.code === "validation_error" ? 400 : 422;
    return new HttpException({ code: err.code, message: IMPORT_FILE_MESSAGES[err.code] }, status);
  }
  return null;
}
