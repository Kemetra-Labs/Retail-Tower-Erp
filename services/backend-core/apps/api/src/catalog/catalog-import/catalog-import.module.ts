/**
 * CatalogImportModule — RT-1505 / RT-1507 (spec 049 slices S4, S5): the manual product import
 * runtime (upload and batch read; mapping, validate and the row list; review decisions, preview, publish and cancel). See
 * `catalog-import.controller.ts`. The publish writes the catalogue through plain functions of the console catalog domain
 * (`console-catalog.domain.ts`) on its own transaction's client, so this module needs no provider from `console-catalog`.
 *
 * Imports:
 *   - `AuthModule`        — `PG_POOL` and the human `SessionOnlyAdminGuard`.
 *   - `ContextModule`     — `TenantContextGuard`.
 *   - `IdempotencyModule` — the interceptor `@Idempotent("required")` engages.
 *
 * The upload gate (`IMPORT_UPLOAD_GATE`) is one per process: it bounds how many
 * uploads read and parse a body at once (`import-upload.gate.ts`).
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { IdempotencyModule } from "../../idempotency/idempotency.module";
import { CatalogImportController } from "./catalog-import.controller";
import { CatalogImportPublishService } from "./catalog-import.publish.service";
import { CatalogImportReviewService } from "./catalog-import.review.service";
import { CatalogImportService } from "./catalog-import.service";
import { ImportUploadIntakeGuard } from "./import-upload-intake.guard";
import { IMPORT_UPLOAD_GATE, ImportUploadGate } from "./import-upload.gate";

@Module({
  imports: [AuthModule, ContextModule, IdempotencyModule],
  controllers: [CatalogImportController],
  providers: [CatalogImportService, CatalogImportReviewService, CatalogImportPublishService, ImportUploadIntakeGuard, { provide: IMPORT_UPLOAD_GATE, useFactory: () => new ImportUploadGate() }],
})
export class CatalogImportModule {}
