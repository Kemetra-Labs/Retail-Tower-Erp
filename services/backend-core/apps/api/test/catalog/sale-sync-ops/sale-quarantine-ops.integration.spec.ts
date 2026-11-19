/**
 * RT-1312 Phase 3(b), slice B: the Console quarantine routes over HTTP against
 * real Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test`
 * pool, the real module graph: real `TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository` and `IdempotencyModule`; only cookie authentication
 * is faked, by the RT-192 header stand-in).
 *
 * Routes (`sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft):
 *   GET  /quarantined-sales                           consoleListQuarantinedSales
 *   GET  /quarantined-sales/{quarantineRef}           consoleGetQuarantinedSale
 *   POST /quarantined-sales/{quarantineRef}/write-off consoleWriteOffQuarantinedSale
 *
 * What this proves:
 *   - the list is newest-first, open by default, `state` selects resolved
 *     items, a store filter narrows it, and keyset paging is gap-free while
 *     out-of-scope rows are skipped;
 *   - the membership store scope (RT-193) bounds every route: an item of an
 *     ungranted, deleted or foreign store, or no item at all, is the identical
 *     non-disclosing 404; an empty scope lists nothing;
 *   - every body validates against the contract schemas and carries neither
 *     the stored body nor the tenant (decision C5);
 *   - the write-off closes an open item for good (state, resolution time,
 *     note), keeps the body, creates no sale, audits ids only, and is a 409
 *     `repair_conflict` for an item that is not open, with nothing changed;
 *   - two write-offs of one item at once: exactly one wins (the locking read).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";

import type { AuditJobPayload } from "../../../src/audit/audit-job.types";
import { SaleQuarantineOpsService } from "../../../src/catalog/sale-sync-ops/sale-quarantine-ops.service";
import { SaleSyncOpsModule } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.module";
import { RepairConflictError } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.read-model.service";
import { schemaChecker } from "../../_helpers/scoped-http-harness";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../__support__/isolation-harness";
import {
  bootScopedApp,
  NON_EXISTENT,
  S_DELETED,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
  SES_OWNER_SPEC,
  SPECIFIC_SESSIONS,
} from "../erpnext-reconciliation/__support__/read-store-scope";
import { SES_ADMIN_EMPTY, seedSaleSyncStoreScope, SS_X1 } from "./__support__/sale-sync-store-scope";

const BASE = "/api/v1/catalog/sale-sync-ops/quarantined-sales";
const one = (ref: string): string => `${BASE}/${ref}`;
const writeOffPath = (ref: string): string => `${BASE}/${ref}/write-off`;
const NOT_FOUND = { code: "not_found", message: "Not found." };
const conforms = schemaChecker("sale-sync-ops");

// IDs use the `1312` mnemonic (hex only) and are valid UUIDv7 (the list cursor format), ascending in seed order.
const id = (n: number): string => `0a000000-0000-7000-8000-00000131${n.toString(16).padStart(4, "0")}`;
const Q_X1 = id(0x01); // STORE_A_X open
const Q_Y1 = id(0x02); // STORE_A_Y open
const Q_X2 = id(0x03); // STORE_A_X open
const Q_DEL = id(0x04); // S_DELETED open
const Q_XC = id(0x05); // STORE_A_X captured (SS_X1)
const Q_XW = id(0x06); // STORE_A_X written-off
const Q_X3 = id(0x07); // STORE_A_X open: written off by a specific-membership owner
const Q_X4 = id(0x08); // STORE_A_X open: refused-body validation cases
const Q_X5 = id(0x09); // STORE_A_X open: the concurrency case
const Q_B = "0b000000-0000-7000-8000-000000131001"; // tenant B, STORE_B_X open
const MISSING = id(0xff);
const BODY_MARK = "BODY-MARK-must-never-be-projected";

const DEVICES: ReadonlyArray<readonly [string, string, string]> = [
  [id(0xd1), TENANT_A, STORE_A_X],
  [id(0xd2), TENANT_A, STORE_A_Y],
  [id(0xd3), TENANT_A, S_DELETED],
  ["0b000000-0000-7000-8000-000000131d01", TENANT_B, STORE_B_X],
];
const DEVICE_OF: Record<string, string> = {
  [STORE_A_X]: id(0xd1),
  [STORE_A_Y]: id(0xd2),
  [S_DELETED]: id(0xd3),
  [STORE_B_X]: "0b000000-0000-7000-8000-000000131d01",
};

interface Seed {
  readonly ref: string;
  readonly tenant: string;
  readonly store: string;
  readonly state?: "open" | "captured" | "written-off";
  readonly saleId?: string;
}

const ITEMS: readonly Seed[] = [
  { ref: Q_X1, tenant: TENANT_A, store: STORE_A_X },
  { ref: Q_Y1, tenant: TENANT_A, store: STORE_A_Y },
  { ref: Q_X2, tenant: TENANT_A, store: STORE_A_X },
  { ref: Q_DEL, tenant: TENANT_A, store: S_DELETED },
  { ref: Q_XC, tenant: TENANT_A, store: STORE_A_X, state: "captured", saleId: SS_X1 },
  { ref: Q_XW, tenant: TENANT_A, store: STORE_A_X, state: "written-off" },
  { ref: Q_X3, tenant: TENANT_A, store: STORE_A_X },
  { ref: Q_X4, tenant: TENANT_A, store: STORE_A_X },
  { ref: Q_X5, tenant: TENANT_A, store: STORE_A_X },
  { ref: Q_B, tenant: TENANT_B, store: STORE_B_X },
];

async function seedItems(admin: Pool): Promise<void> {
  for (const [deviceId, tenant, store] of DEVICES) {
    await admin.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'rt1312-till', $4)`,
      [deviceId, tenant, store, `rt1312-token-hash-${deviceId}`],
    );
  }
  for (const item of ITEMS) {
    const state = item.state ?? "open";
    await admin.query(
      `INSERT INTO sale_quarantine_items
         (id, tenant_id, store_id, device_id, source_system, external_id, idempotency_key, reason_kind,
          till_http_status, till_error_code, till_recorded_at, sale_body, facts_digest,
          summary_occurred_at, summary_pos_total, summary_currency_code, summary_line_count,
          state, resolved_at, sale_id, write_off_note)
       VALUES ($1, $2, $3, $4, 'pos-pulse', $5, $6, 'refused', 422, 'sale_tender_mismatch', now(),
               $7::jsonb, $8, '2026-11-11T09:00:00Z', '125.50', 'EGP', 2,
               $9, CASE WHEN $9 = 'open' THEN NULL ELSE now() END, $10,
               CASE WHEN $9 = 'written-off' THEN 'handled outside' ELSE NULL END)`,
      [
        item.ref,
        item.tenant,
        item.store,
        DEVICE_OF[item.store],
        `rt1312-${item.ref}`,
        `rt1312-capture-key-${item.ref}`,
        JSON.stringify({ sourceSystem: "pos-pulse", externalId: `rt1312-${item.ref}`, note: BODY_MARK, lines: [{}, {}] }),
        "a".repeat(64),
        state,
        item.saleId ?? null,
      ],
    );
  }
}

interface ItemState {
  state: string;
  resolved_at: Date | null;
  write_off_note: string | null;
  sale_id: string | null;
  sale_body: unknown;
  repair_count: number;
}

async function itemState(admin: Pool, ref: string): Promise<ItemState> {
  const r = await admin.query<ItemState>(
    `SELECT state, resolved_at, write_off_note, sale_id, sale_body, repair_count
       FROM sale_quarantine_items WHERE id = $1`,
    [ref],
  );
  return r.rows[0]!;
}

const salesCount = async (admin: Pool): Promise<number> =>
  Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM sales`)).rows[0]!.n);

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;
const audited: AuditJobPayload[] = [];

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedSaleSyncStoreScope(env);
    await seedItems(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1312 sale-quarantine-ops] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  app = await bootScopedApp(env, SaleSyncOpsModule, {
    enqueue: async (payload) => {
      audited.push(payload);
    },
  });
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1312 sale-quarantine-ops] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(path: string, session: string, query: Record<string, string | number> = {}): request.Test {
  return request(app!.getHttpServer()).get(path).set("x-test-session", session).query(query);
}

let keySeq = 0;
/** A write-off with its own Idempotency-Key (one request at a time: supertest shares the not-yet-listening server). */
function writeOff(ref: string, session: string, body: object = { note: "refunded in cash outside Retail Tower" }): request.Test {
  keySeq += 1;
  return request(app!.getHttpServer())
    .post(writeOffPath(ref))
    .set("x-test-session", session)
    .set("Idempotency-Key", `rt1312-write-off-key-${String(keySeq).padStart(4, "0")}`)
    .send(body);
}

