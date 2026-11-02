/**
 * RT-1063 — the console people-name read over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`,
 * `RolesGuard`, `MembershipRepository`). Only cookie authentication is faked
 * (the RT-192 / RT-562 header pattern).
 *
 *   GET /api/v1/console/people  listPeopleNames
 *
 * What this proves (RT-1063 acceptance):
 *   - AC2 isolation: another tenant's user is absent for every caller; a
 *     store manager resolves only people granted a store of their scope
 *     (active-store narrowing included; an empty scope resolves nobody, not
 *     even an `all` member); owner / tenant_admin resolve every person of
 *     the tenant whatever their own grant;
 *   - AC3 revoked and deleted (D-3): a revoked membership resolves with its
 *     name; a soft-deleted user is present with a null name; a soft-deleted
 *     membership is absent; a blank or null name is null;
 *   - AC4: oversized or malformed `ids` is 400 `validation_error`; a role
 *     outside the list is the non-disclosing 404 before any validation; every
 *     bearer is 401;
 *   - AC5: one `people.names_read` per 200 with counts only (no id, no name),
 *     none on a refusal;
 *   - `Cache-Control: no-store`, `user_id` order, duplicates once, and every
 *     200 and error body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import type { INestApplication } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import request from "supertest";

import { ConsolePeopleModule } from "../../src/console-people/console-people.module";
import { loadOpenApiContracts } from "../../src/openapi/loader";
import { seedConsoleMember } from "../_helpers/console-members";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { grantSupportSession } from "../_helpers/support-session";
import { STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import {
  bootScopedApp,
  registerTestSession,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
  SES_OWNER_SPEC,
  seedReadStoreScope,
} from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { SpyAuditEnqueuer } from "../console-sales/__support__/console-http-harness";

const PATH = "/api/v1/console/people";
const CONTRACT_ID = "console-people.openapi";
const ACTION = "people.names_read";

const id = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// People of tenant A (the ids a caller asks about)
// ---------------------------------------------------------------------------

/** store_staff, `specific` X. */
const P_X = id("1063a1");
/** store_staff, `specific` Y; stored name has padding. */
const P_Y = id("1063a2");
/** store_staff, `all`. */
const P_ALL = id("1063a3");
/** `specific` X, membership revoked (grants kept). */
const P_REVOKED = id("1063a4");
/** `specific` X, user soft-deleted. */
const P_USER_DELETED = id("1063a5");
/** `specific` X, membership soft-deleted. */
const P_MEMBERSHIP_DELETED = id("1063a6");
/** `specific` X, blank name. */
const P_BLANK = id("1063a7");
/** `specific` X, no name. */
const P_NULL = id("1063a8");
/** `specific` on the soft-deleted store only. */
const P_DELETED_STORE = id("1063a9");
/** A member of tenant B only. */
const P_B = "0b000000-0000-7000-8000-0000001063b1";
/** Never a user. */
const P_UNKNOWN = id("1063ff");

const NAMES: Readonly<Record<string, string | null>> = {
  [P_X]: "Xavier Staff",
  [P_Y]: "  Yara  ",
  [P_ALL]: "All Stores",
  [P_REVOKED]: "Former Clerk",
  [P_USER_DELETED]: "Deleted Person",
  [P_MEMBERSHIP_DELETED]: "Removed Membership",
  [P_BLANK]: "   ",
  [P_NULL]: null,
  [P_DELETED_STORE]: "Closed Store Clerk",
  [P_B]: "Other Tenant",
};

const ALL_ASKED = [
  P_X,
  P_Y,
  P_ALL,
  P_REVOKED,
  P_USER_DELETED,
  P_MEMBERSHIP_DELETED,
  P_BLANK,
  P_NULL,
  P_DELETED_STORE,
  P_B,
  P_UNKNOWN,
];

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

const USER_MANAGER = id("1063c1");
const USER_MANAGER_EMPTY = id("1063c2");
const USER_STAFF = id("1063c3");
const USER_PLATFORM = id("1063c4");
const SES_MANAGER = id("1063d1");
const SES_MANAGER_Y = id("1063d2");
const SES_MANAGER_EMPTY = id("1063d3");
const SES_STAFF = id("1063d4");
const SES_PLATFORM = id("1063d5");
const DASHBOARD_TOKEN = generateRawToken();

interface Member {
  readonly userId: string;
  readonly tenantId: string;
  readonly roleCode: string;
  readonly stores: "all" | readonly string[];
  readonly sessions?: Readonly<Record<string, string | null>>;
}

