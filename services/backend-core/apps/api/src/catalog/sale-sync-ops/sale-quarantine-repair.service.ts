/**
 * SaleQuarantineRepairService — RT-1312 Phase 3(b), slice C: the runtime of
 * `consoleRepairQuarantinedSale` (`sale-sync-ops/sale-sync-ops.yaml`
 * 1.3.0-draft, decisions C2 and D1).
 *
 * A repair re-ingests the item's stored body through the SAME capture code the
 * till's `captureSale` uses (`captureSaleInTransaction`), for the item's tenant
 * and store, under the item's provenance. It adds no second capture path and no
 * sale rule of its own:
 *
 *   - One sale per provenance is the FR-050 unique key and the RT-1206
 *     same-facts rule inside that capture, so a repair racing a late till
 *     retry, a second repair or a sale captured meanwhile cannot create a
 *     second sale. The till's recorded idempotency key is never replayed.
 *   - Every sale-fact check re-runs (body shape 400, same facts 409, every 422
 *     and payer or role check). The cashier admission window does not: the
 *     repairer's audited session stands in for it. Instead the body's
 *     `operatorUserId` must have been a tenant member at `occurredAt` (a later
 *     removal does not matter), else `repair_operator_unproven`.
 *   - Attribution: `created_by` is that cashier, else the repairer;
 *     `device_id` is `previous_terminal_id`, else the uploading device.
 *
 * One transaction: the item is locked, the capture runs under a SAVEPOINT, and
 * the item's resolution is written in the same commit. A capture refusal
 * (4xx) rolls back to the savepoint only, so the refusal is recorded on the
 * item (it stays `open`) and answered 200. An unexpected error (5xx) rolls
 * everything back: no sale, item unchanged, and the Console retries.
 */
