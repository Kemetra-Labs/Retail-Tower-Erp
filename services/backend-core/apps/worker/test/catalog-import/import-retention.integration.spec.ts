/**
 * RT-1503 (spec 049 S2) — the catalogue import expiry and retention job on
 * real PostgreSQL (every migration applied, 0124 included).
 *
 * `catalog_import_batches` / `catalog_import_rows` are FORCE RLS with
 * tenant-only policies (no platform-admin branch), so the job lists tenant ids
 * as platform admin and works each tenant under that tenant's own GUC.
 *
 * The job runs here as a NOSUPERUSER / NOBYPASSRLS probe role holding ONLY
 * what the domain role (DATABASE_URL, shared by api and worker) holds:
 * exactly the GRANT / REVOKE lines of
 * docs/operations/sql/catalog-import-domain-grants.sql, SELECT on `tenants`
 * (the existing sweeps' tenant listing) and INSERT on `audit_events` (the
 * api's in-transaction audits). So the job needs no new grant.
 *
 * Covers: two-tenant isolation; the §8.1 conditional expiry of a draft and
 * of a validated batch (preview_hash cleared, version bumped, closed) with
 * its `catalog.import.expire` audit row; a stale version updates nothing; the
 * 30-day and 13-month purge edges; the header kept; idempotent reruns.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (RT-123
 * retention-rls precedent).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runWithTenantContext } from "@data-pulse-2/db";
import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  endPoolQuietly,
  guardPool,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import {
  IMPORT_RETENTION_JOB_NAME,
  ImportRetentionProcessor,
} from "../../src/catalog-import/import-retention.processor";
import {
  IMPORT_EXPIRE_AUDIT_ACTION,
  PgImportRetentionRepository,
  expireBatchIfUnchanged,
} from "../../src/catalog-import/import-retention.repository";

const id = (n: string): string => `01240000-0000-7000-8000-0000${n}`;
const TENANT_A = id("15030a01");
const TENANT_B = id("15030b01");
const TENANT_C = id("15030c01"); // suspended: its import data still ages out
const ACTOR = id("15030a99");

const SHA = "c".repeat(64);
const HASH = `sha256:${"d".repeat(64)}`;
const COLUMNS = JSON.stringify([{ columnNumber: 1, header: "SKU", samples: ["A-1"] }]);
const MAPPING = JSON.stringify([{ columnNumber: 1, target: "sku" }]);
const COUNTS = JSON.stringify({ ready_create: 1, ready_update: 0, unchanged: 0, needs_review: 0, error: 0, excluded: 0 });
const SUMMARY = JSON.stringify({ productsCreated: 1, productsUpdated: 0 });

const PROBE_ROLE = "rt1503_retention_probe";
const PROBE_PASSWORD = "rt1503_probe";
const GRANTS_SQL = resolve(__dirname, "..", "..", "..", "..", "docs", "operations", "sql", "catalog-import-domain-grants.sql");

// The database clock in UTC minus an interval, then nudged: the job's own window arithmetic.
const UTC_AGO = (interval: string, nudge: string): string =>
  `((clock_timestamp() AT TIME ZONE 'UTC' - interval '${interval}') AT TIME ZONE 'UTC') + interval '${nudge}'`;

let env: PgTestEnv | null = null;
let probe: Pool | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[import-retention.integration] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;

  await a.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
  await a.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await a.query(`GRANT SELECT ON tenants TO ${PROBE_ROLE}`);
  await a.query(`GRANT INSERT ON audit_events TO ${PROBE_ROLE}`);
  const statements = readFileSync(GRANTS_SQL, "utf8")
    .split("\n")
    .filter((line) => /^(GRANT|REVOKE) /.test(line));
  expect(statements).toHaveLength(4);
  for (const statement of statements) await a.query(statement.replace(/:"domain_role"/g, `"${PROBE_ROLE}"`));
  probe = guardPool(
    new Pool({ connectionString: `postgres://${PROBE_ROLE}:${PROBE_PASSWORD}@${env.host}:${env.port}/test` }),
  );

  await a.query(
    `INSERT INTO tenants (id, slug, name, status) VALUES
       ($1, 'rt1503-a', 'A', 'active'), ($2, 'rt1503-b', 'B', 'active'), ($3, 'rt1503-c', 'C', 'suspended')`,
    [TENANT_A, TENANT_B, TENANT_C],
  );
}, 240_000);

afterAll(async () => {
  if (probe) await endPoolQuietly(probe);
  if (env) await stopPgEnv(env);
}, 60_000);

const skipped = (): boolean => env === null;

function pg(): { env: PgTestEnv; probe: Pool } {
  if (!env || !probe) throw new Error("Docker unavailable");
  return { env, probe };
}

// -----------------------------------------------------------------------------
// Seeding (as the superuser; the guards and CHECKs of 0124 still apply)
// -----------------------------------------------------------------------------

let seq = 0;

/** A CSV draft batch with `rows` rows; `expiresAt` is a SQL expression. */
async function draft(tenant: string, rows: number, expiresAt = "now() + interval '7 days'"): Promise<string> {
  seq += 1;
  const batchId = id(`1503${String(seq).padStart(4, "0")}`);
  const a = pg().env.admin;
  await a.query(
    `INSERT INTO catalog_import_batches
       (id, tenant_id, mode, file_name, file_size, file_sha256, file_kind, csv_delimiter, data_row_count, column_count,
        parser_version, columns, created_by, expires_at)
     VALUES ($1, $2, 'upsert', 'products.csv', 100, $3, 'csv', 'comma', 5, 1, 'csv-1', $4, $5, ${expiresAt})`,
    [batchId, tenant, SHA, COLUMNS, ACTOR],
  );
  for (let r = 0; r < rows; r += 1) {
    await a.query(
      `INSERT INTO catalog_import_rows (tenant_id, batch_id, row_number, cells) VALUES ($1, $2, $3, $4)`,
      [tenant, batchId, r + 2, JSON.stringify([`SKU-${r}`])],
    );
  }
  return batchId;
}

