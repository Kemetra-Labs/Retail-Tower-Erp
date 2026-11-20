/**
 * CatalogImportController — RT-1505 (spec 049 slice S4, part A): the first
 * operations of `catalog/catalog-import.yaml` 1.0.2-draft.
 *
 *   POST /api/v1/catalog/imports            consoleUploadCatalogImport
 *   GET  /api/v1/catalog/imports/{batchId}  consoleGetCatalogImport
 *
 * The other ten operations stay `x-runtime-status: contract-only` (no route is
 * registered for them): the file replace, the mapping, validate, the row list,
 * the review decision, preview, publish, cancel, the error report and the
 * template are part B and S5.
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
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Roles, RolesGuard, SessionOnlyAdminGuard } from "../../auth";
import { ConsoleRateLimit } from "../../console-rate-limit";
import { TenantContextGuard, type TenantContextRequest } from "../../context";
import { Idempotent } from "../../idempotency";
import {
  CatalogImportService,
  ImportBatchNotFoundError,
  ImportBatchOpenError,
  type ImportWriteInput,
} from "./catalog-import.service";
import type { CatalogImportBatchBody } from "./catalog-import.projections";
import { ImportFileRejectedError, IMPORT_FILE_MESSAGES } from "./import-file-rejected";
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
  constructor(private readonly service: CatalogImportService) {}

  @Post(IMPORTS)
  @HttpCode(201)
  @UseGuards(ImportUploadIntakeGuard)
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("jobOrPreview")
  async upload(@Req() request: ImportRequest): Promise<CatalogImportBatchBody> {
    const upload = request.importUpload;
    // The intake guard sets it on every request that reaches the handler; its absence is a wiring bug (500).
    if (upload === undefined) throw new Error("import upload intake guard did not run");
    try {
      return await this.service.upload(writer(request), upload);
    } catch (err) {
      throw toHttpError(err) ?? err;
    }
  }

  @Get(`${IMPORTS}/:batchId`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  async get(@Req() request: TenantContextRequest, @Param("batchId") batchId: string): Promise<CatalogImportBatchBody> {
    const id = parseBatchId(batchId);
    try {
      return await this.service.get(sessionTenant(request), id);
    } catch (err) {
      throw toHttpError(err) ?? err;
    }
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

/** The contract's 4xx for a refusal the service threw, or null (a 500). */
function toHttpError(err: unknown): HttpException | null {
  if (err instanceof ImportBatchNotFoundError) return new NotFoundException(NOT_FOUND);
  if (err instanceof ImportBatchOpenError) {
    return new HttpException(
      { code: "import_batch_open", message: "The tenant already has an open import batch. Resume or cancel it first.", openBatchId: err.openBatchId },
      409,
    );
  }
  if (err instanceof ImportFileRejectedError) {
    const status = err.code === "validation_error" ? 400 : 422;
    return new HttpException({ code: err.code, message: IMPORT_FILE_MESSAGES[err.code] }, status);
  }
  return null;
}
