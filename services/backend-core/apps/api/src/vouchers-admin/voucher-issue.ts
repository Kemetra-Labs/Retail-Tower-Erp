/**
 * The write half of an issue (RT-1108): the eligible-store check and the batch
 * insert. Both run on the issue's tenant transaction (`PoolClient`), so a
 * refusal or a failure leaves no voucher, no eligibility row and no audit row.
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

import { inStoreScope } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";

import { formatVoucherCode, generateVoucherCode, hashVoucherCode } from "./voucher-code";

/** An eligible store is not a live store of the tenant (404 `store_not_found`, non-disclosing). */
export class VoucherStoreNotFoundError extends Error {
  constructor() {
    super("store not found");
    this.name = "VoucherStoreNotFoundError";
  }
}

/** An eligible store exists but is inactive (409 `store_inactive`). */
export class VoucherStoreInactiveError extends Error {
  constructor() {
    super("store inactive");
    this.name = "VoucherStoreInactiveError";
  }
}

/** The bounded regeneration ran out. Astronomically unlikely at 80 bits; a 500, never a silent short batch. */
class VoucherCodeCollisionError extends Error {
  constructor() {
    super("could not generate unique voucher codes");
    this.name = "VoucherCodeCollisionError";
  }
}

/** The caller's store scope is not tenant-wide, so it cannot issue an all-stores voucher (403 `forbidden`). */
export class VoucherScopeInsufficientError extends Error {
  constructor() {
    super("store scope insufficient");
    this.name = "VoucherScopeInsufficientError";
  }
}

const MAX_GENERATION_ROUNDS = 5;

/**
 * Every id must be inside the caller's store scope (an out-of-scope store is the
 * same refusal as an absent one) and a live (not soft-deleted) store of the tenant, else
 * `VoucherStoreNotFoundError` (a store of another tenant is the same refusal);
 * then every one must be active, else `VoucherStoreInactiveError`.
 */
export async function assertStoresEligible(
  client: PoolClient,
  tenantId: string,
  scope: StoreScope,
  storeIds: readonly string[],
): Promise<void> {
  if (!storeIds.every((id) => inStoreScope(scope, id))) throw new VoucherStoreNotFoundError();
  const r = await client.query<{ is_active: boolean }>(
    `SELECT is_active FROM stores WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [tenantId, storeIds],
  );
  if (r.rows.length !== storeIds.length) throw new VoucherStoreNotFoundError();
  if (r.rows.some((row) => !row.is_active)) throw new VoucherStoreInactiveError();
}

interface VoucherBatchInput {
  readonly tenantId: string;
  readonly batchId: string;
  readonly actorUserId: string;
  readonly count: number;
  readonly amountMinor: number;
  readonly currencyCode: string;
  readonly expiresAt: string | null;
  readonly appliesToAllStores: boolean;
  readonly note: string | null;
}

/** An inserted voucher and the (secret) code that goes into the one response. */
interface InsertedVoucher {
  readonly voucherId: string;
  readonly code: string;
}

/**
 * Inserts `count` vouchers under one batch. A code whose `(tenant_id, code_hash)`
 * already exists is dropped by `ON CONFLICT DO NOTHING` and regenerated, for a
 * bounded number of rounds. Returns the vouchers in generation order with their
 * display codes. The codes are held in memory only; the table keeps the hash.
 */
export async function insertVoucherBatch(client: PoolClient, input: VoucherBatchInput): Promise<InsertedVoucher[]> {
  const issued = new Map<string, InsertedVoucher>();
  for (let round = 0; round < MAX_GENERATION_ROUNDS && issued.size < input.count; round += 1) {
    const missing = input.count - issued.size;
    const candidates = new Map<string, { voucherId: string; code: string }>();
    while (candidates.size < missing) {
      const code = generateVoucherCode();
      const hashHex = hashVoucherCode(code).toString("hex");
      if (!issued.has(hashHex) && !candidates.has(hashHex)) candidates.set(hashHex, { voucherId: newId(), code });
    }
    const hashes = [...candidates.keys()];
    const r = await client.query<{ id: string; hash: string }>(
      `INSERT INTO vouchers
         (id, tenant_id, batch_id, code_hash, amount_minor, currency_code, status, expires_at,
          applies_to_all_stores, issued_by_user_id, note)
       SELECT u.id, $3::uuid, $4::uuid, decode(u.hash, 'hex'), $5::bigint, $6::text, 'active', $7::timestamptz,
              $8::boolean, $9::uuid, $10::text
         FROM unnest($1::uuid[], $2::text[]) AS u(id, hash)
       ON CONFLICT (tenant_id, code_hash) DO NOTHING
       RETURNING id::text AS id, encode(code_hash, 'hex') AS hash`,
      [
        hashes.map((h) => candidates.get(h)!.voucherId),
        hashes,
        input.tenantId,
        input.batchId,
        input.amountMinor,
        input.currencyCode,
        input.expiresAt,
        input.appliesToAllStores,
        input.actorUserId,
        input.note,
      ],
    );
    for (const row of r.rows) {
      const candidate = candidates.get(row.hash)!;
      issued.set(row.hash, { voucherId: candidate.voucherId, code: formatVoucherCode(candidate.code) });
    }
  }
  if (issued.size < input.count) throw new VoucherCodeCollisionError();
  return [...issued.values()];
}

/** One eligibility row per (voucher, store); rows exist only for a subset voucher. */
export async function insertEligibleStores(
  client: PoolClient,
  tenantId: string,
  voucherIds: readonly string[],
  storeIds: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO voucher_eligible_stores (tenant_id, voucher_id, store_id)
     SELECT $1::uuid, v.id, s.id FROM unnest($2::uuid[]) AS v(id) CROSS JOIN unnest($3::uuid[]) AS s(id)`,
    [tenantId, voucherIds, storeIds],
  );
}