async function makeValidated(batchId: string, expiresAt: string): Promise<void> {
  await pg().env.admin.query(
    `UPDATE catalog_import_batches
        SET state = 'validated', version = version + 1, validation_generation = validation_generation + 1,
            mapping = $2, counts = $3, preview_hash = $4, expires_at = ${expiresAt}
      WHERE id = $1`,
    [batchId, MAPPING, COUNTS, HASH],
  );
}

async function close(batchId: string, state: "cancelled" | "expired", closedAt: string): Promise<void> {
  await pg().env.admin.query(
    `UPDATE catalog_import_batches
        SET state = $2, version = version + 1, expires_at = NULL, preview_hash = NULL, closed_at = ${closedAt}
      WHERE id = $1`,
    [batchId, state],
  );
}

async function publish(batchId: string, publishedAt: string): Promise<void> {
  await pg().env.admin.query(
    `UPDATE catalog_import_batches
        SET state = 'published', version = version + 1, validation_generation = 1, mapping = $2, counts = $3,
            preview_hash = $4, publish_summary = $5, expires_at = NULL,
            published_at = ${publishedAt}, closed_at = ${publishedAt}
      WHERE id = $1`,
    [batchId, MAPPING, COUNTS, HASH, SUMMARY],
  );
}

interface BatchRow {
  state: string;
  version: number;
  preview_hash: string | null;
  expires_at: Date | null;
  closed_at: Date | null;
  rows_purged_at: Date | null;
  counts: unknown;
  publish_summary: unknown;
}

async function batch(batchId: string): Promise<BatchRow> {
  const r = await pg().env.admin.query<BatchRow>(
    `SELECT state, version, preview_hash, expires_at, closed_at, rows_purged_at, counts, publish_summary
       FROM catalog_import_batches WHERE id = $1`,
    [batchId],
  );
  if (!r.rows[0]) throw new Error(`batch ${batchId} is gone`);
  return r.rows[0];
}

