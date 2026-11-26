/**
 * RT-1445 (slice B1 of RT-1437, `[GATED: migration]`) — the Console open-shifts
 * read, the force-close preview and the Console force close
 * (`console-force-actions.openapi.yaml`) over HTTP against real Postgres
 * (Testcontainers, every migration including 0119, the NOBYPASSRLS `app_test`
 * pool) and the real module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`,
 * `ForceActionAccessGuard`, `MembershipRepository`, the shared
 * `IdempotencyInterceptor` over a fake Redis). Only cookie authentication is
 * faked: a header names the session.
 *
 * What this proves (RT-1445 acceptance):
 *   1. an eligible shift is force-closed from the Console as `not_counted`: no
 *      `ShiftClose`, the fact has `closed_via = 'console'` and no device, and the
 *      audit row carries the extended keys and never the reason;
 *   2. a live operator session, a live admission and a fresh shift are 409
 *      `shift_not_stuck` with `details.blockers`; that refusal precedes the
 *      fingerprint;
 *   3. another tenant's shift and an unknown id are 404; a store the caller has
 *      no all-store access to and a store_manager are refused (404); a platform
 *      admin is ADMITTED (RT-1462: a member whatever their role, a non-member
 *      with or without a support session), recorded as `actor_kind:
 *      platform_admin` on behalf of the tenant and the session, with one
 *      `platform.cross_tenant.accessed` row per request (since RT-1468 member or not);
 *   4. a stale `previewFingerprint` is 409 `preview_stale`; the replay (same key,
 *      or the same close under another key with a stale fingerprint) is 200 and
 *      writes nothing;
 *   5. the D9 cap: the 11th first-time force action of a tenant in an hour is 429
 *      `force_action_rate_limited` (shared with the console `store.deleted`
 *      audit rows; POS-channel rows do not count; concurrent writers cannot
 *      exceed it);
 *   6. the open-shifts read lists every open shift with the same verdict.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";

import type { INestApplication, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import request from "supertest";

import { ConsoleForceActionsModule } from "../../src/console-force-actions/console-force-actions.module";
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../src/idempotency/idempotency.interceptor";
import { INFLIGHT_REDIS, InProgressMarker } from "../../src/idempotency/in-progress-marker";
import { loadOpenApiContracts } from "../../src/openapi/loader";
import { grantSupportSession } from "../_helpers/support-session";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { bootScopedApp, registerTestSession } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";

const CONTRACT_ID = "console-force-actions.openapi";
const ORIGIN = "http://127.0.0.1";
const REASON = "Till A died with the shift open; the cashier left";

class FakeRedis {
  private readonly s = new Map<string, { value: string; expiresAt: number }>();
  async get(k: string): Promise<string | null> {
    const e = this.s.get(k);
    return !e || Date.now() > e.expiresAt ? null : e.value;
  }
  async set(k: string, v: string, o: { px: number }): Promise<unknown> {
    this.s.set(k, { value: v, expiresAt: Date.now() + o.px });
    return "OK";
  }
}
class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

interface World {
  readonly tenant: string;
  readonly store: string;
  readonly store2: string;
  readonly owner: string; // session ids
  readonly ownerActive: string;
  readonly admin: string;
  readonly adminSpecific: string;
  readonly manager: string;
  readonly platform: string;
  /** RT-1462: a platform admin who is ALSO an owner member of the tenant (no support session needed). */
  readonly platformMember: string;
  /** RT-1462: a platform admin who is not a member and has NO support session. */
  readonly platformBare: string;
  readonly platformUser: string; // user ids of the three platform-admin sessions
  readonly platformMemberUser: string;
  readonly platformBareUser: string;
  readonly supportSessionId: string;
  readonly cashier: string; // user id (no live session)
  readonly ownerUser: string;
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let seq = 0;
let worldA: World;
let worldB: World;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schemas: Record<string, ValidateFunction> = {};

const id = (): string => randomUUID();
const admin = (): Pool => env!.admin;
const key = (): string => `rt1445-key-${String(++seq).padStart(8, "0")}-${Date.now()}`;

async function seedWorld(pool: Pool, label: string): Promise<World> {
  const w: World = {
    tenant: id(),
    store: id(),
    store2: id(),
    owner: id(),
    ownerActive: id(),
    admin: id(),
    adminSpecific: id(),
    manager: id(),
    platform: id(),
    platformMember: id(),
    platformBare: id(),
    platformUser: id(),
    platformMemberUser: id(),
    platformBareUser: id(),
    supportSessionId: "",
    cashier: id(),
    ownerUser: id(),
  };
  const [adminUser, specUser, managerUser] = [id(), id(), id()];
  const [platformUser, platformMemberUser, platformBareUser] = [w.platformUser, w.platformMemberUser, w.platformBareUser];
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)`, [w.tenant, `rt1445-${label}`]);
  await pool.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'S1', 'S1'), ($2, $3, 'S2', 'S2')`, [
    w.store,
    w.store2,
    w.tenant,
  ]);
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES
       ($1, $6, 'Cashier Cat'), ($2, $7, NULL), ($3, $8, NULL), ($4, $9, NULL), ($5, $10, NULL)`,
    [w.cashier, w.ownerUser, adminUser, specUser, managerUser, `c-${label}@e.test`, `o-${label}@e.test`, `a-${label}@e.test`, `s-${label}@e.test`, `m-${label}@e.test`],
  );
  await pool.query(`INSERT INTO users (id, email, is_platform_admin) VALUES ($1, $4, true), ($2, $5, true), ($3, $6, true)`, [
    platformUser,
    platformMemberUser,
    platformBareUser,
    `p-${label}@e.test`,
    `pm-${label}@e.test`,
    `pb-${label}@e.test`,
  ]);
  const roles = { owner: id(), tenant_admin: id(), store_manager: id() };
  for (const [code, rid] of Object.entries(roles)) {
    await pool.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`, [rid, w.tenant, code]);
  }
  const members: Array<[string, string, string, "all" | "specific"]> = [
    [w.ownerUser, roles.owner, id(), "all"],
    [adminUser, roles.tenant_admin, id(), "all"],
    [specUser, roles.tenant_admin, id(), "specific"],
    [managerUser, roles.store_manager, id(), "all"],
    [platformMemberUser, roles.owner, id(), "all"],
  ];
  for (const [user, role, membership, access] of members) {
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, $5)`,
      [membership, w.tenant, user, role, access],
    );
    if (access === "specific") {
      await pool.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [membership, w.store, w.tenant]);
    }
  }
  const sessions: Array<[string, string, string | null]> = [
    [w.owner, w.ownerUser, null],
    [w.ownerActive, w.ownerUser, w.store],
    [w.admin, adminUser, null],
    [w.adminSpecific, specUser, null],
    [w.manager, managerUser, null],
    [w.platform, platformUser, null],
    [w.platformMember, platformMemberUser, null],
    [w.platformBare, platformBareUser, null],
  ];
  for (const [sid, user, active] of sessions) {
    await pool.query(
      `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
      [sid, user, w.tenant, active],
    );
    registerTestSession(sid, user);
  }
  const supportSessionId = await grantSupportSession(pool, w.platform, platformUser, w.tenant);
  return { ...w, supportSessionId };
}

