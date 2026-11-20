/**
 * CatalogImportModule — RT-1505 (spec 049 slice S4): the manual product import
 * runtime (upload and batch read in part A). See `catalog-import.controller.ts`.
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
import { CatalogImportService } from "./catalog-import.service";
import { ImportUploadIntakeGuard } from "./import-upload-intake.guard";
import { IMPORT_UPLOAD_GATE, ImportUploadGate } from "./import-upload.gate";

@Module({
  imports: [AuthModule, ContextModule, IdempotencyModule],
  controllers: [CatalogImportController],
  providers: [CatalogImportService, ImportUploadIntakeGuard, { provide: IMPORT_UPLOAD_GATE, useFactory: () => new ImportUploadGate() }],
})
export class CatalogImportModule {}