async function rowCount(batchId: string): Promise<number> {
  const r = await pg().env.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM catalog_import_rows WHERE batch_id = $1`,
    [batchId],
  );
  return r.rows[0]!.n;
}

async function expireAudits(batchId?: string): Promise<Array<{ tenant_id: string; target_id: string; metadata: Record<string, unknown>; actor_label: string }>> {
  const r = await pg().env.admin.query(
    `SELECT tenant_id, target_id, metadata, actor_label FROM audit_events
      WHERE action = $1 AND ($2::uuid IS NULL OR target_id = $2) ORDER BY occurred_at, id`,
    [IMPORT_EXPIRE_AUDIT_ACTION, batchId ?? null],
  );
  return r.rows;
}

function run(): Promise<unknown> {
  return new ImportRetentionProcessor(
    new PgImportRetentionRepository(pg().probe),
    { expiryBatchLimit: 1, purgeBatchLimit: 1 },
    () => undefined,
  ).process(IMPORT_RETENTION_JOB_NAME, {});
}

// -----------------------------------------------------------------------------
// Tests (in order: expiry, then purge)
// -----------------------------------------------------------------------------

describe("RT-1503 role and RLS posture", () => {
  it("the job's role is NOSUPERUSER and NOBYPASSRLS", async () => {
    if (skipped()) return;
    const r = await pg().probe.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("the tenant listing returns every tenant, suspended included", async () => {
    if (skipped()) return;
    const ids = await new PgImportRetentionRepository(pg().probe).listTenantIds();
    expect(ids).toEqual(expect.arrayContaining([TENANT_A, TENANT_B, TENANT_C]));
  });
});

describe("RT-1503 expiry (spec 049 §8.1)", () => {
  let draftA = "";
  let validatedB = "";

  beforeAll(async () => {
    if (skipped()) return;
    draftA = await draft(TENANT_A, 2, "now() - interval '1 minute'");
    validatedB = await draft(TENANT_B, 1);
    await makeValidated(validatedB, "now() - interval '1 second'");
  });

  it("a stale version (or another tenant's GUC) updates nothing and writes no audit row", async () => {
    if (skipped()) return;
    const stale = await runWithTenantContext(pg().probe, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
      expireBatchIfUnchanged(c, TENANT_A, { id: draftA, version: 2, state: "draft" }),
    );
    expect(stale).toBeNull();
    const crossTenant = await runWithTenantContext(pg().probe, { tenantId: TENANT_B, isPlatformAdmin: false }, (c) =>
      expireBatchIfUnchanged(c, TENANT_B, { id: draftA, version: 1, state: "draft" }),
    );
    expect(crossTenant).toBeNull();
    expect(await batch(draftA)).toMatchObject({ state: "draft", version: 1, closed_at: null });
    expect(await expireAudits()).toEqual([]);
  });

  it("one tenant's pass expires only that tenant's batch (two-tenant isolation)", async () => {
    if (skipped()) return;
    const pass = await new PgImportRetentionRepository(pg().probe).expireDueBatches(TENANT_A, 10);
    expect(pass).toEqual({ picked: 1, expired: 1 });

    const a = await batch(draftA);
    expect(a).toMatchObject({ state: "expired", version: 2, preview_hash: null, expires_at: null, rows_purged_at: null });
    expect(a.closed_at).toBeInstanceOf(Date);
    expect(await batch(validatedB)).toMatchObject({ state: "validated", version: 2, preview_hash: HASH });
  });

  it("writes one catalog.import.expire audit row in the batch's tenant, with batch id, version, counts and file hash", async () => {
    if (skipped()) return;
    expect(await expireAudits(draftA)).toEqual([
      {
        tenant_id: TENANT_A,
        target_id: draftA,
        actor_label: "system",
        metadata: { import_batch_id: draftA, version: 2, previous_state: "draft", counts: null, file_sha256: SHA },
      },
    ]);
  });

  it("the scheduled run expires the validated batch and clears its preview_hash", async () => {
    if (skipped()) return;
    await run();
    const b = await batch(validatedB);
    expect(b).toMatchObject({ state: "expired", version: 3, preview_hash: null, expires_at: null });
    // The counts of its last validation stay on the header.
    expect(b.counts).toEqual(JSON.parse(COUNTS));
    expect((await expireAudits(validatedB))[0]).toMatchObject({
      tenant_id: TENANT_B,
      metadata: { version: 3, previous_state: "validated", counts: JSON.parse(COUNTS), file_sha256: SHA },
    });
  });

  it("an expired batch keeps its rows (30 days) and a batch not yet due stays open", async () => {
    if (skipped()) return;
    const notDue = await draft(TENANT_A, 1, "now() + interval '1 hour'");
    await run();
    expect(await rowCount(draftA)).toBe(2);
    expect(await rowCount(validatedB)).toBe(1);
    expect(await batch(notDue)).toMatchObject({ state: "draft", version: 1 });
    // Close it so the purge tests start from closed batches only.
    await close(notDue, "cancelled", "now()");
  });

  it("is idempotent: a rerun expires nothing and writes no audit row", async () => {
    if (skipped()) return;
    const before = (await expireAudits()).length;
    await run();
    expect(await expireAudits()).toHaveLength(before);
    expect(before).toBe(2);
  });
});

describe("RT-1503 retention purge (OD-6)", () => {
  const seeded: Record<string, string> = {};

  beforeAll(async () => {
    if (skipped()) return;
    // Tenant A at the edges.
    seeded["cancelledDue"] = await draft(TENANT_A, 3);
    await close(seeded["cancelledDue"], "cancelled", UTC_AGO("30 days", "-1 minute"));
    seeded["expiredKept"] = await draft(TENANT_A, 2);
    await close(seeded["expiredKept"], "expired", UTC_AGO("30 days", "1 minute"));
    seeded["publishedDue"] = await draft(TENANT_A, 2);
    await publish(seeded["publishedDue"], UTC_AGO("13 months", "-1 minute"));
    seeded["publishedKept"] = await draft(TENANT_A, 1);
    await publish(seeded["publishedKept"], UTC_AGO("13 months", "1 minute"));
    seeded["publishedRecent"] = await draft(TENANT_A, 1);
    await publish(seeded["publishedRecent"], UTC_AGO("31 days", "0 minutes"));
    // Tenants B and C.
    seeded["cancelledB"] = await draft(TENANT_B, 2);
    await close(seeded["cancelledB"], "cancelled", UTC_AGO("40 days", "0 minutes"));
    seeded["expiredC"] = await draft(TENANT_C, 1);
    await close(seeded["expiredC"], "expired", UTC_AGO("60 days", "0 minutes"));
  });

  it("one tenant's pass purges only that tenant's due batches, at the 30-day and 13-month edges", async () => {
    if (skipped()) return;
    const pass = await new PgImportRetentionRepository(pg().probe).purgeDueRows(TENANT_A, 10);
    expect(pass).toEqual({ batches: 2, rows: 5 });

    expect(await rowCount(seeded["cancelledDue"]!)).toBe(0);
    expect(await rowCount(seeded["publishedDue"]!)).toBe(0);
    expect(await rowCount(seeded["expiredKept"]!)).toBe(2);
    expect(await rowCount(seeded["publishedKept"]!)).toBe(1);
    expect(await rowCount(seeded["publishedRecent"]!)).toBe(1);
    expect(await rowCount(seeded["cancelledB"]!)).toBe(2);
    expect(await rowCount(seeded["expiredC"]!)).toBe(1);
  });

  it("keeps the header: the batch, its counts and publish summary stay, rows_purged_at is stamped", async () => {
    if (skipped()) return;
    const published = await batch(seeded["publishedDue"]!);
    expect(published).toMatchObject({ state: "published", counts: JSON.parse(COUNTS), publish_summary: JSON.parse(SUMMARY) });
    expect(published.rows_purged_at).toBeInstanceOf(Date);
    expect((await batch(seeded["cancelledDue"]!)).rows_purged_at).toBeInstanceOf(Date);
    for (const key of ["expiredKept", "publishedKept", "publishedRecent", "cancelledB", "expiredC"]) {
      expect((await batch(seeded[key]!)).rows_purged_at).toBeNull();
    }
  });

  it("the scheduled run purges every tenant's due batches (B and suspended C) in bounded passes", async () => {
    if (skipped()) return;
    const result = await run();
    expect(result).toMatchObject({ purgedBatches: 2, purgedRows: 3, failedTenants: 0, expired: 0 });
    expect(await rowCount(seeded["cancelledB"]!)).toBe(0);
    expect(await rowCount(seeded["expiredC"]!)).toBe(0);
    expect(await rowCount(seeded["expiredKept"]!)).toBe(2);
  });

  it("is idempotent: a rerun purges nothing and leaves every stamp as it was", async () => {
    if (skipped()) return;
    const stamp = (await batch(seeded["cancelledDue"]!)).rows_purged_at;
    const result = await run();
    expect(result).toMatchObject({ expired: 0, purgedBatches: 0, purgedRows: 0, failedTenants: 0 });
    expect((await batch(seeded["cancelledDue"]!)).rows_purged_at).toEqual(stamp);
  });

  it("also runs as the app role (app_test)", async () => {
    if (skipped()) return;
    const processor = new ImportRetentionProcessor(new PgImportRetentionRepository(pg().env.app), undefined, () => undefined);
    await expect(processor.process(IMPORT_RETENTION_JOB_NAME, {})).resolves.toMatchObject({ failedTenants: 0 });
  });
});
