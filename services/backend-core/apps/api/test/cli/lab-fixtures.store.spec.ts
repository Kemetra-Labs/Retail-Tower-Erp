/**
 * RT-1309 — PgFixtureStore against real Postgres (Testcontainers), as the
 * NON-superuser `app_test` role with RLS forced:
 *
 *   1. the database guards refuse here: the test database is not named like
 *      the lab (simulated production), and the superuser role is refused;
 *   2. a fresh fixture gets user + active link + store_staff membership with
 *      access to the store, and the result is what cashier admission reads;
 *   3. a second run plans no action (idempotent);
 *   4. a link conflict is refused by the plan and nothing is written.
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { LAB_DATABASE_NAMES } from "../../src/cli/lab-fixtures/constants";
import { GuardRefusedError } from "../../src/cli/lab-fixtures/guards";
import { fixtureIdentity } from "../../src/cli/lab-fixtures/identity";
import { planFixture } from "../../src/cli/lab-fixtures/plan";
import { PgFixtureStore } from "../../src/cli/lab-fixtures/fixture-store";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const STORE = randomUUID();
const ISSUER = "https://api.descope.com/v1/apps/PLABtest";
const SUBJECT = { providerKey: "descope", issuer: ISSUER, subject: "U-fixture-1" };

let env: PgTestEnv | null = null;
let dockerSkipped = false;

function store(domain: Pool, tenantId = TENANT): PgFixtureStore {
  return new PgFixtureStore({ domain, lookup: domain, tenantId, storeId: STORE, providerKey: "descope", issuer: ISSUER });
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    const a = env.admin;
    await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'RT Lab (synthetic)'), ($3, $4, 'Real Shop')`, [
      TENANT,
      `lab-${TENANT.slice(0, 8)}`,
      OTHER_TENANT,
      `real-${OTHER_TENANT.slice(0, 8)}`,
    ]);
    await a.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_staff', 'Store Staff')`, [randomUUID(), TENANT]);
    await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'lab1', 'Lab 1')`, [STORE, TENANT]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[lab-fixtures.store.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

function live(): PgTestEnv {
  if (!env) throw new Error("no database");
  return env;
}

describe("PgFixtureStore (real Postgres, app_test role)", () => {
  it("refuses the database guards outside the lab database (simulated production)", async () => {
    if (dockerSkipped) return;
    const err = await store(live().app).assertGuards().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardRefusedError);
    expect((err as GuardRefusedError).family).toBe("environment");
  });

  it("refuses a superuser role even when the database guard is satisfied", async () => {
    if (dockerSkipped) return;
    const db = live();
    // Make the first guard pass on purpose to prove the permission guard alone refuses.
    (LAB_DATABASE_NAMES as string[]).push(db.database);
    try {
      const err = await store(db.admin).assertGuards().catch((e: unknown) => e);
      expect((err as GuardRefusedError).family).toBe("permission");
      await expect(store(db.app).assertGuards()).resolves.toBeUndefined();
      const other = await store(db.app, OTHER_TENANT).assertGuards().catch((e: unknown) => e);
      expect((other as GuardRefusedError).family).toBe("tenant");
    } finally {
      (LAB_DATABASE_NAMES as string[]).pop();
    }
  });

  it("provisions a fresh fixture under RLS, then plans nothing on the second run", async () => {
    if (dockerSkipped) return;
    const db = live();
    const s = store(db.app);
    const identity = fixtureIdentity(1);

    const first = planFixture(await s.readState(identity, SUBJECT.subject), SUBJECT);
    expect(first).toEqual({ kind: "apply", actions: ["create_user", "create_link", "create_membership"] });
    if (first.kind !== "apply") throw new Error("unreachable");
    await s.apply(identity, SUBJECT, first.actions);

    const state = await s.readState(identity, SUBJECT.subject);
    expect(state.user?.displayName).toBe("RT Fixture Cashier 001");
    expect(state.links).toEqual([{ userId: state.user?.id, ...SUBJECT, status: "active" }]);
    expect(state.membership).toMatchObject({ roleCode: "store_staff", storeAccessKind: "specific", hasStore: true });
    expect(planFixture(state, SUBJECT)).toEqual({ kind: "apply", actions: [] });

    const users = await db.admin.query(`SELECT password_hash FROM users WHERE email = $1`, [identity.email]);
    expect(users.rows).toEqual([{ password_hash: null }]);
  });

  it("refuses a second fixture that would reuse a linked subject, writing nothing", async () => {
    if (dockerSkipped) return;
    const db = live();
    const s = store(db.app);
    const identity = fixtureIdentity(2);
    const plan = planFixture(await s.readState(identity, SUBJECT.subject), SUBJECT);
    expect(plan).toEqual({ kind: "refuse", reason: "subject_linked_to_another_user" });
    const rows = await db.admin.query(`SELECT 1 FROM users WHERE email = $1`, [identity.email]);
    expect(rows.rows).toHaveLength(0);
  });

  it("completes a fixture an earlier run left half-done (user only, then store access only)", async () => {
    if (dockerSkipped) return;
    const db = live();
    const s = store(db.app);
    const identity = fixtureIdentity(4);
    const subject = { ...SUBJECT, subject: "U-fixture-4" };
    await s.apply(identity, subject, ["create_user"]);

    const resumed = planFixture(await s.readState(identity, subject.subject), subject);
    expect(resumed).toEqual({ kind: "apply", actions: ["create_link", "create_membership"] });
    if (resumed.kind !== "apply") throw new Error("unreachable");
    await s.apply(identity, subject, resumed.actions);

    const state = await s.readState(identity, subject.subject);
    await db.admin.query(`DELETE FROM store_access WHERE membership_id = $1`, [state.membership?.id]);
    const repair = planFixture(await s.readState(identity, subject.subject), subject);
    expect(repair).toEqual({ kind: "apply", actions: ["grant_store_access"] });
    if (repair.kind !== "apply") throw new Error("unreachable");
    await s.apply(identity, subject, repair.actions);
    expect(planFixture(await s.readState(identity, subject.subject), subject)).toEqual({ kind: "apply", actions: [] });
  });

  it("does nothing for an empty plan", async () => {
    if (dockerSkipped) return;
    await expect(store(live().app).apply(fixtureIdentity(5), SUBJECT, [])).resolves.toBeUndefined();
  });

  it("RLS hides the lab tenant's membership from another tenant's context", async () => {
    if (dockerSkipped) return;
    const db = live();
    await db.admin.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'store_staff', 'Store Staff')`, [
      randomUUID(),
      OTHER_TENANT,
    ]);
    // Fixture 1 was provisioned in TENANT above. `users` has no RLS, so the user
    // is visible; its TENANT membership must not be.
    const seenFromOther = await store(db.app, OTHER_TENANT).readState(fixtureIdentity(1), SUBJECT.subject);
    expect(seenFromOther.user).not.toBeNull();
    expect(seenFromOther.membership).toBeNull();
    const seenFromLab = await store(db.app).readState(fixtureIdentity(1), SUBJECT.subject);
    expect(seenFromLab.membership).toMatchObject({ roleCode: "store_staff" });
  });

  it("rolls the whole write back when the tenant has no store_staff role", async () => {
    if (dockerSkipped) return;
    const db = live();
    const tenantWithoutRole = randomUUID();
    await db.admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Empty (synthetic)')`, [
      tenantWithoutRole,
      `empty-${tenantWithoutRole.slice(0, 8)}`,
    ]);
    const identity = fixtureIdentity(3);
    const subject = { ...SUBJECT, subject: "U-fixture-3" };
    const s = store(db.app, tenantWithoutRole);
    await expect(s.apply(identity, subject, ["create_user", "create_link", "create_membership"])).rejects.toThrow(
      "the tenant has no store_staff role",
    );
    const rows = await db.admin.query(`SELECT 1 FROM users WHERE email = $1`, [identity.email]);
    expect(rows.rows).toHaveLength(0);
  });
});