interface SeededShift {
  readonly shiftId: string;
  readonly deviceId: string;
  readonly cashier: string;
}

/** An open shift of a cashier (a fresh user unless given) on a fresh device of `store`, opened `minutesAgo` minutes ago. */
async function seedShift(
  w: World,
  over: { store?: string; cashier?: string; minutesAgo?: number; legacy?: boolean } = {},
): Promise<SeededShift> {
  const store = over.store ?? w.store;
  const deviceId = id();
  const shiftId = id();
  let cashier = over.cashier;
  if (cashier === undefined) {
    cashier = id();
    await admin().query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Cashier Cat')`, [cashier, `c-${cashier}@e.test`]);
  }
  await admin().query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '30 minutes')`,
    [deviceId, w.tenant, store, `till-${deviceId.slice(0, 4)}`, createHash("sha256").update(deviceId).digest()],
  );
  if (over.legacy === true) {
    await admin().query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
       VALUES ($1, $2, $3, $4, $5, now() - ($6::int * interval '1 minute'))`,
      [shiftId, w.tenant, store, cashier, deviceId, over.minutesAgo ?? 120],
    );
  } else {
    await admin().query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at,
                           source, currency_code, opening_float, business_date, received_at, recorded_by_user_id, payload_hash)
       VALUES ($1, $2, $3, $4, $5, now() - ($6::int * interval '1 minute'), 'cash_up', 'EGP', 500, current_date, now(), $4, $7)`,
      [shiftId, w.tenant, store, cashier, deviceId, over.minutesAgo ?? 120, createHash("sha256").update(shiftId).digest()],
    );
  }
  return { shiftId, deviceId, cashier };
}

async function seedOperatorSession(w: World, shift: SeededShift): Promise<void> {
  await admin().query(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, device_id, store_id, scope, expires_at)
     VALUES (gen_random_uuid(), decode(md5(random()::text) || md5(random()::text), 'hex'), $1, $2, $3, $4, 'pos_operator', now() + interval '1 hour')`,
    [w.tenant, shift.cashier, shift.deviceId, w.store],
  );
}

async function seedLiveAdmission(w: World, shift: SeededShift): Promise<void> {
  await admin().query(
    `INSERT INTO cashier_admissions (id, tenant_id, store_id, user_id, device_id, mode, created_at, renewed_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'online', now(), now(), now() + interval '1 hour')`,
    [w.tenant, w.store, shift.cashier, shift.deviceId],
  );
}

beforeAll(async () => {
  const doc = loadOpenApiContracts().find((c) => c.id === CONTRACT_ID)!.document as object;
  ajv.addSchema(doc, CONTRACT_ID);
  for (const name of ["OpenShiftList", "OpenShiftsSummary", "ForceClosePreview", "ConsoleForceClosedShift", "Error"]) {
    const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    schemas[name] = v;
  }
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    worldA = await seedWorld(env.admin, "a");
    worldB = await seedWorld(env.admin, "b");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1445 console force actions] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  const redis = new FakeRedis();
  const marker = new FakeMarker();
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert(): Promise<void> {} },
    pgReader: { async find(): Promise<null> { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const providers: Provider[] = [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: INFLIGHT_REDIS, useValue: redis },
    { provide: InProgressMarker, useValue: marker },
    { provide: APP_INTERCEPTOR, useValue: new IdempotencyInterceptor(new Reflector(), store, marker as unknown as InProgressMarker) },
  ];
  app = await bootScopedApp(env, ConsoleForceActionsModule, undefined, { authLookupPool: env.admin, providers });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1445 console force actions] skipping: Docker unavailable");
    return true;
  }
  return false;
}