/** Walk the list to its end at `page_size`; the refs, in order. */
async function walk(session: string, pageSize: number, query: Record<string, string> = {}): Promise<string[]> {
  const refs: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const res: request.Response = await get(BASE, session, {
      ...query,
      page_size: pageSize,
      ...(cursor ? { cursor } : {}),
    }).expect(200);
    conforms("QuarantinedSalePage", res.body);
    refs.push(...(res.body.items as Array<{ quarantineRef: string }>).map((i) => i.quarantineRef));
    cursor = res.body.nextCursor;
    if (cursor === null) return refs;
  }
  throw new Error("quarantine paging did not terminate");
}

/** The open items of tenant A, newest-first, while the write-off cases have not run. */
const ALL_OPEN = [Q_X5, Q_X4, Q_X3, Q_DEL, Q_X2, Q_Y1, Q_X1];
const SPECIFIC_OPEN = [Q_X5, Q_X4, Q_X3, Q_X2, Q_X1];
const OUT_OF_SCOPE = [Q_Y1, Q_DEL, Q_B, MISSING];
const OUT_OF_SCOPE_STORES = [STORE_A_Y, S_DELETED, STORE_B_X, NON_EXISTENT];
const ALL_OWNERS: ReadonlyArray<readonly [string, string]> = [
  ["no active store", SES_OWNER_ALL],
  ["an active store", SES_OWNER_ALL_ACTIVE],
];

