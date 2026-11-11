/**
 * ErpnextStockImportController — RT-1288.
 *
 * Serves the two operations of
 * `packages/contracts/openapi/erpnext-connector/stock-import.yaml` (RT-1286):
 *   GET  /api/connector/v1/erpnext/stock-import-requests                   → stockImportPullRequests
 *   POST /api/connector/v1/erpnext/stock-import-requests/{requestRef}/report → stockImportReportRows
 *
 * Auth: the machine connector bearer (`ConnectorAuthGuard`) and the connector
 * registration environment check (`ConnectorEnvironmentGuard`, 403 on a
 * mismatch), as the bin-view routes. Tenant comes from the token principal only
 * (§XII). The report is `@Idempotent("required")`; the service also answers a
 * page that already has a report (replay, `idempotency_key_conflict` or
 * `import_report_conflict`). A foreign, closed or unknown `requestRef` is a
 * non-disclosing 404.
 */
import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";

import { Auditable } from "../../audit/auditable.decorator";
import type { AuthedRequest } from "../../auth/auth.guard";
import { ConnectorAuthGuard } from "../../auth/connector-auth.guard";
import { ConnectorEnvironmentGuard } from "../../auth/connector-environment.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  StockImportPullQuerySchema,
  StockImportReportSchema,
  type StockImportPullQuery,
  type StockImportReport,
} from "./dto/stock-import.dto";
import {
  ErpnextStockImportService,
  StockImportConflictError,
  StockImportNotFoundError,
  StockImportValidationError,
  type RecordedStockImport,
  type StockImportRequestWire,
} from "./erpnext-stock-import.service";

interface StockImportPageResponse {
  readonly items: readonly StockImportRequestWire[];
  readonly cursor: string;
  readonly next_page_token: string | null;
}

const CONFLICT_MESSAGES = {
  idempotency_key_conflict: "This Idempotency-Key was already used with a different report.",
  import_report_conflict: "This stock import request already has a recorded report.",
} as const;

function tenantOf(req: AuthedRequest): string {
  const principal = req.principal;
  if (principal?.kind !== "token" || principal.tenantId === null) {
    throw new UnauthorizedException("Unauthorized");
  }
  return principal.tenantId;
}

@Controller("api/connector/v1/erpnext")
@UseGuards(ConnectorAuthGuard, ConnectorEnvironmentGuard)
export class ErpnextStockImportController {
  constructor(private readonly service: ErpnextStockImportService) {}

  @Get("stock-import-requests")
  @Auditable("erpnext.stock_import.pulled")
  async pullRequests(
    @Req() req: AuthedRequest,
    @Query(new ZodValidationPipe(StockImportPullQuerySchema)) query: StockImportPullQuery,
  ): Promise<StockImportPageResponse> {
    const result = await this.service.pullRequests({
      tenantId: tenantOf(req),
      since: query.since ?? null,
      limit: query.limit ?? 100,
    });
    // `cursor` is required (minLength 1): an empty page echoes `since`, or the
    // from-start sentinel (no real page id equals it).
    const cursor = result.cursor ?? query.since ?? "00000000-0000-0000-0000-000000000000";
    return { items: result.items, cursor, next_page_token: result.nextPageToken };
  }

  @Post("stock-import-requests/:requestRef/report")
  @Idempotent("required")
  @Auditable("erpnext.stock_import.reported")
  @HttpCode(201)
  async reportRows(
    @Req() req: AuthedRequest,
    @Param("requestRef", new ParseUUIDPipe()) requestRef: string,
    @Body(new ZodValidationPipe(StockImportReportSchema)) body: StockImportReport,
    @Headers("idempotency-key") idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecordedStockImport> {
    const tenantId = tenantOf(req);
    const actorId = req.connector?.registrationId ?? (req.principal?.kind === "token" ? req.principal.tokenId : "");
    try {
      const result = await this.service.reportRows({ tenantId, requestRef, body, idempotencyKey, actorId });
      if (result.replayed) {
        res.setHeader("Idempotent-Replayed", "true");
        res.status(200);
      }
      return result.view;
    } catch (err) {
      if (err instanceof StockImportNotFoundError) {
        throw new NotFoundException({ code: "not_found", message: "Stock import request not found." });
      }
      if (err instanceof StockImportConflictError) {
        throw new ConflictException({ code: err.code, message: CONFLICT_MESSAGES[err.code] });
      }
      if (err instanceof StockImportValidationError) {
        throw new BadRequestException({ code: "validation_error", message: err.message });
      }
      throw err;
    }
  }
}