function expectValid(name: string, body: unknown): void {
  const v = schemas[name]!;
  if (!v(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(v.errors)}`);
}

const http = (): ReturnType<typeof request> => request(app!.getHttpServer());
const preview = (session: string, shiftId: string): request.Test =>
  http().get(`/api/v1/shifts/${shiftId}/force-close-preview`).set("x-test-session", session);
const openShifts = (session: string, storeId: string): request.Test =>
  http().get(`/api/v1/stores/${storeId}/open-shifts`).set("x-test-session", session);
const summary = (session: string): request.Test => http().get(`/api/v1/open-shifts/summary`).set("x-test-session", session);
function close(session: string, shiftId: string, body: Record<string, unknown>, idemKey: string | null = key()): request.Test {
  const req = http().post(`/api/v1/shifts/${shiftId}/force-close`).set("x-test-session", session).set("Origin", ORIGIN);
  return (idemKey === null ? req : req.set("Idempotency-Key", idemKey)).send(body);
}

/** The preview's fingerprint of a shift, read as the owner. */
async function fingerprintOf(w: World, shiftId: string): Promise<string> {
  const res = await preview(w.owner, shiftId);
  expect(res.status).toBe(200);
  return res.body.previewFingerprint as string;
}

async function closeOk(w: World, shift: SeededShift, reason = REASON): Promise<request.Response> {
  return close(w.owner, shift.shiftId, { forcedReason: reason, previewFingerprint: await fingerprintOf(w, shift.shiftId) });
}

interface ShiftState {
  lifecycle: string;
  shiftCloses: number;
  forced: Array<{ closed_via: string; closed_from_device_id: string | null; closed_by_user_id: string }>;
}
async function stateOf(shiftId: string): Promise<ShiftState> {
  const s = await admin().query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM shifts WHERE shift_id = $1`, [shiftId]);
  const c = await admin().query(`SELECT 1 FROM shift_closes WHERE shift_id = $1`, [shiftId]);
  const f = await admin().query<ShiftState["forced"][number]>(
    `SELECT closed_via, closed_from_device_id, closed_by_user_id FROM shift_forced_closes WHERE shift_id = $1`,
    [shiftId],
  );
  return { lifecycle: s.rows[0]?.lifecycle_state ?? "missing", shiftCloses: c.rowCount ?? 0, forced: f.rows };
}
const STILL_OPEN: ShiftState = { lifecycle: "open", shiftCloses: 0, forced: [] };

async function auditRows(tenantId: string, shiftId?: string): Promise<Array<Record<string, any>>> {
  const r = await admin().query(
    `SELECT action, actor_user_id, store_id, target_type, target_id, request_id, metadata FROM audit_events
      WHERE tenant_id = $1 AND action = 'shift.force_closed' AND ($2::uuid IS NULL OR target_id = $2)`,
    [tenantId, shiftId ?? null],
  );
  return r.rows;
}

describe("consoleForceCloseShift: an eligible shift closes as not counted (criterion 1)", () => {
  it("201, a console fact with no device, no ShiftClose, the extended audit row, never the reason", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    const res = await closeOk(worldA, shift);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectValid("ConsoleForceClosedShift", res.body);
    expect(res.body).toMatchObject({
      shiftId: shift.shiftId,
      status: "force_closed",
      currencyCode: "EGP",
      openingFloat: "500.00",
      forcedClose: { closedVia: "console", closedFromTerminalLabel: null, forcedReason: REASON, cashCount: "not_counted" },
    });
    for (const total of ["countedCash", "expectedCash", "variance", "saleCount"]) {
      expect(res.body.forcedClose).not.toHaveProperty(total);
    }
    const state = await stateOf(shift.shiftId);
    expect(state.lifecycle).toBe("closed_forced");
    expect(state.shiftCloses).toBe(0);
    expect(state.forced).toHaveLength(1);
    expect(state.forced[0]).toMatchObject({ closed_via: "console", closed_from_device_id: null });
    const audits = await auditRows(worldA.tenant, shift.shiftId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: worldA.ownerUser, store_id: worldA.store, target_type: "shift" });
    expect(audits[0]!["metadata"]).toMatchObject({
      shift_id: shift.shiftId,
      channel: "console",
      actor_role: "owner",
      preview_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      lifecycle_state_before: "open",
      lifecycle_state_after: "closed_forced",
      opened_on_device_id: shift.deviceId,
      closed_from_device_id: null,
      opening_user_id: shift.cashier,
      replayed: false,
    });
    expect(typeof audits[0]!["metadata"].shift_age_minutes).toBe("number");
    expect(JSON.stringify(audits)).not.toContain(REASON);
  });

  it("a tenant_admin with all-store access and an owner whose session picked one store are admitted too", async () => {
    if (skip()) return;
    const shifts = [await seedShift(worldA), await seedShift(worldA)];
    const asAdmin = await close(worldA.admin, shifts[0]!.shiftId, {
      forcedReason: REASON,
      previewFingerprint: (await preview(worldA.admin, shifts[0]!.shiftId)).body.previewFingerprint,
    });
    const asActive = await close(worldA.ownerActive, shifts[1]!.shiftId, {
      forcedReason: REASON,
      previewFingerprint: (await preview(worldA.ownerActive, shifts[1]!.shiftId)).body.previewFingerprint,
    });
    expect([asAdmin.status, asActive.status]).toEqual([201, 201]);
    expect((await auditRows(worldA.tenant, shifts[0]!.shiftId))[0]!["metadata"].actor_role).toBe("tenant_admin");
  });

  it("the opening till's later POS facts see a Console fact as a force close: the row carries the POS hash", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    expect((await closeOk(worldA, shift)).status).toBe(201);
    const r = await admin().query<{ n: number }>(
      `SELECT octet_length(payload_hash) AS n FROM shift_forced_closes WHERE shift_id = $1`,
      [shift.shiftId],
    );
    expect(r.rows[0]!.n).toBe(32);
  });
});