// ---------------------------------------------------------------------------
// consoleListQuarantinedSales
// ---------------------------------------------------------------------------

describe("RT-1312 consoleListQuarantinedSales", () => {
  it.each(ALL_OWNERS)("an all-membership owner with %s lists every store's open items newest-first", async (_label, session) => {
    if (skip()) return;
    expect(await walk(session, 100)).toEqual(ALL_OPEN);
  });

  it.each(SPECIFIC_SESSIONS)("a specific-membership %s lists only the granted store", async (_role, session) => {
    if (skip()) return;
    expect(await walk(session, 100)).toEqual(SPECIFIC_OPEN);
  });

  it.each([1, 2])("paging at page_size %i stays gap-free while out-of-scope rows are skipped", async (pageSize) => {
    if (skip()) return;
    expect(await walk(SES_OWNER_SPEC, pageSize)).toEqual(SPECIFIC_OPEN);
    expect(await walk(SES_OWNER_ALL, pageSize)).toEqual(ALL_OPEN);
  });

  it("state selects the resolved items, which are retained and listed on request", async () => {
    if (skip()) return;
    expect(await walk(SES_OWNER_ALL, 10, { state: "captured" })).toEqual([Q_XC]);
    expect(await walk(SES_OWNER_ALL, 10, { state: "written-off" })).toEqual([Q_XW]);
    expect(await walk(SES_OWNER_ALL, 10, { state: "already-captured" })).toEqual([]);
    expect(await walk(SES_OWNER_ALL, 10, { state: "open" })).toEqual(ALL_OPEN);
  });

  it("an in-scope store_id filter narrows the list", async () => {
    if (skip()) return;
    expect(await walk(SES_OWNER_ALL, 1, { store_id: STORE_A_Y })).toEqual([Q_Y1]);
    expect(await walk(SES_OWNER_SPEC, 1, { store_id: STORE_A_X })).toEqual(SPECIFIC_OPEN);
  });

  it.each(SPECIFIC_SESSIONS)(
    "a specific-membership %s: out-of-scope, deleted, foreign and missing store_id filters are the identical 404",
    async (_role, session) => {
      if (skip()) return;
      for (const store_id of OUT_OF_SCOPE_STORES) {
        const res = await get(BASE, session, { store_id }).expect(404);
        expect(res.body.error).toMatchObject(NOT_FOUND);
      }
    },
  );

  it("an empty store scope lists nothing", async () => {
    if (skip()) return;
    expect((await get(BASE, SES_ADMIN_EMPTY).expect(200)).body).toEqual({ items: [], nextCursor: null });
  });

  it("projects the contract's QuarantinedSale and never the stored body or the tenant", async () => {
    if (skip()) return;
    const res = await get(BASE, SES_OWNER_ALL, { store_id: STORE_A_Y }).expect(200);
    expect(res.body.items).toEqual([
      {
        quarantineRef: Q_Y1,
        storeId: STORE_A_Y,
        deviceId: id(0xd2),
        sourceSystem: "pos-pulse",
        externalId: `rt1312-${Q_Y1}`,
        reasonKind: "refused",
        tillHttpStatus: 422,
        tillErrorCode: "sale_tender_mismatch",
        state: "open",
        receivedAt: expect.any(String),
        tillRecordedAt: expect.any(String),
        previousTerminalId: null,
        repairCount: 0,
        lastRepair: null,
        uploadConflictCount: 0,
        saleRef: null,
        summary: { occurredAt: "2026-11-11T09:00:00.000Z", posTotal: "125.50", currencyCode: "EGP", lineCount: 2 },
        writeOff: null,
      },
    ]);
    const everything = JSON.stringify((await get(BASE, SES_OWNER_ALL, { state: "captured" })).body) + JSON.stringify(res.body);
    expect(everything).not.toContain(BODY_MARK);
    expect(everything).not.toContain(TENANT_A);
  });

  it.each<[string, Record<string, string | number>]>([
    ["an unknown state", { state: "dismissed" }],
    ["a non-v7 cursor", { cursor: "0190f0f0-0000-4000-8000-00000000c001" }],
    ["a page_size above 200", { page_size: 201 }],
    ["a page_size of 0", { page_size: 0 }],
    ["a smuggled tenant_id", { tenant_id: TENANT_B }],
    ["a malformed store_id", { store_id: "not-a-uuid" }],
  ])("%s is a 400", async (_label, query) => {
    if (skip()) return;
    const res = await get(BASE, SES_OWNER_ALL, query).expect(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("is 401 without a session", async () => {
    if (skip()) return;
    await request(app!.getHttpServer()).get(BASE).expect(401);
    await request(app!.getHttpServer()).get(one(Q_X1)).expect(401);
    await request(app!.getHttpServer())
      .post(writeOffPath(Q_X1))
      .set("Idempotency-Key", "rt1312-no-session-key-0001")
      .send({ note: "no session" })
      .expect(401);
    expect(await itemState(env!.admin, Q_X1)).toMatchObject({ state: "open" });
  });
});

// ---------------------------------------------------------------------------
// consoleGetQuarantinedSale
// ---------------------------------------------------------------------------

describe("RT-1312 consoleGetQuarantinedSale", () => {
  it.each(SPECIFIC_SESSIONS)("a specific-membership %s reads an item of the granted store, in any state", async (_role, session) => {
    if (skip()) return;
    for (const ref of [Q_X1, Q_XC, Q_XW]) {
      const res = await get(one(ref), session).expect(200);
      conforms("QuarantinedSale", res.body);
      expect(res.body.quarantineRef).toBe(ref);
    }
  });

  it("a captured item carries its sale, a written-off one its write-off", async () => {
    if (skip()) return;
    expect((await get(one(Q_XC), SES_OWNER_ALL).expect(200)).body).toMatchObject({
      state: "captured",
      saleRef: SS_X1,
      writeOff: null,
    });
    expect((await get(one(Q_XW), SES_OWNER_ALL).expect(200)).body).toMatchObject({
      state: "written-off",
      saleRef: null,
      writeOff: { at: expect.any(String), note: "handled outside" },
    });
  });

  it.each(SPECIFIC_SESSIONS)(
    "a specific-membership %s: other-store, deleted-store, foreign and missing items are the identical 404",
    async (_role, session) => {
      if (skip()) return;
      for (const ref of OUT_OF_SCOPE) {
        const res = await get(one(ref), session).expect(404);
        expect(res.body.error).toMatchObject(NOT_FOUND);
      }
    },
  );

  it.each(ALL_OWNERS)("an all-membership owner with %s reads every store's items", async (_label, session) => {
    if (skip()) return;
    for (const ref of [Q_X1, Q_Y1, Q_DEL]) expect((await get(one(ref), session).expect(200)).body.quarantineRef).toBe(ref);
  });

  it("another tenant's item is 404 even for an all-membership owner, and an empty scope fails closed", async () => {
    if (skip()) return;
    expect((await get(one(Q_B), SES_OWNER_ALL).expect(404)).body.error).toMatchObject(NOT_FOUND);
    expect((await get(one(Q_X1), SES_ADMIN_EMPTY).expect(404)).body.error).toMatchObject(NOT_FOUND);
  });

  it("a malformed ref is a 400, not a 404", async () => {
    if (skip()) return;
    expect((await get(one("nope"), SES_OWNER_ALL).expect(400)).body.error.code).toBe("validation_error");
  });
});

// ---------------------------------------------------------------------------
// consoleWriteOffQuarantinedSale: last, the successful write-offs change the queue.
// ---------------------------------------------------------------------------

describe("RT-1312 consoleWriteOffQuarantinedSale", () => {
  const UNTOUCHED = { state: "open", resolved_at: null, write_off_note: null, sale_id: null, repair_count: 0 };

  it.each(SPECIFIC_SESSIONS)(
    "a specific-membership %s: an out-of-scope write-off is the identical 404 and writes nothing",
    async (_role, session) => {
      if (skip()) return;
      const before = audited.length;
      for (const ref of OUT_OF_SCOPE) {
        const res = await writeOff(ref, session).expect(404);
        expect(res.body.error).toMatchObject(NOT_FOUND);
      }
      for (const ref of [Q_Y1, Q_DEL, Q_B]) expect(await itemState(env!.admin, ref)).toMatchObject(UNTOUCHED);
      expect(audited.slice(before)).toEqual([]);
    },
  );

  it("an empty store scope cannot write off", async () => {
    if (skip()) return;
    await writeOff(Q_X1, SES_ADMIN_EMPTY).expect(404);
    expect(await itemState(env!.admin, Q_X1)).toMatchObject(UNTOUCHED);
  });

  it("another tenant's item is 404 even for an all-membership owner", async () => {
    if (skip()) return;
    await writeOff(Q_B, SES_OWNER_ALL).expect(404);
    expect(await itemState(env!.admin, Q_B)).toMatchObject(UNTOUCHED);
  });

  it("is 400 without an Idempotency-Key, and writes nothing", async () => {
    if (skip()) return;
    const res = await request(app!.getHttpServer())
      .post(writeOffPath(Q_X4))
      .set("x-test-session", SES_OWNER_SPEC)
      .send({ note: "no key" })
      .expect(400);
    expect(res.body.error.code).toBe("idempotency_key_required");
    expect(await itemState(env!.admin, Q_X4)).toMatchObject(UNTOUCHED);
  });

  it.each<[string, unknown]>([
    ["no note", {}],
    ["an empty note", { note: "" }],
    ["a note of 501 characters", { note: "x".repeat(501) }],
    ["a NUL in the note", { note: "a\u0000b" }],
    ["a state in the body", { note: "ok", state: "captured" }],
    ["a tenant in the body", { note: "ok", tenant_id: TENANT_B }],
  ])("%s is a 400 validation_error and writes nothing", async (_label, body) => {
    if (skip()) return;
    const res = await writeOff(Q_X4, SES_OWNER_SPEC, body as object).expect(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(await itemState(env!.admin, Q_X4)).toMatchObject(UNTOUCHED);
  });

  it("a malformed ref is a 400", async () => {
    if (skip()) return;
    expect((await writeOff("nope", SES_OWNER_SPEC).expect(400)).body.error.code).toBe("validation_error");
  });

  it("a specific-membership owner writes off an open item of the granted store, with no sale and the body kept", async () => {
    if (skip()) return;
    const salesBefore = await salesCount(env!.admin);
    const auditBefore = audited.length;
    // 200 exactly, as the contract documents (a bare POST would answer 201).
    const res = await writeOff(Q_X3, SES_OWNER_SPEC, { note: "refunded in cash outside Retail Tower" }).expect(200);
    conforms("QuarantinedSale", res.body);
    expect(res.body).toMatchObject({
      quarantineRef: Q_X3,
      storeId: STORE_A_X,
      state: "written-off",
      saleRef: null,
      writeOff: { at: expect.any(String), note: "refunded in cash outside Retail Tower" },
    });
    const row = await itemState(env!.admin, Q_X3);
    expect(row).toMatchObject({ state: "written-off", write_off_note: "refunded in cash outside Retail Tower", sale_id: null, repair_count: 0 });
    expect(row.resolved_at).not.toBeNull();
    // Decision P3: a written-off item keeps its body (for a paid sale never recorded it is the only evidence).
    expect(row.sale_body).toMatchObject({ note: BODY_MARK });
    // No sale, posting intent or stock effect.
    expect(await salesCount(env!.admin)).toBe(salesBefore);
    const events = audited.slice(auditBefore).filter((a) => a.action === "sale_sync_ops.quarantine.written_off");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenant_id: TENANT_A,
      metadata: { quarantine_ref: Q_X3, store_id: STORE_A_X, state: "written-off" },
    });
    expect(JSON.stringify(events[0])).not.toContain("refunded in cash");
    // The queue no longer lists it, and the resolved list does.
    expect(await walk(SES_OWNER_SPEC, 100)).not.toContain(Q_X3);
    expect(await walk(SES_OWNER_SPEC, 100, { state: "written-off" })).toEqual([Q_X3, Q_XW]);
  });

  it("a second write-off of the same item is 409 repair_conflict and keeps the first note", async () => {
    if (skip()) return;
    const res = await writeOff(Q_X3, SES_OWNER_SPEC, { note: "a different note" }).expect(409);
    expect(res.body.error.code).toBe("repair_conflict");
    expect((await itemState(env!.admin, Q_X3)).write_off_note).toBe("refunded in cash outside Retail Tower");
  });

  it.each([
    ["captured", Q_XC],
    ["written-off", Q_XW],
  ])("an item already %s is 409 repair_conflict, with nothing changed", async (state, ref) => {
    if (skip()) return;
    const before = await itemState(env!.admin, ref);
    const res = await writeOff(ref, SES_OWNER_ALL).expect(409);
    expect(res.body.error.code).toBe("repair_conflict");
    expect(await itemState(env!.admin, ref)).toEqual(before);
    expect(before.state).toBe(state);
  });

  it("an all-membership owner with an active store still writes off another store's item, as a tenant_admin may too", async () => {
    if (skip()) return;
    await writeOff(Q_Y1, SES_OWNER_ALL_ACTIVE).expect(200);
    expect((await itemState(env!.admin, Q_Y1)).state).toBe("written-off");
    const admin = SPECIFIC_SESSIONS.find(([role]) => role === "tenant_admin")![1];
    await writeOff(Q_X2, admin).expect(200);
    expect((await itemState(env!.admin, Q_X2)).state).toBe("written-off");
  });

  it("two write-offs of one item at once: exactly one wins, the other is a conflict (the locking read)", async () => {
    if (skip()) return;
    // The real service over the app pool, with the role lookup stubbed: HTTP cannot run two requests at once here.
    const service = new SaleQuarantineOpsService(env!.app, { findRoleCodeForUserInTenant: async () => "owner" } as never);
    const caller = {
      tenantId: TENANT_A,
      context: {
        tenantId: TENANT_A,
        storeId: null,
        userId: "0a000000-0000-7000-8000-000000131f01",
        isPlatformAdmin: false,
        source: "session",
        storeAccess: { kind: "all" },
      },
    } as never;
    const results = await Promise.allSettled([service.writeOff(caller, Q_X5, "first"), service.writeOff(caller, Q_X5, "second")]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(RepairConflictError);
    const row = await itemState(env!.admin, Q_X5);
    expect(row.state).toBe("written-off");
    expect(["first", "second"]).toContain(row.write_off_note);
  });
});
