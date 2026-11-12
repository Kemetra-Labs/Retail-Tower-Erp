/**
 * RT-1138: the cashier suspension API over HTTP against real Postgres
 * (Testcontainers, every migration incl. 0106, the NOBYPASSRLS `app_test` pool),
 * the real module graph (`TenantContextGuard`, `RolesGuard`) and the real
 * service. Only cookie authentication is faked: a header names the session.
 *
 * cashier-suspensions.openapi.yaml, every operation:
 *   - suspend: owner and tenant_admin, one audit row per actual change, a replay
 *     changes nothing and audits nothing, the row is per store;
 *   - reactivate: the same, the row is kept, a never-suspended cashier is
 *     `already_active` with no row;
 *   - list: only suspended cashiers, owner / tenant_admin / store_manager;
 *   - tenant isolation: a tenant can never suspend or reactivate another
 *     tenant's cashier, or reach another tenant's store; every refusal is the
 *     same non-disclosing 404;
 *   - roles and scope: store_manager / store_staff cannot write (403), a store
 *     outside the caller's scope is 404, a non-cashier user is 404;
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { CashierSuspensionsModule } from "../../src/cashier-suspensions/cashier-suspensions.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import {
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
} from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  CASHIER_ALL,
  CASHIER_B,
  CASHIER_X,
  CASHIER_Y,
  clearSuspensions,
  SES_MANAGER,
  SES_OWNER_B,
  SES_STAFF,
  seedSuspensionFixture,
  suspensionAudits,
  suspensionRow,
  UNKNOWN_STORE,
  UNKNOWN_USER,
  USER_MANAGER,
} from "./__support__/suspension-fixture";

const h = scopedHttpHarness({
  label: "RT-1138 cashier suspensions",
  contractId: "cashier-suspensions.openapi",
  module: CashierSuspensionsModule,
  seed: seedSuspensionFixture,
});
const skip = (): boolean => h.skipped();

const SUSPENDED = "cashier.suspended";
const REACTIVATED = "cashier.reactivated";

const itemPath = (store: string, user: string): string => `/api/v1/stores/${store}/cashiers/${user}/suspension`;
const listPath = (store: string): string => `/api/v1/stores/${store}/cashier-suspensions`;

const suspend = (session: string | null, store: string, user: string): request.Test =>
  h.put(itemPath(store, user), session, {});
const reactivate = (session: string | null, store: string, user: string): request.Test =>
  h.del(itemPath(store, user), session);
const list = (session: string | null, store: string): request.Test => h.get(listPath(store), session);

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("Error", res.body);
}

/** audit_events is append-only (never deleted): each test counts only the rows it adds. */
const seen: Record<string, number> = {};

async function newAudits(action: string): Promise<Awaited<ReturnType<typeof suspensionAudits>>> {
  return (await suspensionAudits(h.env().admin, TENANT_A, action)).slice(seen[action] ?? 0);
}

const row = (store: string, user: string, tenant = TENANT_A): ReturnType<typeof suspensionRow> =>
  suspensionRow(h.env().admin, tenant, store, user);

beforeEach(async () => {
  if (h.skipped()) return;
  for (const action of [SUSPENDED, REACTIVATED]) {
    seen[action] = (await suspensionAudits(h.env().admin, TENANT_A, action)).length;
  }
});

afterEach(async () => {
  if (h.skipped()) return;
  await clearSuspensions(h.env().admin, TENANT_A);
  await clearSuspensions(h.env().admin, TENANT_B);
});