describe("consoleForceCloseShift: a shift that is not stuck is refused with its blockers (criterion 2)", () => {
  it("a live operator session of the opening cashier: 409 shift_not_stuck [live_operator_session]", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    await seedOperatorSession(worldA, shift);
    const fp = await fingerprintOf(worldA, shift.shiftId);
    const res = await close(worldA.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: fp });
    expect(res.status).toBe(409);
    expectValid("Error", res.body);
    expect(res.body.error).toMatchObject({ code: "shift_not_stuck", details: { blockers: ["live_operator_session"] } });
    expect(await stateOf(shift.shiftId)).toEqual(STILL_OPEN);
    expect(await auditRows(worldA.tenant, shift.shiftId)).toEqual([]);
  });

  it("a live cashier admission on the opening terminal: [live_cashier_admission]", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    await seedLiveAdmission(worldA, shift);
    const res = await close(worldA.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: await fingerprintOf(worldA, shift.shiftId) });
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([409, "shift_not_stuck", { blockers: ["live_cashier_admission"] }]);
  });

  it("both, on a shift opened a minute ago: every failed predicate, in order, even with a wrong fingerprint", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA, { minutesAgo: 1 });
    await seedOperatorSession(worldA, shift);
    await seedLiveAdmission(worldA, shift);
    // The stuck rule precedes the fingerprint (contract order).
    const res = await close(worldA.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: "shift_not_stuck",
      details: { blockers: ["not_stale", "live_operator_session", "live_cashier_admission"] },
    });
  });

  it("a shift closed with a cash-up is 409 shift_closed", async () => {
    if (skip()) return;
    // A cash-up close needs its `shift_closes` row (the shifts guard); a legacy shift may move freely.
    const legacy = await seedShift(worldA, { legacy: true });
    await admin().query(`UPDATE shifts SET lifecycle_state = 'closed' WHERE shift_id = $1`, [legacy.shiftId]);
    const res = await close(worldA.owner, legacy.shiftId, { forcedReason: REASON, previewFingerprint: "a".repeat(64) });
    expect([res.status, res.body.error.code]).toEqual([409, "shift_closed"]);
  });
});

/**
 * RT-1462's closes run on their OWN tenant: the D9 cap counts a tenant's first-time console closes per hour, and
 * `worldA` is shared by the whole file, so adding closes there would push the cap test over its limit.
 */
let platformWorldCache: World | undefined;
async function platformWorld(): Promise<World> {
  platformWorldCache ??= await seedWorld(admin(), "rt1462");
  return platformWorldCache;
}

