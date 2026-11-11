/**
 * RT-1312 Phase 3(b): the runtime of `posQuarantineSale`
 * (`pos-sales/sale-quarantine.yaml` 1.0.0-draft). Stores one refused or held
 * sale in `sale_quarantine_items` (migration 0093) for a Console repair.
 *
 * Idempotency is natural, on the provenance `(tenant, sourceSystem,
 * externalId)` (FR-050). The store scope is decided first:
 *   - the first upload creates the item: 201;
 *   - a later upload from the SAME store with the same sale facts (RT-1206,
 *     compared by the stored digest, so it still holds after a body purge)
 *     returns the stored item: 200; the first upload wins for everything else;
 *   - a later upload from the same store with other facts counts a conflict on
 *     the item (committed) and is 409 `quarantine_conflict`;
 *   - an upload of a provenance another store quarantined is the same 409,
 *     with nothing counted or disclosed.
 * The upload never reads `sales`: a provenance already captured centrally is
 * still accepted, and the Console repair resolves it.
 *
 * `previousTerminalId` must be a device of the uploading device's tenant AND
 * store, revoked or not (the earlier pairing usually is): else 400, before
 * anything is stored. The composite FK enforces the same; checking first keeps
 * the answer a 400, never an FK 500.
 */
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../../auth/auth.module";
import type { DeviceScope } from "../../../pos-cashier-admissions/device-scope";
import { saleFactsDigest, summaryOf } from "./quarantine-facts";
import type { QuarantineReceipt, QuarantineSaleUpload } from "./quarantine-upload.dto";

export type QuarantineUploadResult = { readonly created: boolean; readonly receipt: QuarantineReceipt };

interface StoredItem {
  id: string;
  store_id: string;
  state: QuarantineReceipt["state"];
  received_at: Date;
  facts_digest: string;
}

type Outcome = { kind: "created" | "replayed"; item: StoredItem } | { kind: "conflict" };

function quarantineValidationError(): BadRequestException {
  return new BadRequestException({ code: "validation_error", message: "The quarantine upload is not valid." });
}

function quarantineConflictError(): ConflictException {
  return new ConflictException({
    code: "quarantine_conflict",
    message: "This sale is already quarantined with other sale facts.",
  });
}

const INSERT_SQL = `
  INSERT INTO sale_quarantine_items (
    id, tenant_id, store_id, device_id, previous_terminal_id, source_system, external_id,
    idempotency_key, reason_kind, till_http_status, till_error_code, till_recorded_at,
    sale_body, facts_digest, summary_occurred_at, summary_pos_total, summary_currency_code,
    summary_line_count)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18)
  ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
  RETURNING id, store_id, state, received_at, facts_digest`;

const READ_SQL = `
  SELECT id, store_id, state, received_at, facts_digest
    FROM sale_quarantine_items
   WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
   FOR UPDATE`;

@Injectable()
export class SaleQuarantineService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async upload(scope: DeviceScope, upload: QuarantineSaleUpload): Promise<QuarantineUploadResult> {
    const digest = saleFactsDigest(upload.saleBody);
    if (digest === null) throw quarantineValidationError();
    const outcome = await runWithTenantContext(this.pool, { tenantId: scope.tenantId, isPlatformAdmin: false }, (client) =>
      this.store(client, scope, upload, digest),
    );
    if (outcome.kind === "conflict") throw quarantineConflictError();
    return { created: outcome.kind === "created", receipt: receiptOf(outcome.item) };
  }

  private async store(
    client: PoolClient,
    scope: DeviceScope,
    upload: QuarantineSaleUpload,
    digest: string,
  ): Promise<Outcome> {
    const previous = upload.previousTerminalId ?? null;
    if (previous !== null && !(await this.isDeviceOfStore(client, scope, previous))) {
      throw quarantineValidationError();
    }
    const summary = summaryOf(upload.saleBody);
    const inserted = await client.query<StoredItem>(INSERT_SQL, [
      newId(),
      scope.tenantId,
      scope.storeId,
      scope.deviceId,
      previous,
      upload.sourceSystem,
      upload.externalId,
      upload.idempotencyKey,
      upload.reason.kind,
      upload.reason.httpStatus,
      upload.reason.errorCode,
      upload.tillRecordedAt,
      JSON.stringify(upload.saleBody),
      digest,
      summary.occurredAt,
      summary.posTotal,
      summary.currencyCode,
      summary.lineCount,
    ]);
    const created = inserted.rows[0];
    if (created) return { kind: "created", item: created };

    const existing = (await client.query<StoredItem>(READ_SQL, [scope.tenantId, upload.sourceSystem, upload.externalId]))
      .rows[0];
    // The conflicting row is committed (ON CONFLICT waited for it), so it is
    // visible here; its absence would be a broken invariant, not a client error.
    if (!existing) throw new Error("sale quarantine: provenance conflict without a visible row");
    // Another store's item: the same 409, nothing counted or disclosed.
    if (existing.store_id !== scope.storeId) return { kind: "conflict" };
    if (existing.facts_digest === digest) return { kind: "replayed", item: existing };
    await client.query(
      `UPDATE sale_quarantine_items SET upload_conflict_count = upload_conflict_count + 1
        WHERE tenant_id = $1 AND id = $2`,
      [scope.tenantId, existing.id],
    );
    return { kind: "conflict" };
  }

  private async isDeviceOfStore(client: PoolClient, scope: DeviceScope, deviceId: string): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2 AND store_id = $3`, [
      deviceId,
      scope.tenantId,
      scope.storeId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }
}

function receiptOf(item: StoredItem): QuarantineReceipt {
  return { quarantineRef: item.id, state: item.state, receivedAt: item.received_at.toISOString() };
}
