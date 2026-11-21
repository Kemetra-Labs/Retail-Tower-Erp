/**
 * RT-388 — the local shift variance policy cache (migration 0067
 * `cash_variance_policy_cache`).
 *
 * One row: the last policy the device read returned for this pairing's tenant
 * and branch, its ETag (for `If-None-Match`) and when it was read. It has NO
 * maximum age (DR-7): an offline terminal applies the policy it last saw, however
 * old. A row cached for another tenant or branch (a re-pair) is never answered, and
 * the next read replaces it. A row that no longer reads as the contract's body is
 * treated as absent.
 *
 * The `DatabaseHandle` is injected so tests run on sql.js.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { VariancePolicy } from './policy-core.js';
import { readPolicyBody } from './policy-wire.js';

/** The pairing a policy belongs to (the shift scope without the terminal). */
export interface PolicyCacheScope {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface CachedPolicy {
  readonly policy: VariancePolicy;
  /** The answer's ETag, or null when it carried none. */
  readonly etag: string | null;
  /** The server clock of the read. */
  readonly serverTime: string;
  /** The till's clock when it was stored. */
  readonly fetchedAt: string;
}

export interface PolicyCache {
  /** The cached policy of `scope`, else null (none, another pairing, or unreadable). */
  read(scope: PolicyCacheScope): CachedPolicy | null;
  /** Replaces the single row. */
  write(scope: PolicyCacheScope, entry: CachedPolicy): void;
}

interface Row {
  tenant_id: string;
  branch_id: string;
  policy_source: string;
  policy_revision_id: string | null;
  policy_mode: string;
  limit_amount: string | null;
  currency_code: string | null;
  etag: string | null;
  server_time: string;
  fetched_at: string;
}

interface PrepareGet<R> {
  get(...params: unknown[]): R | undefined;
}
interface PrepareRun {
  run(...params: unknown[]): unknown;
}

const SELECT_SQL = `
  SELECT tenant_id, branch_id, policy_source, policy_revision_id, policy_mode, limit_amount,
         currency_code, etag, server_time, fetched_at
  FROM cash_variance_policy_cache WHERE id = 1`;

const REPLACE_SQL = `
  INSERT OR REPLACE INTO cash_variance_policy_cache (id, tenant_id, branch_id, policy_source,
    policy_revision_id, policy_mode, limit_amount, currency_code, etag, server_time, fetched_at)
  VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The row re-read through the wire rules, so a damaged row is never trusted. */
function policyOfRow(row: Row): VariancePolicy | null {
  const read = readPolicyBody({
    policySource: row.policy_source,
    policyRevisionId: row.policy_revision_id,
    policyValue:
      row.policy_mode === 'limit'
        ? { mode: 'limit', limitAmount: row.limit_amount, currencyCode: row.currency_code }
        : { mode: row.policy_mode },
    serverTime: row.server_time,
  });
  return read?.policy ?? null;
}

export function createPolicyCache(db: DatabaseHandle): PolicyCache {
  return {
    read(scope) {
      const row = (db.prepare(SELECT_SQL) as PrepareGet<Row>).get();
      if (row === undefined) return null;
      if (row.tenant_id !== scope.tenantId || row.branch_id !== scope.branchId) return null;
      const policy = policyOfRow(row);
      if (policy === null) return null;
      return { policy, etag: row.etag, serverTime: row.server_time, fetchedAt: row.fetched_at };
    },

    write(scope, entry) {
      const { policy } = entry;
      (db.prepare(REPLACE_SQL) as PrepareRun).run(
        scope.tenantId,
        scope.branchId,
        policy.source,
        policy.revisionId,
        policy.mode,
        policy.mode === 'limit' ? policy.limitAmount : null,
        policy.mode === 'limit' ? policy.currencyCode : null,
        entry.etag,
        entry.serverTime,
        entry.fetchedAt,
      );
    },
  };
}
