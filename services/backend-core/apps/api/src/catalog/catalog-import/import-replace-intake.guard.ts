/**
 * RT-1537 (spec 049 S5c): the intake of `consoleReplaceCatalogImportFile` (`PUT /api/v1/catalog/imports/{batchId}/file`).
 * The same slot, body and size rules as the upload (`takeSlotAndReadBody`), in the same order: the path id and the query
 * (400 `validation_error`), then a free upload slot (429, body unread), then the body (413 past 5 MiB while reading, 400
 * when empty).
 *
 * There is no `Idempotency-Key` and no fingerprint: the contract makes this call idempotent by `expected_version` (a retry
 * after success is `409 version_conflict`), so the route has no `@Idempotent` and the guard sets no `req.body`.
 */
import { BadRequestException, Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Response } from "express";

import { takeSlotAndReadBody, type ImportUploadRequest } from "./import-upload-intake.guard";
import { IMPORT_UPLOAD_GATE, type ImportUploadGate } from "./import-upload.gate";
import { BatchIdSchema, ReplaceQuerySchema } from "./import-upload.query";

@Injectable()
export class ImportReplaceIntakeGuard implements CanActivate {
  constructor(@Inject(IMPORT_UPLOAD_GATE) private readonly gate: ImportUploadGate) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<ImportUploadRequest & { params?: { batchId?: string } }>();
    const res = http.getResponse<Response>();
    if (!BatchIdSchema.safeParse(req.params?.batchId).success) {
      throw new BadRequestException({ code: "validation_error", message: "batchId must be a valid UUID" });
    }
    const query = ReplaceQuerySchema.parse(req.query);
    const { bytes, sha256 } = await takeSlotAndReadBody(this.gate, req, res);
    req.importReplace = { bytes, sha256, query };
    return true;
  }
}