describe("consoleSuspendCashier", () => {
  it("suspends a cashier at a store, audits it once, and keeps other stores untouched", async () => {
    if (skip()) return;
    const res = await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    h.conforms("CashierSuspensionChange", res.body);
    expect(res.body).toMatchObject({
      outcome: "suspended",
      suspension: { store_id: STORE_A_X, user_id: CASHIER_ALL, status: "suspended" },
    });
    expect(typeof res.body.suspension.changed_at).toBe("string");
    const stored = await row(STORE_A_X, CASHIER_ALL);
    expect(stored?.status).toBe("suspended");
    expect(await row(STORE_A_Y, CASHIER_ALL)).toBeNull();
    const audits = await newAudits(SUSPENDED);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: stored?.changed_by_user_id,
      store_id: STORE_A_X,
      target_type: "cashier_suspension",
      target_id: CASHIER_ALL,
    });
    expect(audits[0]!.metadata).toEqual({});
  });

  it("a replay changes nothing: already_suspended, the same time, one audit row", async () => {
    if (skip()) return;
    const first = await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    const second = await suspend(SES_ADMIN_SPEC, STORE_A_X, CASHIER_ALL).expect(200);
    h.conforms("CashierSuspensionChange", second.body);
    expect(second.body.outcome).toBe("already_suspended");
    expect(second.body.suspension.changed_at).toBe(first.body.suspension.changed_at);
    expect(await newAudits(SUSPENDED)).toHaveLength(1);
  });

  it("a tenant_admin granted the store can suspend there", async () => {
    if (skip()) return;
    const res = await suspend(SES_ADMIN_SPEC, STORE_A_X, CASHIER_X).expect(200);
    expect(res.body.outcome).toBe("suspended");
  });

  it("is a 403 for store_manager and store_staff, and nothing changes", async () => {
    if (skip()) return;
    for (const session of [SES_MANAGER, SES_STAFF]) {
      expectError(await suspend(session, STORE_A_X, CASHIER_ALL), 403, "forbidden");
    }
    expectError(await suspend(null, STORE_A_X, CASHIER_ALL), 401, "unauthorized");
    expect(await row(STORE_A_X, CASHIER_ALL)).toBeNull();
    expect(await newAudits(SUSPENDED)).toHaveLength(0);
  });

  it("is 404 for a store outside the caller's scope (granted-stores admin, active-store owner)", async () => {
    if (skip()) return;
    expectError(await suspend(SES_ADMIN_SPEC, STORE_A_Y, CASHIER_Y), 404, "not_found");
    expectError(await suspend(SES_OWNER_ALL_ACTIVE, STORE_A_Y, CASHIER_Y), 404, "not_found");
    expect(await row(STORE_A_Y, CASHIER_Y)).toBeNull();
    expect(await newAudits(SUSPENDED)).toHaveLength(0);
  });

  it("is the same 404 for a user who is not a cashier of that store", async () => {
    if (skip()) return;
    // A manager, an unknown user, a cashier granted only another store, an unknown store.
    expectError(await suspend(SES_OWNER_ALL, STORE_A_X, USER_MANAGER), 404, "not_found");
    expectError(await suspend(SES_OWNER_ALL, STORE_A_X, UNKNOWN_USER), 404, "not_found");
    expectError(await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_Y), 404, "not_found");
    expectError(await suspend(SES_OWNER_ALL, UNKNOWN_STORE, CASHIER_ALL), 404, "not_found");
    expect(await newAudits(SUSPENDED)).toHaveLength(0);
  });

  it("a tenant can never suspend another tenant's cashier or reach its store", async () => {
    if (skip()) return;
    // Tenant B's owner on tenant A's store and cashier; tenant A's owner on tenant B's.
    expectError(await suspend(SES_OWNER_B, STORE_A_X, CASHIER_ALL), 404, "not_found");
    expectError(await suspend(SES_OWNER_ALL, STORE_B_X, CASHIER_B), 404, "not_found");
    // Tenant A's owner on its own store with tenant B's cashier.
    expectError(await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_B), 404, "not_found");
    expect(await row(STORE_A_X, CASHIER_ALL)).toBeNull();
    expect(await row(STORE_B_X, CASHIER_B, TENANT_B)).toBeNull();
    expect(await row(STORE_A_X, CASHIER_B)).toBeNull();
  });

  it("is 400 for a malformed store or user id", async () => {
    if (skip()) return;
    expectError(await suspend(SES_OWNER_ALL, "nope", CASHIER_ALL), 400, "validation_error");
    expectError(await suspend(SES_OWNER_ALL, STORE_A_X, "nope"), 400, "validation_error");
  });
});