describe("consoleForceCloseShift: a platform admin acts on a customer's behalf (RT-1462, amending D1)", () => {
  it("a non-member in the support session that names the tenant lists, previews and closes, and the audit says so", async () => {
    if (skip()) return;
    const w = await platformWorld();
    const shift = await seedShift(w);
    const list = await openShifts(w.platform, w.store);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { shiftId: string }) => i.shiftId)).toContain(shift.shiftId);
    const res = await close(w.platform, shift.shiftId, {
      forcedReason: REASON,
      previewFingerprint: (await preview(w.platform, shift.shiftId)).body.previewFingerprint,
    });
    expect(res.status).toBe(201);
    expectValid("ConsoleForceClosedShift", res.body);
    const state = await stateOf(shift.shiftId);
    expect(state.forced[0]).toMatchObject({ closed_via: "console", closed_by_user_id: w.platformUser });
    const audits = await auditRows(w.tenant, shift.shiftId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: w.platformUser });
    expect(audits[0]!["metadata"]).toMatchObject({
      channel: "console",
      actor_kind: "platform_admin",
      actor_role: null,
      on_behalf_of: { tenant_id: w.tenant, support_session_id: w.supportSessionId, ticket_ref: null },
    });
    // On behalf of: ids and a ticket reference only (no name, e-mail or phone), and never the reason.
    expect(JSON.stringify(audits)).not.toMatch(/@e\.test|Cashier Cat/);
    expect(JSON.stringify(audits)).not.toContain(REASON);
  });

  it("a non-member platform admin WITHOUT a support session lists, previews and closes, and one cross-tenant row records each request", async () => {
    if (skip()) return;
    const w = await platformWorld();
    const shift = await seedShift(w);
    // Each request carries its own X-Request-Id (the API honours a well-formed one), so the audit rows below
    // can be matched to the requests that caused them.
    const ids = { list: randomUUID(), preview: randomUUID(), close: randomUUID() };
    expect((await openShifts(w.platformBare, w.store).set("X-Request-Id", ids.list)).status).toBe(200);
    const fingerprint = (await preview(w.platformBare, shift.shiftId).set("X-Request-Id", ids.preview)).body.previewFingerprint;
    const res = await close(w.platformBare, shift.shiftId, { forcedReason: REASON, previewFingerprint: fingerprint }).set(
      "X-Request-Id",
      ids.close,
    );
    expect(res.status).toBe(201);
    const audits = await auditRows(w.tenant, shift.shiftId);
    expect(audits[0]!["metadata"]).toMatchObject({
      actor_kind: "platform_admin",
      actor_role: null,
      on_behalf_of: { tenant_id: w.tenant, support_session_id: null, ticket_ref: null },
    });
    const rows = await admin().query<{ request_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT request_id, metadata FROM audit_events WHERE tenant_id = $1 AND action = 'platform.cross_tenant.accessed' AND actor_user_id = $2`,
      [w.tenant, w.platformBareUser],
    );
    // list, preview (the fingerprint read) and close: exactly one row per request, none names a session.
    // Matched by the id each request carried: two rows for one request and none for another cannot pass.
    expect(rows.rowCount).toBe(3);
    for (const requestId of Object.values(ids)) {
      expect(rows.rows.filter((row) => row.request_id === requestId)).toHaveLength(1);
    }
    for (const row of rows.rows) {
      expect(row.metadata).toMatchObject({ actor_kind: "platform_admin", outcome: "succeeded", support_session_id: null, purpose: null });
    }
  });

  it("a platform admin who is also the tenant's owner is recorded as platform_admin, not owner", async () => {
    if (skip()) return;
    const w = await platformWorld();
    const shift = await seedShift(w);
    const res = await close(w.platformMember, shift.shiftId, {
      forcedReason: REASON,
      previewFingerprint: (await preview(w.platformMember, shift.shiftId)).body.previewFingerprint,
    });
    expect(res.status).toBe(201);
    const audits = await auditRows(w.tenant, shift.shiftId);
    expect(audits[0]!["metadata"]).toMatchObject({
      actor_kind: "platform_admin",
      actor_role: "owner",
      on_behalf_of: { tenant_id: w.tenant, support_session_id: null, ticket_ref: null },
    });
  });

  it("the owner's own close still says owner, on behalf of no one", async () => {
    if (skip()) return;
    const w = await platformWorld();
    const shift = await seedShift(w);
    expect((await closeOk(w, shift)).status).toBe(201);
    expect((await auditRows(w.tenant, shift.shiftId))[0]!["metadata"]).toMatchObject({
      actor_kind: "owner",
      actor_role: "owner",
      on_behalf_of: null,
    });
  });

  it("the tenant is the session's, never the request's: another tenant's shift is 404 for a platform admin too", async () => {
    if (skip()) return;
    const w = await platformWorld();
    const foreign = await seedShift(worldB);
    const res = await close(w.platform, foreign.shiftId, { forcedReason: REASON, previewFingerprint: "a".repeat(64) });
    expect([res.status, res.body.error.code]).toEqual([404, "shift_not_found"]);
    expect((await preview(w.platform, foreign.shiftId)).status).toBe(404);
    expect(await stateOf(foreign.shiftId)).toEqual(STILL_OPEN);
  });
});

describe("consoleForceCloseShift: who may call it, and the non-disclosing 404 (criterion 3)", () => {
  it("another tenant's shift and an unknown id are the same 404 shift_not_found", async () => {
    if (skip()) return;
    const foreign = await seedShift(worldB);
    const a = await close(worldA.owner, foreign.shiftId, { forcedReason: REASON, previewFingerprint: "a".repeat(64) });
    const b = await close(worldA.owner, randomUUID(), { forcedReason: REASON, previewFingerprint: "a".repeat(64) });
    expect([a.status, a.body.error.code]).toEqual([404, "shift_not_found"]);
    expect([b.status, b.body.error.code]).toEqual([404, "shift_not_found"]);
    expect(a.body.error.message).toBe(b.body.error.message);
    expect(await stateOf(foreign.shiftId)).toEqual(STILL_OPEN);
    expect((await preview(worldA.owner, foreign.shiftId)).status).toBe(404);
  });

  it.each([
    ["a store_manager", () => worldA.manager],
    ["a tenant_admin with specific-store access", () => worldA.adminSpecific],
  ])("%s: 404, on the write, the preview and the list, and nothing is written", async (_label, session) => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    const res = await close(session(), shift.shiftId, { forcedReason: REASON, previewFingerprint: "a".repeat(64) });
    expect(res.status).toBe(404);
    expectValid("Error", res.body);
    expect((await preview(session(), shift.shiftId)).status).toBe(404);
    expect((await openShifts(session(), worldA.store)).status).toBe(404);
    expect(await stateOf(shift.shiftId)).toEqual(STILL_OPEN);
    // One refusal for every route and cause: nothing about the shift is disclosed.
    const [write, read] = [res.body.error, (await preview(session(), shift.shiftId)).body.error];
    expect({ code: write.code, message: write.message }).toEqual({ code: read.code, message: read.message });
  });

  it("a bearer credential is 401 (a human cookie session only; the Origin check is SessionOnlyAdminGuard's, covered by its own spec)", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    const bearer = await http().get(`/api/v1/shifts/${shift.shiftId}/force-close-preview`).set("Authorization", "Bearer nope");
    expect(bearer.status).toBe(401);
    const write = await http()
      .post(`/api/v1/shifts/${shift.shiftId}/force-close`)
      .set("Authorization", "Bearer nope")
      .set("Idempotency-Key", key())
      .send({ forcedReason: REASON, previewFingerprint: "a".repeat(64) });
    expect(write.status).toBe(401);
  });
});

describe("consoleForceCloseShift: the preview fingerprint and the replay (criterion 5)", () => {
  it("a stale fingerprint is 409 preview_stale; the fresh one then closes", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    const stale = await fingerprintOf(worldA, shift.shiftId);
    // The recorded facts change after the preview: a sale from the opening terminal.
    await admin().query(
      `INSERT INTO sales (id, tenant_id, store_id, device_id, currency_code, pos_total, occurred_at, business_date,
                          source_system, external_id, payload_hash, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'EGP', 10, now(), current_date, 'rt1445', $4, $5, $6)`,
      [worldA.tenant, worldA.store, shift.deviceId, `ext-${shift.shiftId}`, "a".repeat(64), shift.cashier],
    );
    const res = await close(worldA.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: stale });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("preview_stale");
    expect(await stateOf(shift.shiftId)).toEqual(STILL_OPEN);
    const fresh = await preview(worldA.owner, shift.shiftId);
    expect(fresh.body.recorded.saleCount).toBe(1);
    const ok = await close(worldA.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: fresh.body.previewFingerprint });
    expect(ok.status).toBe(201);
  });

  it("the preview fingerprint is stable between two reads and covers neither evaluatedAt nor ageMinutes", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    const [a, b] = [await preview(worldA.owner, shift.shiftId), await preview(worldA.owner, shift.shiftId)];
    expect(a.body.previewFingerprint).toBe(b.body.previewFingerprint);
    expectValid("ForceClosePreview", a.body);
  });

  it("a malformed fingerprint, a missing reason or an unknown key is 400 validation_error", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    const fp = await fingerprintOf(worldA, shift.shiftId);
    for (const body of [
      { forcedReason: REASON, previewFingerprint: "NOT-HEX" },
      { previewFingerprint: fp },
      { forcedReason: "", previewFingerprint: fp },
      { forcedReason: "x".repeat(201), previewFingerprint: fp },
      { forcedReason: REASON, previewFingerprint: fp, countedCash: "1.00" },
    ]) {
      const res = await close(worldA.owner, shift.shiftId, body);
      expect([res.status, res.body.error?.code]).toEqual([400, "validation_error"]);
    }
    expect((await close(worldA.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: fp }, null)).status).toBe(400);
    expect(await stateOf(shift.shiftId)).toEqual(STILL_OPEN);
  });

  it("the same key replays the stored 201; another key with the same reason is a 200 replay even with a stale fingerprint, writing nothing", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    const fp = await fingerprintOf(worldA, shift.shiftId);
    const k = key();
    const first = await close(worldA.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: fp }, k);
    expect(first.status).toBe(201);
    const sameKey = await close(worldA.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: fp }, k);
    expect([sameKey.status, sameKey.headers["idempotent-replayed"]]).toEqual([201, "true"]);
    // The close changed the state the fingerprint covers; the replay sits before the fingerprint.
    const natural = await close(worldA.admin, shift.shiftId, { forcedReason: REASON, previewFingerprint: fp });
    expect([natural.status, natural.headers["idempotent-replayed"]]).toEqual([200, "true"]);
    expectValid("ConsoleForceClosedShift", natural.body);
    expect(natural.body.forcedClose).toMatchObject({ closedVia: "console", closedByUserId: worldA.ownerUser });
    expect(await auditRows(worldA.tenant, shift.shiftId)).toHaveLength(1);
    expect((await stateOf(shift.shiftId)).forced).toHaveLength(1);
    // Another reason for a force-closed shift is 409 shift_force_closed.
    const other = await close(worldA.owner, shift.shiftId, { forcedReason: "another reason", previewFingerprint: fp });
    expect([other.status, other.body.error.code]).toEqual([409, "shift_force_closed"]);
  });

  it("the preview of a finished shift reports shift_not_open", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    expect((await closeOk(worldA, shift)).status).toBe(201);
    const res = await preview(worldA.owner, shift.shiftId);
    expect(res.status).toBe(200);
    expect(res.body.shift).toMatchObject({ lifecycleState: "closed_forced", verdict: { eligible: false, blockers: ["shift_not_open"] } });
  });
});

describe("the D9 cap (criterion 6)", () => {
  /** A fresh tenant with enough stuck shifts; the cap is per tenant. */
  async function capWorld(label: string): Promise<World> {
    return seedWorld(admin(), label);
  }
  const countedRow = (w: World, action: string, channel: string, minutesAgo = 0): Promise<unknown> =>
    admin().query(
      `INSERT INTO audit_events (id, occurred_at, actor_user_id, tenant_id, action, target_type, target_id, metadata)
       VALUES (gen_random_uuid(), now() - ($5::int * interval '1 minute'), $1, $2, $3, 'x', gen_random_uuid(), $4::jsonb)`,
      [w.ownerUser, w.tenant, action, JSON.stringify({ channel }), minutesAgo],
    );

  it("the 11th first-time force action in an hour is 429 force_action_rate_limited; a replay still answers 200", async () => {
    if (skip()) return;
    const w = await capWorld("cap");
    const shifts: SeededShift[] = [];
    for (let i = 0; i < 11; i += 1) shifts.push(await seedShift(w));
    // A POS-channel row and a legacy-API deletion row never count.
    await countedRow(w, "shift.force_closed", "pos");
    await countedRow(w, "store.deleted", "api");
    for (const shift of shifts.slice(0, 10)) expect((await closeOk(w, shift)).status).toBe(201);
    const eleventh = shifts[10]!;
    const fp = await fingerprintOf(w, eleventh.shiftId);
    const res = await close(w.owner, eleventh.shiftId, { forcedReason: REASON, previewFingerprint: fp });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("force_action_rate_limited");
    expectValid("Error", res.body);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(3600);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toBe(res.body.error.request_id);
    expect(await stateOf(eleventh.shiftId)).toEqual(STILL_OPEN);
    expect(await auditRows(w.tenant, eleventh.shiftId)).toEqual([]);
    // A replay of an earlier close is not a new action: it never counts and never meets the cap.
    const replay = await close(w.owner, shifts[0]!.shiftId, { forcedReason: REASON, previewFingerprint: fp });
    expect([replay.status, replay.headers["idempotent-replayed"]]).toEqual([200, "true"]);
    // Other tenants are unaffected.
    expect((await closeOk(worldA, await seedShift(worldA))).status).toBe(201);
  });

  it("is shared with the console store deletion: nine deletions leave one force close", async () => {
    if (skip()) return;
    const w = await capWorld("shared");
    for (let i = 0; i < 9; i += 1) await countedRow(w, "store.deleted", "console");
    const [one, two] = [await seedShift(w), await seedShift(w)];
    expect((await closeOk(w, one)).status).toBe(201);
    const res = await closeOk(w, two);
    expect([res.status, res.body.error.code]).toEqual([429, "force_action_rate_limited"]);
  });

  it("is a rolling hour: ten actions older than an hour do not count; ten at 59 minutes do, with Retry-After about a minute; a stale fingerprint is 409 before the 429", async () => {
    if (skip()) return;
    const old = await capWorld("window-old");
    for (let i = 0; i < 10; i += 1) await countedRow(old, "store.deleted", "console", 61);
    expect((await closeOk(old, await seedShift(old))).status).toBe(201);

    const w = await capWorld("window-new");
    for (let i = 0; i < 10; i += 1) await countedRow(w, "store.deleted", "console", 59);
    // More than ten (a writer outside the lock): the wait is for the slot that frees first, never the oldest row.
    await countedRow(w, "store.deleted", "console", 2);
    const shift = await seedShift(w);
    const res = await closeOk(w, shift);
    expect(res.status).toBe(429);
    const retry = Number(res.headers["retry-after"]);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(120);
    const stale = await close(w.owner, shift.shiftId, { forcedReason: REASON, previewFingerprint: "0".repeat(64) });
    expect([stale.status, stale.body.error.code]).toEqual([409, "preview_stale"]);
  });

  it("concurrent writers cannot exceed it: at nine counted, three at once close exactly one", async () => {
    if (skip()) return;
    const w = await capWorld("race");
    for (let i = 0; i < 9; i += 1) await countedRow(w, "store.deleted", "console");
    const shifts = [await seedShift(w), await seedShift(w), await seedShift(w)];
    const bodies = await Promise.all(shifts.map(async (s) => ({ s, fp: await fingerprintOf(w, s.shiftId) })));
    const results = await Promise.all(
      bodies.map(({ s, fp }) => close(w.owner, s.shiftId, { forcedReason: REASON, previewFingerprint: fp })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 429, 429]);
  });
});

describe("consoleListOpenShifts and consoleGetForceClosePreview", () => {
  it("lists every open shift newest first with the same verdict the write uses; a nameless cashier is listed with a null name", async () => {
    if (skip()) return;
    const w = await seedWorld(admin(), "list");
    const stuck = await seedShift(w, { cashier: w.ownerUser, minutesAgo: 600 }); // owner user has no display name
    const live = await seedShift(w, { minutesAgo: 400 });
    await seedOperatorSession(w, live);
    const fresh = await seedShift(w, { minutesAgo: 2 });
    await seedShift(w, { store: w.store2 });
    const res = await openShifts(w.owner, w.store);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectValid("OpenShiftList", res.body);
    expect(res.body.staleThresholdMinutes).toBe(15);
    expect(res.body.items.map((i: { shiftId: string }) => i.shiftId)).toEqual([fresh.shiftId, live.shiftId, stuck.shiftId]);
    const byId = new Map<string, any>(res.body.items.map((i: { shiftId: string }) => [i.shiftId, i]));
    expect(byId.get(stuck.shiftId)).toMatchObject({
      cashier: { userId: w.ownerUser, displayName: null },
      verdict: { eligible: true, blockers: [] },
      terminal: { deviceId: stuck.deviceId, trustState: "active" },
    });
    expect(byId.get(live.shiftId).verdict).toMatchObject({ eligible: false, liveOperatorSession: true, blockers: ["live_operator_session"] });
    expect(byId.get(fresh.shiftId).verdict).toMatchObject({ eligible: false, stale: false, blockers: ["not_stale"] });
    // The list and the write agree: the listed-eligible shift closes, the listed-live one does not.
    expect((await closeOk(w, stuck)).status).toBe(201);
    const refused = await close(w.owner, live.shiftId, { forcedReason: REASON, previewFingerprint: await fingerprintOf(w, live.shiftId) });
    expect([refused.status, refused.body.error.code]).toEqual([409, "shift_not_stuck"]);
  });

  it("a deleted, foreign or unknown store is the same 404; a malformed id is 400", async () => {
    if (skip()) return;
    const w = await seedWorld(admin(), "stores");
    const deleted = id();
    await admin().query(`INSERT INTO stores (id, tenant_id, code, name, deleted_at) VALUES ($1, $2, 'DEL', 'Del', now())`, [deleted, w.tenant]);
    for (const store of [deleted, worldB.store, randomUUID()]) {
      expect((await openShifts(w.owner, store)).status).toBe(404);
    }
    expect((await openShifts(w.owner, "not-a-uuid")).status).toBe(400);
    expect((await openShifts(w.owner, w.store)).body).toMatchObject({ storeId: w.store, items: [] });
  });

  it("the preview states recorded counts, never expected cash; a legacy shift has null cash facts", async () => {
    if (skip()) return;
    const shift = await seedShift(worldA);
    await admin().query(
      `INSERT INTO shift_cash_movements (id, shift_id, tenant_id, store_id, device_id, currency_code, kind, amount, reason_code,
                                         occurred_at, recorded_by_user_id, payload_hash)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'EGP', 'pay_in', 20, 'float_top_up', now(), $5, decode(md5('a') || md5('b'), 'hex'))`,
      [shift.shiftId, worldA.tenant, worldA.store, shift.deviceId, shift.cashier],
    );
    const res = await preview(worldA.owner, shift.shiftId);
    expect(res.status).toBe(200);
    expectValid("ForceClosePreview", res.body);
    expect(res.body).toMatchObject({
      reversible: false,
      drawerCashUnaccounted: true,
      caveats: ["offline_facts_not_visible", "terminal_not_notified"],
      recorded: { currencyCode: "EGP", openingFloat: "500.00", cashMovementCount: 1, saleCount: 0, refundExecutionCount: 0 },
      shift: { cashier: { displayName: "Cashier Cat" } },
    });
    for (const forbidden of ["expectedCash", "variance", "countedCash"]) {
      expect(res.body.recorded).not.toHaveProperty(forbidden);
    }
    const legacy = await seedShift(worldA, { legacy: true });
    const l = await preview(worldA.owner, legacy.shiftId);
    expect(l.body.recorded).toMatchObject({ currencyCode: null, openingFloat: null, cashMovementCount: null, lastCashMovementReceivedAt: null });
  });
});

describe("consoleGetOpenShiftsSummary: the tenant-wide counts (RT-1450)", () => {
  interface StoreCounts {
    storeId: string;
    openShiftCount: number;
    staleShiftCount: number;
    eligibleShiftCount: number;
  }

  /** What the per-store open-shifts read says about one store, counted the way the summary must count it. */
  async function countsFromStoreRead(w: World, storeId: string): Promise<StoreCounts> {
    const res = await openShifts(w.owner, storeId);
    expect(res.status).toBe(200);
    const verdicts = res.body.items.map((i: { verdict: { stale: boolean; eligible: boolean } }) => i.verdict);
    return {
      storeId,
      openShiftCount: verdicts.length,
      staleShiftCount: verdicts.filter((v: { stale: boolean }) => v.stale).length,
      eligibleShiftCount: verdicts.filter((v: { eligible: boolean }) => v.eligible).length,
    };
  }

  it("equals the sum of the per-store reads, stale and not stale, eligible and live; deleted stores and other tenants are left out", async () => {
    if (skip()) return;
    const w = await seedWorld(admin(), "rt1450-sum");
    await seedShift(w, { minutesAgo: 600 }); // stale, eligible
    const live = await seedShift(w, { minutesAgo: 400 }); // stale, a live operator session
    await seedOperatorSession(w, live);
    await seedShift(w, { minutesAgo: 2 }); // not stale
    await seedShift(w, { store: w.store2, minutesAgo: 120 }); // stale, eligible
    await seedShift(w, { store: w.store2, minutesAgo: 5 }); // not stale
    const deleted = id();
    await admin().query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'DEL', 'Del')`, [deleted, w.tenant]);
    await seedShift(w, { store: deleted, minutesAgo: 600 });
    await admin().query(`UPDATE stores SET deleted_at = now() WHERE id = $1`, [deleted]);
    await seedShift(worldB, { minutesAgo: 600 }); // another tenant's stuck shift

    const res = await summary(w.owner);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectValid("OpenShiftsSummary", res.body);
    expect(res.body.staleThresholdMinutes).toBe(15);

    // The contract orders stores by id (Postgres uuid order, which is the order of the lower-case strings).
    const expected = [await countsFromStoreRead(w, w.store), await countsFromStoreRead(w, w.store2)].sort((a, b) =>
      a.storeId < b.storeId ? -1 : 1,
    );
    // The per-store reads themselves, pinned, so the equality below cannot hold vacuously.
    const byStore = new Map(expected.map((c) => [c.storeId, c]));
    expect(byStore.get(w.store)).toEqual({ storeId: w.store, openShiftCount: 3, staleShiftCount: 2, eligibleShiftCount: 1 });
    expect(byStore.get(w.store2)).toEqual({ storeId: w.store2, openShiftCount: 2, staleShiftCount: 1, eligibleShiftCount: 1 });

    expect(res.body.stores).toEqual(expected);
    const total = (field: keyof Omit<StoreCounts, "storeId">): number => expected.reduce((n, c) => n + c[field], 0);
    expect(res.body).toMatchObject({
      openShiftCount: total("openShiftCount"),
      staleShiftCount: total("staleShiftCount"),
      eligibleShiftCount: total("eligibleShiftCount"),
      truncated: false,
    });
  });

  it("a tenant with no open shift has zero counts and no store row", async () => {
    if (skip()) return;
    const w = await seedWorld(admin(), "rt1450-empty");
    const res = await summary(w.owner);
    expect(res.status).toBe(200);
    expectValid("OpenShiftsSummary", res.body);
    expect(res.body).toMatchObject({ openShiftCount: 0, staleShiftCount: 0, eligibleShiftCount: 0, truncated: false, stores: [] });
  });

  it("the tenant is the session's: another tenant's caller sees only its own stores", async () => {
    if (skip()) return;
    const w = await seedWorld(admin(), "rt1450-own");
    const other = await seedWorld(admin(), "rt1450-other");
    await seedShift(w, { minutesAgo: 600 });
    await seedShift(other, { store: other.store2, minutesAgo: 600 });
    const mine = await summary(w.owner);
    const theirs = await summary(other.owner);
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
    // Each sees exactly its own store, never the other's: both lists are non-empty, so this cannot pass vacuously.
    expect(mine.body.stores.map((s: StoreCounts) => s.storeId)).toEqual([w.store]);
    expect(theirs.body.stores.map((s: StoreCounts) => s.storeId)).toEqual([other.store2]);
    expect(mine.body.eligibleShiftCount).toBe(1);
    expect(theirs.body.eligibleShiftCount).toBe(1);
  });

  it.each([
    ["a store_manager", () => worldA.manager],
    ["a tenant_admin with specific-store access", () => worldA.adminSpecific],
  ])("%s: the same non-disclosing 404 as the per-store read", async (_label, session) => {
    if (skip()) return;
    const res = await summary(session());
    const sibling = await openShifts(session(), worldA.store);
    expect(res.status).toBe(404);
    expectValid("Error", res.body);
    expect({ code: res.body.error.code, message: res.body.error.message }).toEqual({
      code: sibling.body.error.code,
      message: sibling.body.error.message,
    });
  });

  it("a tenant_admin with all-store access is admitted; a bearer credential is 401", async () => {
    if (skip()) return;
    expect((await summary(worldA.admin)).status).toBe(200);
    expect((await http().get(`/api/v1/open-shifts/summary`).set("Authorization", "Bearer nope")).status).toBe(401);
  });

  it("a platform admin is admitted as on the per-store read (RT-1462), and one cross-tenant row records the request", async () => {
    if (skip()) return;
    const w = await platformWorld();
    const requestId = randomUUID();
    const res = await summary(w.platformBare).set("X-Request-Id", requestId);
    expect(res.status).toBe(200);
    expectValid("OpenShiftsSummary", res.body);
    const rows = await admin().query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'platform.cross_tenant.accessed' AND request_id = $2`,
      [w.tenant, requestId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("a platform admin holding a live support session is admitted too (RT-1462/RT-1468), and the one cross-tenant row names that session", async () => {
    if (skip()) return;
    const w = await platformWorld();
    expect(w.supportSessionId).not.toBe("");
    const requestId = randomUUID();
    const res = await summary(w.platform).set("X-Request-Id", requestId);
    expect(res.status).toBe(200);
    expectValid("OpenShiftsSummary", res.body);
    const rows = await admin().query(
      `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND action = 'platform.cross_tenant.accessed' AND request_id = $2`,
      [w.tenant, requestId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.metadata).toMatchObject({
      actor_kind: "platform_admin",
      outcome: "succeeded",
      support_session_id: w.supportSessionId,
    });
  });
});
