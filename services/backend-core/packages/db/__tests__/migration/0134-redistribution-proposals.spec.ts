/**
 * RT-1600 (W9 slice A, N3): `0134_redistribution_proposals` ([GATED: migration]) on a real PostgreSQL 16
 * (Testcontainers), applied on top of every earlier migration.
 *
 * Proves:
 *   - UP runs as a NOSUPERUSER, NOBYPASSRLS migration owner with the tenant GUC pre-set to '' (the production shape);
 *   - both tables are ENABLE + FORCE ROW LEVEL SECURITY with exactly SELECT, INSERT and UPDATE policies (no DELETE);
 *   - tenant isolation through the app role: a tenant sees its own proposal and line, another tenant sees nothing,
 *     an empty GUC sees nothing, and a tenant cannot write a row into another tenant (42501);
 *   - the composite tenant foreign keys: a line naming another tenant's store, product or proposal is refused (23503);
 *   - at most one live proposal per tenant (23505), freed once it is superseded or expired;
 *   - the shape CHECKs: decided_at with a terminal decision, the reject reason, the accept outcome shapes;
 *   - DOWN then UP round-trips as the migration owner.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode, startPgEnvOrSkip } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP = "0134_redistribution_proposals.sql";
const DOWN = "0134_redistribution_proposals.down.sql";
const sql = (name: string): string => readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
const OWNER_ROLE = "rt1600_mig_owner";
const NEW_TABLES = ["redistribution_proposals", "redistribution_proposal_lines"] as const;

const id = (n: string): string => `16000000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A1 = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B1 = id("0b011");
const STORE_B2 = id("0b012");
const PRODUCT_A = id("0a031");
const PRODUCT_B = id("0b031");
const ACTOR = id("0a0a1");
const TRANSFER_A = id("0a051");

let env: PgTestEnv | null = null;
const skip = (): boolean => env === null;
function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

/** Run a migration file as the NOSUPERUSER owner of the referenced and new tables, tenant GUC pre-set to ''. */
async function runAsOwner(file: string): Promise<string | null> {
  const owner = {
    role: OWNER_ROLE,
    tables: ["tenants", "stores", "tenant_products", "shipment_transfers", ...NEW_TABLES],
    functions: [],
  };
  return asMigrationOwner(pg(), owner, async () => {
    const c = await pg().admin.connect();
    try {
      await c.query(`SET ROLE ${OWNER_ROLE}`);
      await c.query(`SELECT set_config('app.current_tenant', '', false)`);
      // The new tables are in `owner.tables`, so `asMigrationOwner` hands them back to the superuser afterwards.
      return await errorCode(() => c.query(sql(file)));
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query("RESET app.current_tenant").catch(() => undefined);
      c.release();
    }
  });
}

interface ProposalFixture {
  readonly id?: string;
  readonly tenantId?: string;
  readonly state?: string;
  readonly decidedAt?: string | null;
  readonly rejectReason?: string | null;
  readonly deficitBefore?: string;
  readonly deficitAfter?: string;
}

async function insertProposal(c: PoolClient, p: ProposalFixture = {}): Promise<string> {
  const proposalId = p.id ?? randomUUID();
  await c.query(
    `INSERT INTO redistribution_proposals
       (id, tenant_id, state, created_by, expires_at, decided_at, reject_reason, rule_name, rule_version, computed_at,
        limits, buffer, stores, warnings, objective_deficit_before, objective_deficit_after, objective_store_pairs, objective_lines)
     VALUES ($1, $2, $3, $4, now() + interval '1 day', $5, $6, 'reorder_gap_greedy', '1.0.0', now(),
             '{"maxStores":50}'::jsonb, '{"minimum":"1.0000"}'::jsonb, '[]'::jsonb, '[]'::jsonb,
             $7::numeric(19,4), $8::numeric(19,4), 1, 1)`,
    [
      proposalId, p.tenantId ?? TENANT_A, p.state ?? "open", ACTOR, p.decidedAt ?? null, p.rejectReason ?? null,
      p.deficitBefore ?? "12", p.deficitAfter ?? "4",
    ],
  );
  return proposalId;
}

interface LineFixture {
  readonly tenantId?: string;
  readonly source?: string;
  readonly destination?: string;
  readonly product?: string;
  readonly outcome?: string | null;
  readonly created?: string | null;
  readonly transfer?: string | null;
  readonly reason?: string | null;
  readonly quantity?: string;
}