describe("consoleReactivateCashier", () => {
  it("reactivates a suspended cashier, keeps the row, audits once", async () => {
    if (skip()) return;
    await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    const res = await reactivate(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    h.conforms("CashierSuspensionChange", res.body);
    expect(res.body).toMatchObject({
      outcome: "reactivated",
      suspension: { store_id: STORE_A_X, user_id: CASHIER_ALL, status: "active" },
    });
    expect((await row(STORE_A_X, CASHIER_ALL))?.status).toBe("active");
    const audits = await newAudits(REACTIVATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ store_id: STORE_A_X, target_type: "cashier_suspension", target_id: CASHIER_ALL });
  });

  it("a replay, and a cashier never suspended, are already_active with no audit and no row", async () => {
    if (skip()) return;
    const never = await reactivate(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    h.conforms("CashierSuspensionChange", never.body);
    expect(never.body).toMatchObject({ outcome: "already_active", suspension: { status: "active", changed_at: null } });
    expect(await row(STORE_A_X, CASHIER_ALL)).toBeNull();

    await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    await reactivate(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    const replay = await reactivate(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    expect(replay.body.outcome).toBe("already_active");
    expect(await newAudits(REACTIVATED)).toHaveLength(1);
  });

  it("a cashier can be suspended again after reactivation", async () => {
    if (skip()) return;
    await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    await reactivate(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    const again = await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    expect(again.body.outcome).toBe("suspended");
    expect(await newAudits(SUSPENDED)).toHaveLength(2);
  });

  it("a stored row can be reactivated after the user lost the cashier membership", async () => {
    if (skip()) return;
    const admin = h.env().admin;
    await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    await admin.query(`UPDATE memberships SET revoked_at = now() WHERE user_id = $1`, [CASHIER_ALL]);
    try {
      // Suspending again is refused (no longer a cashier), but the stored row can be undone.
      expectError(await suspend(SES_OWNER_ALL, STORE_A_Y, CASHIER_ALL), 404, "not_found");
      expect((await list(SES_OWNER_ALL, STORE_A_X).expect(200)).body.suspensions).toHaveLength(1);
      const res = await reactivate(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
      expect(res.body.outcome).toBe("reactivated");
      // A user with no stored row who is not a cashier is still the 404.
      expectError(await reactivate(SES_OWNER_ALL, STORE_A_X, USER_MANAGER), 404, "not_found");
    } finally {
      await admin.query(`UPDATE memberships SET revoked_at = NULL WHERE user_id = $1`, [CASHIER_ALL]);
    }
  });

  it("is 403 for a manager, and a tenant can never reactivate another tenant's cashier (404, row kept)", async () => {
    if (skip()) return;
    await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    expectError(await reactivate(SES_MANAGER, STORE_A_X, CASHIER_ALL), 403, "forbidden");
    expectError(await reactivate(SES_OWNER_B, STORE_A_X, CASHIER_ALL), 404, "not_found");
    expect((await row(STORE_A_X, CASHIER_ALL))?.status).toBe("suspended");
    expect(await newAudits(REACTIVATED)).toHaveLength(0);
  });
});

describe("consoleListCashierSuspensions", () => {
  it("lists only the cashiers currently suspended at the store, as owner, tenant_admin and store_manager", async () => {
    if (skip()) return;
    await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_ALL).expect(200);
    await suspend(SES_OWNER_ALL, STORE_A_X, CASHIER_X).expect(200);
    await reactivate(SES_OWNER_ALL, STORE_A_X, CASHIER_X).expect(200);
    for (const session of [SES_OWNER_ALL, SES_ADMIN_SPEC, SES_MANAGER]) {
      const res = await list(session, STORE_A_X).expect(200);
      h.conforms("CashierSuspensionList", res.body);
      expect(res.body.store_id).toBe(STORE_A_X);
      expect(res.body.suspensions.map((s: { user_id: string }) => s.user_id)).toEqual([CASHIER_ALL]);
    }
    expect((await list(SES_OWNER_ALL, STORE_A_Y).expect(200)).body.suspensions).toEqual([]);
  });

  it("is a non-disclosing 404 for store_staff, another tenant, a store outside the scope and an unknown store", async () => {
    if (skip()) return;
    expectError(await list(SES_STAFF, STORE_A_X), 404, "not_found");
    expectError(await list(SES_OWNER_B, STORE_A_X), 404, "not_found");
    expectError(await list(SES_ADMIN_SPEC, STORE_A_Y), 404, "not_found");
    expectError(await list(SES_OWNER_ALL, UNKNOWN_STORE), 404, "not_found");
  });

  it("is 401 without a session, 400 for a malformed store id or a query parameter", async () => {
    if (skip()) return;
    expectError(await list(null, STORE_A_X), 401, "unauthorized");
    expectError(await list(SES_OWNER_ALL, "nope"), 400, "validation_error");
    expectError(await h.get(listPath(STORE_A_X), SES_OWNER_ALL, { limit: 5 }), 400, "validation_error");
  });
});