const MEMBERS: readonly Member[] = [
  { userId: P_X, tenantId: TENANT_A, roleCode: "store_staff", stores: [STORE_A_X] },
  { userId: P_Y, tenantId: TENANT_A, roleCode: "store_staff", stores: [STORE_A_Y] },
  { userId: P_ALL, tenantId: TENANT_A, roleCode: "store_staff", stores: "all" },
  { userId: P_REVOKED, tenantId: TENANT_A, roleCode: "store_staff", stores: [STORE_A_X] },
  { userId: P_USER_DELETED, tenantId: TENANT_A, roleCode: "store_staff", stores: [STORE_A_X] },
  { userId: P_MEMBERSHIP_DELETED, tenantId: TENANT_A, roleCode: "store_staff", stores: [STORE_A_X] },
  { userId: P_BLANK, tenantId: TENANT_A, roleCode: "store_staff", stores: [STORE_A_X] },
  { userId: P_NULL, tenantId: TENANT_A, roleCode: "store_staff", stores: [STORE_A_X] },
  { userId: P_DELETED_STORE, tenantId: TENANT_A, roleCode: "store_staff", stores: [S_DELETED] },
  { userId: P_B, tenantId: TENANT_B, roleCode: "owner", stores: "all" },
  {
    userId: USER_MANAGER,
    tenantId: TENANT_A,
    roleCode: "store_manager",
    stores: [STORE_A_X, STORE_A_Y],
    sessions: { [SES_MANAGER]: null, [SES_MANAGER_Y]: STORE_A_Y },
  },
  {
    userId: USER_MANAGER_EMPTY,
    tenantId: TENANT_A,
    roleCode: "store_manager",
    stores: [S_DELETED],
    sessions: { [SES_MANAGER_EMPTY]: null },
  },
  { userId: USER_STAFF, tenantId: TENANT_A, roleCode: "store_staff", stores: "all", sessions: { [SES_STAFF]: null } },
];

/** A fixture id with the tenant's prefix (`0a…` for A, `0b…` for B). */
function idIn(tenantId: string, tag: string): string {
  return `${tenantId === TENANT_B ? "0b" : "0a"}${id(tag).slice(2)}`;
}

async function seedPeople(admin: Pool): Promise<void> {
  for (const [i, m] of MEMBERS.entries()) {
    await seedConsoleMember(admin, {
      tenantId: m.tenantId,
      userId: m.userId,
      email: `rt1063-${i}@example.test`,
      membershipId: idIn(m.tenantId, `1063e${i.toString(16)}`),
      roleId: idIn(m.tenantId, `1063f${i.toString(16)}`),
      roleCode: m.roleCode,
      stores: m.stores,
      sessions: m.sessions ?? {},
    });
  }
  for (const [userId, name] of Object.entries(NAMES)) {
    await admin.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [userId, name]);
  }
  await admin.query(`UPDATE memberships SET revoked_at = now() WHERE user_id = $1`, [P_REVOKED]);
  await admin.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [P_USER_DELETED]);
  await admin.query(`UPDATE memberships SET deleted_at = now() WHERE user_id = $1`, [P_MEMBERSHIP_DELETED]);

  // A platform admin with no membership, acting in tenant A through a support session.
  await admin.query(
    `INSERT INTO users (id, email, is_platform_admin) VALUES ($1, 'rt1063-platform@example.test', true)`,
    [USER_PLATFORM],
  );
  await admin.query(
    `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES ($1, $2, $3, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [SES_PLATFORM, USER_PLATFORM, TENANT_A],
  );
  registerTestSession(SES_PLATFORM, USER_PLATFORM);
  await grantSupportSession(admin, SES_PLATFORM, USER_PLATFORM, TENANT_A);

  await admin.query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'dashboard_api', now() + interval '1 hour')`,
    [hashToken(DASHBOARD_TOKEN), TENANT_A, USER_MANAGER],
  );
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const audit = new SpyAuditEnqueuer();
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let pg: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let namesSchema: ValidateFunction;
let errorSchema: ValidateFunction;

beforeAll(async () => {
  const found = loadOpenApiContracts().find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found`);
  ajv.addSchema(found.document as object, CONTRACT_ID);
  namesSchema = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/PeopleNames`)!;
  errorSchema = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/Error`)!;
  try {
    pg = await startPgEnv();
    await applyAllUpAndCreateAppRole(pg);
    await seedReadStoreScope(pg);
    await seedPeople(pg.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${msg}`);
    dockerSkipped = true;
    // eslint-disable-next-line no-console
    console.warn(`\n[RT-1063 people names] Docker NOT AVAILABLE: ${msg}\n`);
    return;
  }
  // Bearer tokens resolve on the RLS-exempt pool, as the production auth-lookup role does.
  app = await bootScopedApp(pg, ConsolePeopleModule, audit, { authLookupPool: pg.admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (pg) await stopPgEnv(pg);
}, 60_000);