import { HttpException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

import { isPostgresInputError } from "../../common/postgres-input-error";
import { wasTenantMemberAt } from "../../memberships";
import { captureSchema } from "../sales/dto/capture-sale-request.pipe";
import { splitSaleAttribution } from "../sales/sale-attribution";
import { SaleNotFoundError } from "../sales/sale-errors";
import { toCaptureHttpError } from "../sales/sales.controller";
import { captureSaleInTransaction } from "../sales/sales.service";
import type { QuarantineStateValue } from "./dto/sale-quarantine-ops.dto";
import {
  ITEM_COLUMNS,
  SaleQuarantineOpsService,
  toQuarantinedSaleBody,
  type ItemRow,
  type QuarantinedSaleBody,
} from "./sale-quarantine-ops.service";
import { RepairConflictError, type ScopedReadInput } from "./sale-sync-ops.read-model.service";

export interface RepairInput extends ScopedReadInput {
  /** The signed-in user running the repair: the sale's `created_by` when the body names no cashier. */
  readonly repairerUserId: string;
}

type Resolved = { readonly kind: "captured" | "already-captured"; readonly saleId: string };
type Refused = { readonly kind: "refused"; readonly httpStatus: number | null; readonly errorCode: string };
type Attempt = Resolved | Refused;

const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAVEPOINT = "quarantine_repair_capture";

const REFUSE_VALIDATION: Refused = { kind: "refused", httpStatus: 400, errorCode: "validation_error" };

@Injectable()
export class SaleQuarantineRepairService {
  constructor(private readonly items: SaleQuarantineOpsService) {}

  /** `consoleRepairQuarantinedSale`: out of scope or absent → 404; not `open` → `RepairConflictError` (409). */
  repair(input: RepairInput, quarantineRef: string): Promise<QuarantinedSaleBody> {
    return this.items.withLockedItem(input, quarantineRef, async (client, item) => {
      if (item.state !== "open") throw new RepairConflictError();
      const attempt = await attemptCapture(client, input, item);
      return toQuarantinedSaleBody(await recordAttempt(client, input, item, attempt));
    });
  }
}

async function attemptCapture(client: PoolClient, input: RepairInput, item: ItemRow): Promise<Attempt> {
  const stored = await client.query<{ sale_body: unknown }>(
    `SELECT sale_body FROM sale_quarantine_items WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [input.tenantId, item.id],
  );
  const parsed = captureSchema().safeParse(stored.rows[0]?.sale_body);
  // An `open` item always has its body (migration 0093 CHECK); a body that is not a valid capture is a refusal.
  if (!parsed.success) return REFUSE_VALIDATION;
  const { operatorUserId, admissionCheckAt: _window, receipt, safetyRevision, safetySyncedAt, ...withAttribution } =
    parsed.data;
  // RT-1565: sellers and receivers are stored but not hashed, exactly as on the till's captureSale.
  const { body: saleBody, attribution } = splitSaleAttribution(withAttribution);
  if (saleBody.sourceSystem !== item.source_system || saleBody.externalId !== item.external_id) return REFUSE_VALIDATION;

  // Under the savepoint from the start: a body value Postgres refuses (a date out of range, say) in the
  // membership lookup or in the capture is a recorded 400 refusal, never a 500 that leaves the item as it was.
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    if (operatorUserId !== undefined) {
      const member = { tenantId: input.tenantId, userId: operatorUserId };
      if (!(await wasTenantMemberAt(client, member, new Date(saleBody.occurredAt)))) {
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        return { kind: "refused", httpStatus: null, errorCode: "repair_operator_unproven" };
      }
    }
    const captured = await captureSaleInTransaction(client, {
      tenantId: input.tenantId,
      storeId: item.store_id,
      actorUserId: operatorUserId ?? input.repairerUserId,
      deviceId: item.previous_terminal_id ?? item.device_id,
      // The device path (the cashier is named) refuses credit as offline; the envelope path checks the actor's role.
      authPath: operatorUserId === undefined ? "envelope" : "device",
      body: saleBody,
      ...(receipt === undefined ? {} : { receipt }),
      safety: {
        ...(safetyRevision === undefined ? {} : { safetyRevision }),
        ...(safetySyncedAt === undefined ? {} : { safetySyncedAt }),
      },
      attribution,
    });
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return { kind: captured.created ? "captured" : "already-captured", saleId: captured.saleId };
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    return refusalOf(err);
  }
}

/** A capture refusal (a 4xx the till would have got) as a repair outcome; anything else is unexpected and rethrown. */
function refusalOf(err: unknown): Refused {
  if (err instanceof SaleNotFoundError) {
    // The provenance is captured in ANOTHER store: non-disclosing, whatever `captureSale` answers (contract, RT-1224).
    return { kind: "refused", httpStatus: 404, errorCode: "not_found" };
  }
  const mapped = toCaptureHttpError(err);
  if (mapped instanceof HttpException) {
    const status = mapped.getStatus();
    if (status >= 400 && status <= 499) return { kind: "refused", httpStatus: status, errorCode: codeOf(mapped) };
  } else if (isPostgresInputError(err)) {
    // As the global filter answers it for the till: a 400.
    return REFUSE_VALIDATION;
  }
  throw err;
}

function codeOf(error: HttpException): string {
  const response = error.getResponse();
  const code = typeof response === "object" && response !== null ? (response as { code?: unknown }).code : undefined;
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : "refused";
}

/** Write the attempt on the locked item: resolves it (and links the sale), or counts a refusal and keeps it `open`. */
async function recordAttempt(client: PoolClient, input: RepairInput, item: ItemRow, attempt: Attempt): Promise<ItemRow> {
  const state: QuarantineStateValue = attempt.kind === "refused" ? "open" : attempt.kind;
  const resolved = attempt.kind !== "refused";
  const updated = await client.query<ItemRow>(
    `UPDATE sale_quarantine_items
        SET state = $3,
            resolved_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
            sale_id = $5::uuid,
            repair_count = repair_count + 1,
            last_repair_at = now(),
            last_repair_outcome = $6,
            last_repair_http_status = $7::int,
            last_repair_error_code = $8
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'open'
      RETURNING ${ITEM_COLUMNS}`,
    [
      input.tenantId,
      item.id,
      state,
      resolved,
      attempt.kind === "refused" ? null : attempt.saleId,
      attempt.kind,
      attempt.kind === "refused" ? attempt.httpStatus : null,
      attempt.kind === "refused" ? attempt.errorCode : null,
    ],
  );
  const row = updated.rows[0];
  if (!row) throw new RepairConflictError();
  return row;
}
