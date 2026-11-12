/**
 * RT-452 — the owner attestation of the ERP batch posting
 * (`erp_batch_posting_verified`, owner decision 2026-11-12), against a real
 * Postgres with every migration applied.
 *
 * `attestBatchPosting` runs on the non-superuser `app_test` pool inside
 * `runWithTenantContext`, as the operator CLI does, so RLS and FORCE apply.
 *
 * Proves:
 *   - it records the attestation with no settings row yet (the row is upserted,
 *     tracked selling and sale effects stay as they were);
 *   - it records it on an existing row without touching the row's other columns;
 *   - a second attestation is refused (`already_attested`) and changes nothing;
 *   - a blank or over-long evidence reference is rejected before any write;
 *   - another tenant's context can neither read nor write the attestation.
 */
import type { PoolClient } from "pg";

import { attestBatchPosting } from "../../src/helpers/inventory-effects/batch-posting-attestation";
import { runWithTenantContext } from "../../src/middleware/tenant-context";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const ACTOR = "0a000000-0000-7000-8000-000000452a03";
const OTHER_ACTOR = "0a000000-0000-7000-8000-000000452a04";
const EVIDENCE = "RT-452 bench run 2026-11-12 (owner)";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

async function seedTenant(withSettings: boolean): Promise<string> {
  seq += 1;
  const tenantId = `0a000000-0000-7000-8000-${(452000 + seq).toString(16).padStart(12, "0")}`;
  await pg().admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenantId, `rt452-att-${seq}`]);
  if (withSettings) {
    await pg().admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
       VALUES ($1, $2, now(), $2)`,
      [tenantId, OTHER_ACTOR],
    );
  }
  return tenantId;
}

function asTenant<T>(tenantId: string, work: (c: PoolClient) => Promise<T>): Promise<T> {
  return runWithTenantContext(pg().app, { tenantId, isPlatformAdmin: false }, work);
}

async function settings(tenantId: string): Promise<Record<string, unknown> | undefined> {
  const r = await pg().admin.query(`SELECT * FROM tenant_inventory_settings WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0];
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[batch-posting-attestation.spec] Docker NOT AVAILABLE, skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("attestBatchPosting", () => {
  it("records the attestation when the tenant has no settings row, and leaves the other settings at their defaults", async () => {
    if (skip()) return;
    const tenantId = await seedTenant(false);
    const outcome = await asTenant(tenantId, (c) => attestBatchPosting(c, { tenantId, actorId: ACTOR, evidenceRef: EVIDENCE }));
    expect(outcome.kind).toBe("attested");
    const row = await settings(tenantId);
    expect(row).toMatchObject({
      erp_batch_posting_attested_by: ACTOR,
      erp_batch_posting_evidence_ref: EVIDENCE,
      updated_by: ACTOR,
      tracked_selling_enabled: false,
      sale_effects_activated_at: null,
    });
    expect(row?.["erp_batch_posting_attested_at"]).toBeInstanceOf(Date);
    if (outcome.kind === "attested") {
      expect(outcome.attestedAt).toBe((row?.["erp_batch_posting_attested_at"] as Date).toISOString());
      expect(outcome.evidenceRef).toBe(EVIDENCE);
    }
  });

  it("records it on an existing row without touching its other columns", async () => {
    if (skip()) return;
    const tenantId = await seedTenant(true);
    const before = await settings(tenantId);
    const outcome = await asTenant(tenantId, (c) =>
      attestBatchPosting(c, { tenantId, actorId: ACTOR, evidenceRef: `  ${EVIDENCE}  ` }),
    );
    expect(outcome.kind).toBe("attested");
    const after = await settings(tenantId);
    expect(after).toMatchObject({
      erp_batch_posting_attested_by: ACTOR,
      erp_batch_posting_evidence_ref: EVIDENCE,
      sale_effects_activated_at: before?.["sale_effects_activated_at"],
      sale_effects_activated_by: OTHER_ACTOR,
      tracked_selling_enabled: false,
    });
  });

  it("refuses a second attestation and changes nothing", async () => {
    if (skip()) return;
    const tenantId = await seedTenant(false);
    await asTenant(tenantId, (c) => attestBatchPosting(c, { tenantId, actorId: ACTOR, evidenceRef: EVIDENCE }));
    const first = await settings(tenantId);
    const outcome = await asTenant(tenantId, (c) =>
      attestBatchPosting(c, { tenantId, actorId: OTHER_ACTOR, evidenceRef: "a different reference" }),
    );
    expect(outcome).toMatchObject({ kind: "refused", refusal: { code: "already_attested" } });
    expect(await settings(tenantId)).toEqual(first);
  });

  it.each<[string, string]>([
    ["blank", "   "],
    ["empty", ""],
    ["over 200 characters", "x".repeat(201)],
  ])("rejects an evidence reference that is %s, before any write", async (_why, evidenceRef) => {
    if (skip()) return;
    const tenantId = await seedTenant(false);
    await expect(
      asTenant(tenantId, (c) => attestBatchPosting(c, { tenantId, actorId: ACTOR, evidenceRef })),
    ).rejects.toThrow(/evidence/i);
    expect(await settings(tenantId)).toBeUndefined();
  });

  it("never reads or writes another tenant's attestation", async () => {
    if (skip()) return;
    const a = await seedTenant(true);
    const b = await seedTenant(true);
    await asTenant(a, (c) => attestBatchPosting(c, { tenantId: a, actorId: ACTOR, evidenceRef: EVIDENCE }));
    // B's own context sees B as unattested: A's attestation does not make B refuse.
    const outcomeB = await asTenant(b, (c) => attestBatchPosting(c, { tenantId: b, actorId: ACTOR, evidenceRef: EVIDENCE }));
    expect(outcomeB.kind).toBe("attested");
    // A context cannot write another tenant's row.
    const c3 = await seedTenant(true);
    await expect(
      asTenant(a, (c) => attestBatchPosting(c, { tenantId: c3, actorId: ACTOR, evidenceRef: EVIDENCE })),
    ).rejects.toBeDefined();
    expect((await settings(c3))?.["erp_batch_posting_attested_at"]).toBeNull();
  });
});