async function insertLine(c: PoolClient, proposalId: string, l: LineFixture = {}): Promise<void> {
  const decided = (l.outcome ?? null) !== null;
  await c.query(
    `INSERT INTO redistribution_proposal_lines
       (id, tenant_id, proposal_id, line_seq, product_id, source_store_id, destination_store_id, quantity, stocking_unit,
        accept_outcome, accept_created_quantity, accept_transfer_id, accept_reason, accepted_at, accepted_by)
     VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, $5, $12::numeric(19,4), 'piece', $6, $7::numeric(19,4), $8, $9, $10, $11)`,
    [
      l.tenantId ?? TENANT_A, proposalId, l.product ?? PRODUCT_A, l.source ?? STORE_A1, l.destination ?? STORE_A2,
      l.outcome ?? null, l.created ?? null, l.transfer ?? null, l.reason ?? null,
      decided ? new Date().toISOString() : null, decided ? ACTOR : null, l.quantity ?? "8",
    ],
  );
}

/** The constraint violated by `fn` on the superuser (rolled back), or the error code, or null on success. */
async function violated(fn: (c: PoolClient) => Promise<unknown>): Promise<string | null> {
  const c = await pg().admin.connect();
  try {
    await c.query("BEGIN");
    await fn(c);
    return null;
  } catch (err) {
    const e = err as { constraint?: string; code?: string };
    return e.constraint ?? e.code ?? "unknown";
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

async function tableCount(): Promise<number> {
  const r = await pg().admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`,
    [NEW_TABLES],
  );
  return Number(r.rows[0]!.n);
}

beforeAll(async () => {
  const started = await startPgEnvOrSkip(startPgEnv, process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1");
  if (started.env === null) {
    // eslint-disable-next-line no-console
    console.warn(`\n[0134-redistribution-proposals.spec] Docker NOT AVAILABLE — skipping: ${started.skipReason}\n`);
    return;
  }
  env = started.env;
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rt1600-a', 'RT1600 A', 'EGP'), ($2, 'rt1600-b', 'RT1600 B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     VALUES ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1'), ($6, $5, 'B2', 'Store B2')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B, STORE_B2],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $3, 'Product A', 'standard', $5, $5), ($2, $4, 'Product B', 'standard', $5, $5)`,
    [PRODUCT_A, PRODUCT_B, TENANT_A, TENANT_B, ACTOR],
  );
  await a.query(
    `INSERT INTO shipment_transfers (id, tenant_id, source_store_id, destination_store_id, state, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5)`,
    [TRANSFER_A, TENANT_A, STORE_A1, STORE_A2, ACTOR],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0134 — up as the NOSUPERUSER migration owner", () => {
  it("is absent before, and applies with the tenant GUC set to ''", async () => {
    if (skip()) return;
    expect(await tableCount()).toBe(0);
    expect(await runAsOwner(UP)).toBeNull();
    expect(await tableCount()).toBe(2);
    await ensureAppRole(pg());
  });

  it.each([...NEW_TABLES])("%s has FORCE ROW LEVEL SECURITY and exactly SELECT, INSERT and UPDATE policies", async (table) => {
    if (skip()) return;
    const rls = await pg().admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table]);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await pg().admin.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = $1 ORDER BY cmd`, [table]);
    expect(policies.rows.map((p) => p.cmd)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});

describe("0134 — tenant isolation through the app role", () => {
  it("a tenant sees its own proposal and line; another tenant and an empty GUC see nothing", async () => {
    if (skip()) return;
    const e = pg();
    await asApp(e, TENANT_A, async (c) => {
      const proposalId = await insertProposal(c);
      await insertLine(c, proposalId);
      expect((await c.query(`SELECT id FROM redistribution_proposals`)).rows).toHaveLength(1);
      expect((await c.query(`SELECT id FROM redistribution_proposal_lines`)).rows).toHaveLength(1);
      // The same transaction, re-pinned to tenant B and then to '': nothing is visible.
      await c.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_B]);
      expect((await c.query(`SELECT id FROM redistribution_proposals`)).rows).toHaveLength(0);
      expect((await c.query(`SELECT id FROM redistribution_proposal_lines`)).rows).toHaveLength(0);
      await c.query(`SELECT set_config('app.current_tenant', '', true)`);
      expect((await c.query(`SELECT id FROM redistribution_proposals`)).rows).toHaveLength(0);
    });
  });

  it("refuses a row written into another tenant (42501)", async () => {
    if (skip()) return;
    await expect(asApp(pg(), TENANT_B, (c) => insertProposal(c, { tenantId: TENANT_A }))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("0134 — keys and checks", () => {
  it.each([
    ["a store of another tenant as source", { source: STORE_B1 }, "fk_redistribution_proposal_lines_source"],
    ["a store of another tenant as destination", { destination: STORE_B1 }, "fk_redistribution_proposal_lines_destination"],
    ["a product of another tenant", { product: PRODUCT_B }, "fk_redistribution_proposal_lines_product"],
  ] as const)("refuses a line naming %s", async (_label, over, constraint) => {
    if (skip()) return;
    expect(await violated(async (c) => insertLine(c, await insertProposal(c), over))).toBe(constraint);
  });

  it("refuses a line of tenant B on tenant A's proposal (composite proposal key)", async () => {
    if (skip()) return;
    expect(
      await violated(async (c) =>
        insertLine(c, await insertProposal(c), { tenantId: TENANT_B, source: STORE_B1, destination: STORE_B2, product: PRODUCT_B }),
      ),
    ).toBe("fk_redistribution_proposal_lines_proposal");
  });

  it("keeps at most one live proposal per tenant, freed once the first is superseded or expired", async () => {
    if (skip()) return;
    expect(await violated(async (c) => { await insertProposal(c); await insertProposal(c, { state: "reviewed" }); })).toBe(
      "redistribution_proposals_one_live_uidx",
    );
    expect(await violated(async (c) => { await insertProposal(c); await insertProposal(c, { tenantId: TENANT_B }); })).toBeNull();
    expect(
      await violated(async (c) => {
        await insertProposal(c, { state: "superseded", decidedAt: new Date().toISOString() });
        await insertProposal(c, { state: "expired" });
        await insertProposal(c);
      }),
    ).toBeNull();
  });

  it.each([
    ["a terminal decision without decided_at", { state: "accepted" }, "redistribution_proposals_decided_when_terminal"],
    ["decided_at on a live proposal", { state: "open", decidedAt: new Date().toISOString() }, "redistribution_proposals_decided_when_terminal"],
    ["a rejection without a reason", { state: "rejected", decidedAt: new Date().toISOString() }, "redistribution_proposals_reject_reason_when_rejected"],
    ["an unknown state", { state: "approved" }, "redistribution_proposals_state_allowed"],
    // NUMERIC admits 'NaN', which sorts above every number (review, PR #901).
    ["a NaN deficit before", { deficitBefore: "NaN" }, "redistribution_proposals_objective_valid"],
    ["a NaN deficit after", { deficitAfter: "NaN", deficitBefore: "NaN" }, "redistribution_proposals_objective_valid"],
  ] as const)("refuses %s", async (_label, over, constraint) => {
    if (skip()) return;
    expect(await violated((c) => insertProposal(c, over))).toBe(constraint);
  });

  it.each([
    ["created with the full quantity on a Transfer", { outcome: "created", created: "8", transfer: TRANSFER_A }, null],
    ["reduced to a smaller quantity with a reason", { outcome: "reduced", created: "5", transfer: TRANSFER_A, reason: "source_available_insufficient" }, null],
    ["dropped with a reason", { outcome: "dropped", reason: "source_not_fresh" }, null],
    ["created with less than the quantity", { outcome: "created", created: "5", transfer: TRANSFER_A }, "redistribution_proposal_lines_outcome_shape"],
    ["reduced without a reason", { outcome: "reduced", created: "5", transfer: TRANSFER_A }, "redistribution_proposal_lines_outcome_shape"],
    ["dropped on a Transfer", { outcome: "dropped", transfer: TRANSFER_A, reason: "source_not_fresh" }, "redistribution_proposal_lines_outcome_shape"],
    ["no outcome but a reason", { reason: "source_not_fresh" }, "redistribution_proposal_lines_outcome_shape"],
    ["a NaN quantity", { quantity: "NaN" }, "redistribution_proposal_lines_quantity_positive"],
    ["a zero quantity", { quantity: "0" }, "redistribution_proposal_lines_quantity_positive"],
  ] as const)("accept outcome: %s", async (_label, over, expected) => {
    if (skip()) return;
    expect(await violated(async (c) => insertLine(c, await insertProposal(c), over))).toBe(expected);
  });
});

describe("0134 — down and up again, as the migration owner", () => {
  it("drops both tables, and the up re-applies cleanly", async () => {
    if (skip()) return;
    expect(await runAsOwner(DOWN)).toBeNull();
    expect(await tableCount()).toBe(0);
    expect(await runAsOwner(UP)).toBeNull();
    expect(await tableCount()).toBe(2);
    const forced = await pg().admin.query<{ f: boolean }>(
      `SELECT bool_and(relforcerowsecurity) AS f FROM pg_class WHERE relname = ANY($1::text[])`,
      [NEW_TABLES],
    );
    expect(forced.rows[0]!.f).toBe(true);
  });
});
