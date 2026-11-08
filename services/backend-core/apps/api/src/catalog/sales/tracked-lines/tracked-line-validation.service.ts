/**
 * Jira RT-451 slice S2 — the Tracked Line Validation (TLV,
 * `posValidateTrackedLine`, `pos-sales/tracked-lines.yaml` 1.0.0-draft; RT-50
 * G7-5, G7-8, G7-13, Q11, Q12).
 *
 * Checks one lot of one product at the caller's store against Inventory's
 * current state and records the check (migration 0087,
 * `tracked_line_validations`). The decision is `tracked-line-validation.rules.ts`;
 * this service reads the facts and writes the record:
 *
 *   - the tenant's tracked-selling switch (0086): off is the non-disclosing 404
 *     (`null`), nothing is written (the deployment gate is the controller's);
 *   - the product resolved for the store (the Store Override's `is_active`, else
 *     the product's; `store-product-resolution.ts`); a product outside the
 *     tenant is the same 404;
 *   - the store's business date in its time zone at the server's clock (G7-5),
 *     the tenant's Safety Revision, and whether positions are live (RT-427);
 *   - the identity named by id, or by the scanned code matched exactly (the
 *     product's own identity first, then any of the tenant's, so a code of
 *     another product is `wrong_product`), with its active holds;
 *   - the FEFO suggestion (G7-13): the first lot of the lot lookup's order
 *     (`posListTrackedLots`), under `suggest` only.
 *
 * Every evaluated call, accepted or refused, inserts one record in the same
 * tenant-context transaction (FORCE RLS), and the answer carries its id. No
 * Idempotency-Key: a retry is a new validation against the current state.
 * Nothing is reserved and quantity never refuses (Q12).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { TrackedLineRefusalReason, TrackedLineSelection } from "@data-pulse-2/db/schema";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../../auth/auth.module";
import { pinOverrideStore, storeOverrideJoinSql } from "../../store-resolution/store-product-resolution";
import { effectiveFefoPolicy, type OrderedLotRow } from "./tracked-lots.ranking";
import { LOTS_SQL, readStoreContext, tenantSwitchedOn, type ContextRow } from "./tracked-lots.service";
import { identityRefusal, productRefusal, type TrackedLineIdentityFacts } from "./tracked-line-validation.rules";

/** Contract `TrackedLot`. */
export interface TrackedLot {
  readonly identityId: string;
  readonly code: string;
  readonly expiryDate: string | null;
}

/** Contract `TrackedLineValidation` (a tagged union on `outcome`). */
export type TrackedLineValidation =
  | {
      readonly outcome: "accepted";
      readonly validationId: string;
      readonly validatedAt: string;
      readonly safetyRevision: number;
      readonly identity: TrackedLot;
      readonly fefoSuggestion: TrackedLot | null;
    }
  | {
      readonly outcome: "refused";
      readonly reason: TrackedLineRefusalReason;
      readonly validationId: string;
      readonly validatedAt: string;
      readonly safetyRevision: number;
    };

export interface ValidateTrackedLineInput {
  /** From the credential only. */
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  /** The envelope's operator, or the device path's verified cashier. */
  readonly operatorUserId: string;
  readonly authPath: "envelope" | "device";
  readonly productId: string;
  readonly identity:
    | { readonly identityId: string }
    | { readonly code: string; readonly expiryDate?: string | undefined };
  readonly quantity: string;
  readonly selection: TrackedLineSelection;
  readonly draftLineRef: string;
}

interface ProductRow {
  readonly tracking_mode: string;
  readonly expiry_required: boolean;
  readonly sellable_at_store: boolean;
}

interface Evaluation {
  readonly reason: TrackedLineRefusalReason | null;
  readonly identity: IdentityRow | null;
  readonly suggestion: TrackedLot | null;
}

interface IdentityRow {
  readonly id: string;
  readonly product_id: string;
  readonly code: string;
  readonly expiry_date: string | null;
  readonly recall_hold: boolean;
  readonly quality_hold: boolean;
}

/** `$1` product, `$2` tenant, `$3` store. Retired or inactive at the store is not sellable. */
const PRODUCT_SQL = `
  SELECT tp.tracking_mode, tp.expiry_required,
         (tp.retired_at IS NULL AND COALESCE(spo.is_active, tp.is_active)) AS sellable_at_store
    FROM tenant_products tp
    ${storeOverrideJoinSql("$3::uuid")}
   WHERE tp.id = $1 AND tp.tenant_id = $2`;

const IDENTITY_COLUMNS = `
  SELECT i.id::text AS id, i.tenant_product_ref::text AS product_id, i.code, i.expiry_date::text AS expiry_date,
         EXISTS (SELECT 1 FROM tracking_holds h
                  WHERE h.tenant_id = i.tenant_id AND h.tracking_identity_id = i.id
                    AND h.kind = 'recall_hold' AND h.released_at IS NULL) AS recall_hold,
         EXISTS (SELECT 1 FROM tracking_holds h
                  WHERE h.tenant_id = i.tenant_id AND h.tracking_identity_id = i.id
                    AND h.kind = 'quality_hold' AND h.released_at IS NULL) AS quality_hold
    FROM tracking_identities i`;

/**
 * `$1` tenant, `$2` identity id. Batch identities only, as the lot lookup: a
 * `serial` identity (a product moved from serial keeps them; kind is
 * immutable) is never a lot, so it reads as `unknown_identity` (Q11).
 */
const IDENTITY_BY_ID_SQL = `${IDENTITY_COLUMNS}
   WHERE i.tenant_id = $1 AND i.id = $2 AND i.kind = 'batch'`;