function skip(): boolean {
  // eslint-disable-next-line no-console
  if (dockerSkipped) console.warn("[RT-1063 people names] skipping — Docker unavailable");
  return dockerSkipped;
}

function get(session: string | null, query: Record<string, string> | string): request.Test {
  const req = request(app!.getHttpServer()).get(PATH).query(query);
  return session === null ? req : req.set("x-test-session", session);
}

interface Item {
  user_id: string;
  display_name: string | null;
}

async function names(session: string, ids: readonly string[]): Promise<Item[]> {
  const res = await get(session, { ids: ids.join(",") });
  if (res.status !== 200) throw new Error(`people ${res.status}: ${JSON.stringify(res.body)}`);
  if (!namesSchema(res.body)) throw new Error(`contract violation: ${JSON.stringify(namesSchema.errors)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  return (res.body as { items: Item[] }).items;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  if (!errorSchema(res.body)) throw new Error(`contract violation: ${JSON.stringify(errorSchema.errors)}`);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

/** Every person of tenant A among ALL_ASKED, with the expected projection. */
const TENANT_A_ITEMS: Item[] = [
  { user_id: P_X, display_name: "Xavier Staff" },
  { user_id: P_Y, display_name: "Yara" },
  { user_id: P_ALL, display_name: "All Stores" },
  { user_id: P_REVOKED, display_name: "Former Clerk" },
  { user_id: P_USER_DELETED, display_name: null },
  { user_id: P_BLANK, display_name: null },
  { user_id: P_NULL, display_name: null },
  { user_id: P_DELETED_STORE, display_name: "Closed Store Clerk" },
].sort((a, b) => (a.user_id < b.user_id ? -1 : 1));

const itemsFor = (ids: readonly string[]): Item[] => TENANT_A_ITEMS.filter((i) => ids.includes(i.user_id));

// ===========================================================================
// Who resolves
// ===========================================================================

describe("RT-1063 people names — tenant-wide roles (D-2)", () => {
  it.each([
    ["owner, all", SES_OWNER_ALL],
    ["owner, all, X active (not narrowed)", SES_OWNER_ALL_ACTIVE],
    ["owner, specific (not narrowed by its own grant)", SES_OWNER_SPEC],
    ["tenant_admin, specific X (not narrowed by its own grant)", SES_ADMIN_SPEC],
  ])("%s resolves every person of the tenant, revoked and deleted cases included", async (_label, session) => {
    if (skip()) return;
    expect(await names(session, ALL_ASKED)).toEqual(TENANT_A_ITEMS);
  });
});

describe("RT-1063 people names — revoked and deleted (D-3)", () => {
  it("a revoked membership resolves with its name (the forensic case)", async () => {
    if (skip()) return;
    expect(await names(SES_OWNER_ALL, [P_REVOKED])).toEqual([{ user_id: P_REVOKED, display_name: "Former Clerk" }]);
  });

  it("a soft-deleted user is present with a null name, never its stored name", async () => {
    if (skip()) return;
    const res = await get(SES_OWNER_ALL, { ids: P_USER_DELETED });
    expect(res.body).toEqual({ items: [{ user_id: P_USER_DELETED, display_name: null }] });
    expect(JSON.stringify(res.body)).not.toContain("Deleted Person");
  });

  it("a soft-deleted membership is absent", async () => {
    if (skip()) return;
    expect(await names(SES_OWNER_ALL, [P_MEMBERSHIP_DELETED])).toEqual([]);
  });

  it("a blank or null name is null, never the e-mail", async () => {
    if (skip()) return;
    const res = await get(SES_OWNER_ALL, { ids: `${P_BLANK},${P_NULL}` });
    expect(res.body.items).toEqual(itemsFor([P_BLANK, P_NULL]));
    expect(JSON.stringify(res.body)).not.toContain("@");
  });
});

describe("RT-1063 people names — store manager scope and isolation (AC2)", () => {
  it("a two-store manager resolves people granted X or Y, and `all` members", async () => {
    if (skip()) return;
    const visible = [P_X, P_Y, P_ALL, P_REVOKED, P_USER_DELETED, P_BLANK, P_NULL];
    expect(await names(SES_MANAGER, ALL_ASKED)).toEqual(itemsFor(visible));
  });

  it("the same manager with Y active is narrowed to Y", async () => {
    if (skip()) return;
    expect(await names(SES_MANAGER_Y, ALL_ASKED)).toEqual(itemsFor([P_Y, P_ALL]));
  });

  it("a manager whose only grant is a deleted store resolves nobody, not even an `all` member", async () => {
    if (skip()) return;
    expect(await names(SES_MANAGER_EMPTY, ALL_ASKED)).toEqual([]);
  });

  it("a platform admin acting in the tenant gets the standard scope (tenant-wide)", async () => {
    if (skip()) return;
    expect(await names(SES_PLATFORM, ALL_ASKED)).toEqual(TENANT_A_ITEMS);
  });

  it.each([
    ["owner", SES_OWNER_ALL],
    ["store_manager", SES_MANAGER],
    ["platform admin", SES_PLATFORM],
  ])("another tenant's user and an unknown id are absent for %s", async (_label, session) => {
    if (skip()) return;
    const res = await get(session, { ids: `${P_B},${P_UNKNOWN}` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    expect(JSON.stringify(res.body)).not.toContain("Other Tenant");
  });

  it("orders by user_id, lower-cases, and answers a repeated id once", async () => {
    if (skip()) return;
    const items = await names(SES_OWNER_ALL, [P_Y.toUpperCase(), P_X, P_Y]);
    expect(items.map((i) => i.user_id)).toEqual(sorted([P_X, P_Y]));
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe("RT-1063 people names — refusals (AC4)", () => {
  it("store_staff is the non-disclosing 404, before any validation", async () => {
    if (skip()) return;
    expectError(await get(SES_STAFF, { ids: P_X }), 404, "not_found");
    expectError(await get(SES_STAFF, { ids: "not-a-uuid" }), 404, "not_found");
    expectError(await get(SES_STAFF, {}), 404, "not_found");
  });

  it("the manager's dashboard_api bearer is 401", async () => {
    if (skip()) return;
    const res = await request(app!.getHttpServer())
      .get(PATH)
      .query({ ids: P_X })
      .set("authorization", `Bearer ${DASHBOARD_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("no session is 401", async () => {
    if (skip()) return;
    expect((await get(null, { ids: P_X })).status).toBe(401);
  });

  const many = (n: number): string => Array.from({ length: n }, (_, i) => id(`1063${(0x1000 + i).toString(16)}`)).join(",");

  it.each([
    ["missing ids", ""],
    ["empty ids", "ids="],
    ["201 ids", `ids=${many(201)}`],
    ["a 7,400-character value", `ids=${"a".repeat(7400)}`],
    ["a non-UUID element", `ids=${P_X},nope`],
    ["an empty element", `ids=${P_X},,${P_Y}`],
    ["ids given twice", `ids=${P_X}&ids=${P_Y}`],
    ["another query key", `ids=${P_X}&tenant_id=${TENANT_B}`],
  ])("%s is 400 validation_error", async (_label, query) => {
    if (skip()) return;
    expectError(await get(SES_OWNER_ALL, query), 400, "validation_error");
  });

  it("200 ids, the maximum, is a 200", async () => {
    if (skip()) return;
    const res = await get(SES_OWNER_ALL, `ids=${many(199)},${P_X}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: itemsFor([P_X]) });
  });
});

// ===========================================================================
// Audit
// ===========================================================================

describe("RT-1063 people names — audit (AC5)", () => {
  const events = (): unknown[] => audit.payloads.filter((p) => p.action === ACTION);

  it("emits one people.names_read per 200 with counts only: no id, no name", async () => {
    if (skip()) return;
    audit.payloads.length = 0;
    await names(SES_MANAGER, [P_X, P_X, P_B, P_UNKNOWN]);
    await new Promise((r) => setImmediate(r));
    const emitted = events();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      action: ACTION,
      tenant_id: TENANT_A,
      actor_user_id: USER_MANAGER,
      target_type: null,
      target_id: null,
      metadata: { requested_count: 3, resolved_count: 1 },
    });
    const text = JSON.stringify(emitted[0]);
    for (const leaked of [P_X, P_B, P_UNKNOWN, "Xavier"]) expect(text).not.toContain(leaked);
  });

  it("emits one event for an empty 200 too", async () => {
    if (skip()) return;
    audit.payloads.length = 0;
    await names(SES_MANAGER_EMPTY, [P_ALL]);
    await new Promise((r) => setImmediate(r));
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ metadata: { requested_count: 1, resolved_count: 0 } });
  });

  it("audits no refusal (400, 401, 404)", async () => {
    if (skip()) return;
    audit.payloads.length = 0;
    await get(SES_OWNER_ALL, { ids: "nope" });
    await get(SES_STAFF, { ids: P_X });
    await get(null, { ids: P_X });
    await new Promise((r) => setImmediate(r));
    expect(events()).toHaveLength(0);
  });
});