/**
 * `$1` tenant, `$2` code (exact), `$3` product. The product's own identity
 * first: a code is unique per product, not per tenant (0045).
 */
const IDENTITY_BY_CODE_SQL = `${IDENTITY_COLUMNS}
   WHERE i.tenant_id = $1 AND i.code = $2 AND i.kind = 'batch'
   ORDER BY (i.tenant_product_ref = $3::uuid) DESC, i.id
   LIMIT 1`;

const INSERT_SQL = `
  INSERT INTO tracked_line_validations (
    tenant_id, store_id, device_id, operator_user_id, auth_path, tenant_product_ref,
    requested_identity_id, requested_code, scanned_expiry_date,
    resolved_identity_id, suggested_identity_id, selection, quantity, draft_line_ref,
    outcome, refusal_reason, safety_revision)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  RETURNING id::text AS id, validated_at`;

@Injectable()
export class TrackedLineValidationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** The recorded validation, or null for the non-disclosing 404 (nothing written). */
  validate(input: ValidateTrackedLineInput): Promise<TrackedLineValidation | null> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, (client) =>
      this.run(client, input),
    );
  }

  private async run(client: PoolClient, input: ValidateTrackedLineInput): Promise<TrackedLineValidation | null> {
    if (!(await tenantSwitchedOn(client, input.tenantId))) return null;
    await pinOverrideStore(client, input.storeId);
    const product = (await client.query<ProductRow>(PRODUCT_SQL, [input.productId, input.tenantId, input.storeId]))
      .rows[0];
    if (!product) return null;
    const context = await readStoreContext(client, input.tenantId, input.storeId);
    if (context === null) return null;

    const evaluation = await this.evaluate(client, input, product, context);
    const record = await this.record(client, input, evaluation, Number(context.safety_revision));
    const { reason, identity, suggestion } = evaluation;
    if (reason !== null) return { outcome: "refused", reason, ...record };
    // An acceptance always has its identity (the rules refuse a missing one).
    return { outcome: "accepted", ...record, identity: toLot(identity!), fefoSuggestion: suggestion };
  }

  /** The checks in the contract's order; the identity and suggestion only past the product checks. */
  private async evaluate(
    client: PoolClient,
    input: ValidateTrackedLineInput,
    product: ProductRow,
    context: ContextRow,
  ): Promise<Evaluation> {
    const reason = productRefusal({ trackingMode: product.tracking_mode, sellableAtStore: product.sellable_at_store });
    if (reason !== null) return { reason, identity: null, suggestion: null };
    const identity = await this.findIdentity(client, input);
    return {
      reason: identityRefusal({
        productId: input.productId,
        identity: identity === null ? null : toFacts(identity),
        businessDate: context.business_date,
      }),
      identity,
      suggestion: await this.suggest(client, input, product, context),
    };
  }

  /** Insert the validation record; its id and time are the answer's. */
  private async record(
    client: PoolClient,
    input: ValidateTrackedLineInput,
    evaluation: Evaluation,
    safetyRevision: number,
  ): Promise<{ validationId: string; validatedAt: string; safetyRevision: number }> {
    const ref = input.identity;
    const inserted = await client.query<{ id: string; validated_at: Date }>(INSERT_SQL, [
      input.tenantId,
      input.storeId,
      input.deviceId,
      input.operatorUserId,
      input.authPath,
      input.productId,
      "identityId" in ref ? ref.identityId : null,
      "code" in ref ? ref.code : null,
      "code" in ref ? (ref.expiryDate ?? null) : null,
      evaluation.identity?.id ?? null,
      evaluation.suggestion?.identityId ?? null,
      input.selection,
      input.quantity,
      input.draftLineRef,
      evaluation.reason === null ? "accepted" : "refused",
      evaluation.reason,
      safetyRevision,
    ]);
    const row = inserted.rows[0]!;
    return { validationId: row.id, validatedAt: row.validated_at.toISOString(), safetyRevision };
  }

  private async findIdentity(client: PoolClient, input: ValidateTrackedLineInput): Promise<IdentityRow | null> {
    const rows =
      "identityId" in input.identity
        ? await client.query<IdentityRow>(IDENTITY_BY_ID_SQL, [input.tenantId, input.identity.identityId])
        : await client.query<IdentityRow>(IDENTITY_BY_CODE_SQL, [input.tenantId, input.identity.code, input.productId]);
    return rows.rows[0] ?? null;
  }

  /** The FEFO suggestion: rank 1 of the lot lookup under `suggest`, else none. */
  private async suggest(
    client: PoolClient,
    input: ValidateTrackedLineInput,
    product: ProductRow,
    context: ContextRow,
  ): Promise<TrackedLot | null> {
    if (effectiveFefoPolicy({ expiryRequired: product.expiry_required }) !== "suggest") return null;
    const rows = await client.query<OrderedLotRow>(LOTS_SQL, [
      input.tenantId,
      input.productId,
      input.storeId,
      context.business_date,
      context.positions_live,
      true,
      1,
    ]);
    const first = rows.rows[0];
    return first === undefined ? null : { identityId: first.identity_id, code: first.code, expiryDate: first.expiry_date };
  }
}

function toFacts(row: IdentityRow): TrackedLineIdentityFacts {
  return {
    productId: row.product_id,
    expiryDate: row.expiry_date,
    recallHold: row.recall_hold,
    qualityHold: row.quality_hold,
  };
}

function toLot(row: IdentityRow): TrackedLot {
  return { identityId: row.id, code: row.code, expiryDate: row.expiry_date };
}
