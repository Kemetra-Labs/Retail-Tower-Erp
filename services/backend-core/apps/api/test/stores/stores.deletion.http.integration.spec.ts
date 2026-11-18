/**
 * RT-1439 (RT-1437 B2) — the guarded, audited store deletion, end to end.
 *
 * Real Postgres (every migration) through the Nest HTTP pipeline on the non-superuser app role
 * (RLS in force), the real `IdempotencyInterceptor`, and an in-memory Redis for the grant.
 *
 * What this spec proves (acceptance criteria of RT-1439):
 *   1. a store with an open shift, a non-retired device, a non-zero or unknown queue or an open
 *      Count Session is refused with the NAMED 409, on the new route AND on the legacy DELETE;
 *      nothing is deleted, no audit row is written, no grant is spent;
 *   2. a clean store is deleted and writes exactly one `store.deleted` audit row (console and api);
 *   3. the deletion request needs the re-authentication grant;
 *   4. a tenant_admin, another tenant's owner and a platform admin are refused;
 *   5. the preview matches what the write evaluates; a stale fingerprint is 409 `preview_stale`;
 *   + replay, the hourly cap (D9), and that the preview writes nothing.
 */
import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { PoolClient } from "pg";

import type { DeviceScope } from "../../src/pos-cashier-admissions/device-scope";
import { ShiftCashUpRepository, type NewCashUpShift } from "../../src/pos-shifts/shift-cash-up.repository";
import { ACME_ID, GLOBEX_ID, startHarness, USERS, type Harness } from "../_helpers/store-deletion-app";
import { SAME_ORIGIN } from "../_helpers/same-origin";

const sid = (n: number): string => `10000000-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const did = (n: number): string => `30000000-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

const STORE = {
  cleanConsole: sid(1),
  cleanLegacy: sid(2),
  allBlockers: sid(3),
  shiftOnly: sid(4),
  deviceActive: sid(5),
  deviceUnknownQueue: sid(6),
  retiredFrozen: sid(7),
  countOnly: sid(8),
  stale: sid(9),
  replay: sid(10),
  cap: sid(11),
  deviceRevoked: sid(12),
  roles: sid(13),
  noGrant: sid(14),
  unblock: sid(15),
  preview: sid(16),
  manyDevices: sid(17),
  manyRetired: sid(18),
  globex: "20000000-bbbb-4bbb-8bbb-000000000001",
};
const DEVICE = {
  allBlockers: did(3),
  shiftOnly: did(4),
  active: did(5),
  unknownQueue: did(6),
  retiredFrozen: did(7),
  revoked: did(12),
  unblock: did(15),
};
const CLERK_ID = "66666666-6666-4666-8666-666666666666";
const shifts = new ShiftCashUpRepository();
let h: Harness;
/** The same-key deletion of `STORE.replay`, retried after the cap is spent. */
let replayCall: { cookie: string; key: string; body: { previewFingerprint: string; reauthToken: string } } | null = null;

function skip(): boolean {
  if (h.skipped) {
    // eslint-disable-next-line no-console
    console.warn("[store-deletion] skipping (Docker unavailable)");
  }
  return h.skipped;
}

function newShift(): NewCashUpShift {
  const shiftId = randomUUID();
  return {
    shiftId,
    openedAt: new Date("2026-10-05T08:00:00Z").toISOString(),
    openingUserId: USERS.owner.id,
    currencyCode: "EGP",
    openingFloat: "500.00",
    recordedByUserId: USERS.owner.id,
    payloadHash: createHash("sha256").update(`open:${shiftId}`).digest(),
  };
}

async function seed(pg: import("pg").Pool): Promise<void> {
  const names: Array<[string, string]> = Object.entries(STORE).filter(([k]) => k !== "globex").map(([k, id]) => [id, k]);
  for (const [id, key] of names) {
    await pg.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`, [id, ACME_ID, `D-${key}`]);
  }
  await pg.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'G-1', 'Globex 1')`, [STORE.globex, GLOBEX_ID]);

  const device = async (
    id: string,
    storeId: string,
    state: "active" | "revoked" | "retired",
    queue: { pending: number; deadLetter: number; held: number } | null,
  ): Promise<void> => {
    await pg.query(
      `INSERT INTO devices (id, tenant_id, store_id, token_hash, label, revoked_at, retired_at, retire_reason)
       VALUES ($1, $2, $3, $6, $4,
               CASE WHEN $5::text IN ('revoked', 'retired') THEN now() END,
               CASE WHEN $5::text = 'retired' THEN now() END,
               CASE WHEN $5::text = 'retired' THEN 'closed' END)`,
      [id, ACME_ID, storeId, `till-${id.slice(-3)}`, state, createHash("sha256").update(id).digest()],
    );
    if (queue !== null) {
      await pg.query(
        `INSERT INTO device_health (device_id, tenant_id, last_seen_at, sale_queue_pending, sale_queue_dead_letter, sale_queue_held)
         VALUES ($1, $2, now(), $3, $4, $5)`,
        [id, ACME_ID, queue.pending, queue.deadLetter, queue.held],
      );
    }
  };
  const zero = { pending: 0, deadLetter: 0, held: 0 };
  await device(DEVICE.allBlockers, STORE.allBlockers, "active", { pending: 2, deadLetter: 0, held: 0 });
  await device(DEVICE.shiftOnly, STORE.shiftOnly, "retired", zero);
  await device(DEVICE.active, STORE.deviceActive, "active", zero);
  await device(DEVICE.unknownQueue, STORE.deviceUnknownQueue, "active", null);
  await device(DEVICE.retiredFrozen, STORE.retiredFrozen, "retired", { pending: 5, deadLetter: 1, held: 0 });
  await device(DEVICE.revoked, STORE.deviceRevoked, "revoked", zero);
  await device(DEVICE.unblock, STORE.unblock, "active", zero);

  // More devices than the preview's cap (500): 500 retired ones that sort first, then ONE active till past the cap.
  await pg.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash, revoked_at, retired_at, retire_reason)
     SELECT ('31000000-aaaa-4aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, $1, $2,
            decode(md5(g::text) || md5(g::text), 'hex'), now(), now(), 'closed'
       FROM generate_series(1, 500) g`,
    [ACME_ID, STORE.manyDevices],
  );
  await device("31000000-aaaa-4aaa-8aaa-000000000900", STORE.manyDevices, "active", zero);
  // 501 retired devices (one past the preview cap): deletable, and the audit records the EXACT total.
  await pg.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash, revoked_at, retired_at, retire_reason)
     SELECT ('32000000-aaaa-4aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, $1, $2,
            decode(md5('r' || g::text) || md5('r' || g::text), 'hex'), now(), now(), 'closed'
       FROM generate_series(1, 501) g`,
    [ACME_ID, STORE.manyRetired],
  );

  for (const storeId of [STORE.allBlockers, STORE.countOnly]) {
    await pg.query(
      `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by)
       VALUES (gen_random_uuid(), $1, $2, ARRAY[gen_random_uuid()], $3)`,
      [ACME_ID, storeId, USERS.owner.id],
    );
  }
  await pg.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'Stores - RT', $3, 1)`,
    [ACME_ID, STORE.allBlockers, USERS.owner.id],
  );
  // A member whose only store is the one being previewed.
  const roleId = (await pg.query<{ id: string }>(`SELECT id FROM roles WHERE tenant_id = $1 AND code = 'store_manager'`, [ACME_ID])).rows[0]!.id;
  await pg.query(`INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ($1, 'clerk@example.com', NULL, false)`, [CLERK_ID]);
  const membershipId = randomUUID();
  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, 'specific')`,
    [membershipId, ACME_ID, CLERK_ID, roleId],
  );
  await pg.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [membershipId, STORE.allBlockers, ACME_ID]);

  // Open shifts, opened through the real repository on the tenant-scoped client.
  const open = async (storeId: string, deviceId: string): Promise<void> => {
    const scope: DeviceScope = { tenantId: ACME_ID, storeId, deviceId };
    await runWithTenantContext(
      h.env.app,
      { tenantId: ACME_ID, isPlatformAdmin: false },
      async (client: PoolClient) => {
        const outcome = await shifts.insertShift(client, scope, newShift());
        if (outcome.kind !== "inserted") throw new Error(`open failed: ${outcome.kind}`);
      },
    );
  };
  await open(STORE.allBlockers, DEVICE.allBlockers);
  await open(STORE.shiftOnly, DEVICE.shiftOnly);
}

beforeAll(async () => {
  // `seed` needs the app pool for the shift inserts, so it runs after the harness has built `env`.
  let admin: import("pg").Pool | null = null;
  h = await startHarness(async (pg) => {
    admin = pg;
  });
  if (h.skipped) return;
  await seed(admin as unknown as import("pg").Pool);
}, 240_000);

afterAll(async () => {
  if (h && !h.skipped) await h.close();
}, 60_000);

// ---- Helpers ------------------------------------------------------------

const idemKey = (): string => `idem-${randomUUID()}`;

async function deletedAt(storeId: string): Promise<Date | null> {
  const r = await h.admin.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM stores WHERE id = $1`, [storeId]);
  return r.rows[0]?.deleted_at ?? null;
}

async function auditRows(storeId: string): Promise<Array<{ metadata: Record<string, unknown>; actor_user_id: string }>> {
  const r = await h.admin.query(
    `SELECT metadata, actor_user_id FROM audit_events WHERE action = 'store.deleted' AND store_id = $1`,
    [storeId],
  );
  return r.rows;
}

function preview(cookie: string, storeId: string) {
  return h.http().get(`/api/v1/stores/${storeId}/deletion-preview`).set("Cookie", cookie);
}

function consoleDelete(
  cookie: string,
  storeId: string,
  body: { reason?: string; previewFingerprint: string; reauthToken: string },
  key: string = idemKey(),
) {
  return h
    .http()
    .post(`/api/v1/stores/${storeId}/deletion`)
    .set("Cookie", cookie)
    .set(SAME_ORIGIN)
    .set("Idempotency-Key", key)
    .send({ reason: "Closed branch; all tills retired", ...body });
}

/** Preview, then the grant, ready to send to `consoleDelete`. */
async function ready(cookie: string, storeId: string) {
  const p = await preview(cookie, storeId).expect(200);
  const reauthToken = await h.grantFor(cookie, storeId, USERS.owner.password);
  return { previewFingerprint: (p.body as { previewFingerprint: string }).previewFingerprint, reauthToken, preview: p.body };
}

const errorOf = (res: { body: unknown }) => (res.body as { error: { code: string; details?: { blockers: Array<{ code: string; count: number }> } } }).error;

// ===== 2. a clean store, 3. the grant ======================================

describe("consoleDeleteStore: a clean store", () => {
  it("deletes it and writes exactly one store.deleted row, with the preview's fingerprint", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const { previewFingerprint, reauthToken, preview: p } = await ready(owner, STORE.cleanConsole);
    expect(p).toMatchObject({ canDelete: true, blockers: [], reversible: false, reversibleAlternative: "suspend_store" });

    const res = await consoleDelete(owner, STORE.cleanConsole, { previewFingerprint, reauthToken, reason: "Branch closed" }).expect(200);
    expect(res.body).toMatchObject({ storeId: STORE.cleanConsole });
    expect(await deletedAt(STORE.cleanConsole)).not.toBeNull();

    const rows = await auditRows(STORE.cleanConsole);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(USERS.owner.id);
    expect(rows[0]!.metadata).toMatchObject({
      channel: "console",
      actor_role: "owner",
      reason: "Branch closed",
      preview_fingerprint: previewFingerprint,
      before: { name: "D-cleanConsole", code: "D-cleanConsole", is_active: true, device_count: 0, open_shift_count: 0 },
    });
    expect((rows[0]!.metadata["after"] as { deleted_at: string }).deleted_at).toBe((res.body as { deletedAt: string }).deletedAt);
    // No password, grant or token anywhere in the audit metadata.
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(reauthToken);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(USERS.owner.password);
  });

  it("a second request for the deleted store under a NEW key is the 404", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const token = await h.grantFor(owner, STORE.unblock, USERS.owner.password);
    const res = await consoleDelete(owner, STORE.cleanConsole, { previewFingerprint: "a".repeat(64), reauthToken: token });
    expect(res.status).toBe(404);
    expect(await auditRows(STORE.cleanConsole)).toHaveLength(1);
  });

  it("the same Idempotency-Key replays the stored 200 and writes nothing more", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const { previewFingerprint, reauthToken } = await ready(owner, STORE.replay);
    const key = idemKey();
    replayCall = { cookie: owner, key, body: { previewFingerprint, reauthToken } };
    const first = await consoleDelete(owner, STORE.replay, { previewFingerprint, reauthToken }, key).expect(200);
    const again = await consoleDelete(owner, STORE.replay, { previewFingerprint, reauthToken }, key).expect(200);
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(await auditRows(STORE.replay)).toHaveLength(1);
  });
});

describe("consoleDeleteStore: the re-authentication grant is required (AC3)", () => {
  it.each([
    ["a token that was never issued", "A".repeat(43)],
    ["a malformed token", "short"],
  ])("refuses %s and deletes nothing", async (_name, token) => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const p = await preview(owner, STORE.noGrant).expect(200);
    const res = await consoleDelete(owner, STORE.noGrant, {
      previewFingerprint: (p.body as { previewFingerprint: string }).previewFingerprint,
      reauthToken: token,
    });
    expect(res.status).toBe(token === "short" ? 400 : 403);
    if (token !== "short") expect(errorOf(res).code).toBe("reauth_required");
    expect(await deletedAt(STORE.noGrant)).toBeNull();
  });

  it("a missing token or reason is a 400, and a password in the body is an unknown key", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const base = h.http().post(`/api/v1/stores/${STORE.noGrant}/deletion`).set("Cookie", owner).set(SAME_ORIGIN);
    await base.set("Idempotency-Key", idemKey()).send({ reason: "x", previewFingerprint: "a".repeat(64) }).expect(400);
    const res = await h
      .http()
      .post(`/api/v1/stores/${STORE.noGrant}/deletion`)
      .set("Cookie", owner)
      .set(SAME_ORIGIN)
      .set("Idempotency-Key", idemKey())
      .send({ reason: "x", previewFingerprint: "a".repeat(64), reauthToken: "A".repeat(43), password: "Hunter2-secret-value" })
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain("Hunter2-secret-value");
    await h.http().post(`/api/v1/stores/${STORE.noGrant}/deletion`).set("Cookie", owner).set(SAME_ORIGIN).send({}).expect(400);
  });
});

// ===== 1. the four guards, on both paths ===================================

describe("the four guards refuse with the named 409, on both paths (AC1)", () => {
  const CASES: Array<[string, string, string, string[]]> = [
    ["an open shift", STORE.shiftOnly, "store_has_open_shift", ["store_has_open_shift"]],
    ["an active device", STORE.deviceActive, "store_has_unretired_device", ["store_has_unretired_device"]],
    ["a revoked, not retired, device", STORE.deviceRevoked, "store_has_unretired_device", ["store_has_unretired_device"]],
    [
      "a device that never reported its queue (unknown, never zero)",
      STORE.deviceUnknownQueue,
      "store_has_unretired_device",
      ["store_has_unretired_device", "store_device_queue_unsynced"],
    ],
    ["an open Count Session", STORE.countOnly, "store_has_open_count_session", ["store_has_open_count_session"]],
    [
      "all four at once",
      STORE.allBlockers,
      "store_has_open_shift",
      ["store_has_open_shift", "store_has_unretired_device", "store_device_queue_unsynced", "store_has_open_count_session"],
    ],
  ];

  it.each(CASES)("console path: %s", async (_name, storeId, first, all) => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const { previewFingerprint, reauthToken, preview: p } = await ready(owner, storeId);
    expect(p).toMatchObject({ canDelete: false });
    expect((p as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toEqual(all);

    const liveGrants = h.redis.grantKeys();
    expect(liveGrants.length).toBeGreaterThan(0);
    const res = await consoleDelete(owner, storeId, { previewFingerprint, reauthToken });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(first);
    expect(errorOf(res).details?.blockers.map((b) => b.code)).toEqual(all);
    expect(await deletedAt(storeId)).toBeNull();
    expect(await auditRows(storeId)).toHaveLength(0);
    // The grant is not spent by a refusal: EVERY grant that was live before the request still is.
    expect(h.redis.grantKeys()).toEqual(expect.arrayContaining(liveGrants));
  });

  it.each(CASES)("legacy DELETE: %s", async (_name, storeId, first, all) => {
    if (skip()) return;
    const admin = await h.signIn("admin");
    const res = await h.http().delete(`/api/v1/stores/${storeId}`).set("Cookie", admin).set(SAME_ORIGIN);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(first);
    expect(errorOf(res).details?.blockers.map((b) => b.code)).toEqual(all);
    expect(await deletedAt(storeId)).toBeNull();
    expect(await auditRows(storeId)).toHaveLength(0);
  });

  it("an active till PAST the preview's 500-device cap still blocks (the guards count, they do not read the capped list)", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const p = await preview(owner, STORE.manyDevices).expect(200);
    const body = p.body as { devices: unknown[]; blockers: Array<{ code: string; count: number }>; canDelete: boolean };
    expect(body.devices).toHaveLength(500); // the list is capped, and the active till is not in it
    expect(body.canDelete).toBe(false);
    expect(body.blockers).toEqual([{ code: "store_has_unretired_device", count: 1 }]);
    const admin = await h.signIn("admin");
    const res = await h.http().delete(`/api/v1/stores/${STORE.manyDevices}`).set("Cookie", admin).set(SAME_ORIGIN);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("store_has_unretired_device");
    expect(await deletedAt(STORE.manyDevices)).toBeNull();
  });

  it("the audit records the EXACT device total, not the capped preview length (501 retired devices)", async () => {
    if (skip()) return;
    const admin = await h.signIn("admin");
    await h.http().delete(`/api/v1/stores/${STORE.manyRetired}`).set("Cookie", admin).set(SAME_ORIGIN).expect(204);
    const rows = await auditRows(STORE.manyRetired);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ before: { device_count: 501, open_shift_count: 0 } });
  });

  it("a retired device's frozen queue does not block (the legacy path deletes, and audits channel api)", async () => {
    if (skip()) return;
    const admin = await h.signIn("admin");
    await h.http().delete(`/api/v1/stores/${STORE.retiredFrozen}`).set("Cookie", admin).set(SAME_ORIGIN).expect(204);
    expect(await deletedAt(STORE.retiredFrozen)).not.toBeNull();
    const rows = await auditRows(STORE.retiredFrozen);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      channel: "api",
      actor_role: "tenant_admin",
      reason: null,
      preview_fingerprint: null,
      before: { device_count: 1, open_shift_count: 0 },
    });
  });

  it("legacy DELETE of a clean store is 204 with exactly one audit row, and a second call is 404", async () => {
    if (skip()) return;
    const admin = await h.signIn("admin");
    await h.http().delete(`/api/v1/stores/${STORE.cleanLegacy}`).set("Cookie", admin).set(SAME_ORIGIN).expect(204);
    expect(await auditRows(STORE.cleanLegacy)).toHaveLength(1);
    await h.http().delete(`/api/v1/stores/${STORE.cleanLegacy}`).set("Cookie", admin).set(SAME_ORIGIN).expect(404);
    expect(await auditRows(STORE.cleanLegacy)).toHaveLength(1);
  });

  it("a grant refused for a guard stays valid: fix the cause, and the SAME grant deletes", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const { previewFingerprint, reauthToken } = await ready(owner, STORE.unblock);
    const blocked = await consoleDelete(owner, STORE.unblock, { previewFingerprint, reauthToken });
    expect(blocked.status).toBe(409);
    await h.admin.query(`UPDATE devices SET revoked_at = COALESCE(revoked_at, now()), retired_at = now(), retire_reason = 'closed' WHERE id = $1`, [DEVICE.unblock]);
    const fresh = await preview(owner, STORE.unblock).expect(200);
    await consoleDelete(owner, STORE.unblock, {
      previewFingerprint: (fresh.body as { previewFingerprint: string }).previewFingerprint,
      reauthToken,
    }).expect(200);
    expect(await auditRows(STORE.unblock)).toHaveLength(1);
  });
});

// ===== 4. roles ============================================================

describe("who may use the deletion surface (AC4)", () => {
  const body = { previewFingerprint: "a".repeat(64), reauthToken: "A".repeat(43), reason: "x" };

  async function expectRefused(cookie: string, status: number, code: string | null): Promise<void> {
    const calls = [
      await preview(cookie, STORE.roles),
      await h.http().post(`/api/v1/stores/${STORE.roles}/deletion`).set("Cookie", cookie).set(SAME_ORIGIN).set("Idempotency-Key", idemKey()).send(body),
    ];
    for (const res of calls) {
      expect(res.status).toBe(status);
      if (code) expect(errorOf(res).code).toBe(code);
    }
    expect(await deletedAt(STORE.roles)).toBeNull();
    expect(await auditRows(STORE.roles)).toHaveLength(0);
  }

  it("a tenant_admin is 403 store_deletion_owner_only", async () => {
    if (skip()) return;
    await expectRefused(await h.signIn("admin"), 403, "store_deletion_owner_only");
  });

  it("a store_manager is the non-disclosing 404", async () => {
    if (skip()) return;
    await expectRefused(await h.signIn("manager"), 404, null);
  });

  it("the owner of another tenant is 404: the store is not theirs", async () => {
    if (skip()) return;
    await expectRefused(await h.signIn("globexOwner", GLOBEX_ID), 404, null);
  });

  it("a platform admin in a support session is never admitted: 403 support_session_read_only", async () => {
    if (skip()) return;
    await expectRefused(await h.signInPlatformAdmin(), 403, "support_session_read_only");
  });

  it("no session is 401", async () => {
    if (skip()) return;
    await h.http().get(`/api/v1/stores/${STORE.roles}/deletion-preview`).expect(401);
    await h.http().post(`/api/v1/stores/${STORE.roles}/deletion`).set(SAME_ORIGIN).set("Idempotency-Key", idemKey()).send(body).expect(401);
  });

  it("a cookie write from a foreign Origin is refused (RT-430)", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const res = await h
      .http()
      .post(`/api/v1/stores/${STORE.roles}/deletion`)
      .set("Cookie", owner)
      .set({ Host: "api.test", Origin: "http://evil.example" })
      .set("Idempotency-Key", idemKey())
      .send(body);
    expect(res.status).toBe(403);
    expect(await deletedAt(STORE.roles)).toBeNull();
  });

  it("a malformed store id is 400 and a missing Idempotency-Key is 400", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    await h.http().get(`/api/v1/stores/not-a-uuid/deletion-preview`).set("Cookie", owner).expect(400);
    await h.http().post(`/api/v1/stores/${STORE.roles}/deletion`).set("Cookie", owner).set(SAME_ORIGIN).send(body).expect(400);
  });
});

// ===== 5. the preview ======================================================

describe("previewStoreDeletion (AC5)", () => {
  it("states what the write evaluates, and writes nothing", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const auditBefore = await h.admin.query(`SELECT count(*)::int AS n FROM audit_events`);
    const res = await preview(owner, STORE.allBlockers).expect(200);
    const p = res.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(p["store"]).toEqual({ storeId: STORE.allBlockers, code: "D-allBlockers", name: "D-allBlockers", isActive: true });
    expect(p["openShifts"]).toHaveLength(1);
    expect(p["openShifts"][0]).toMatchObject({ terminalLabel: expect.any(String), forceCloseEligible: true });
    expect(p["devices"]).toEqual([
      expect.objectContaining({ deviceId: DEVICE.allBlockers, trustState: "active", queue: { pending: 2, deadLetter: 0, held: 0 } }),
    ]);
    expect(p["openCountSessions"]).toEqual([expect.objectContaining({ status: "open" })]);
    expect(p["warehouseMappings"]).toEqual([{ warehouseRef: "Stores - RT" }]);
    expect(p["singleStoreMembers"]).toEqual([{ userId: CLERK_ID, roleCode: "store_manager" }]);
    expect(p["canDelete"]).toBe(false);
    expect(p["effects"].willNotChange).toContain("warehouse_mapping_kept");
    expect(p["caveats"]).toEqual(["offline_facts_not_visible", "queue_as_of_last_heartbeat"]);
    expect(p["previewFingerprint"]).toMatch(/^[0-9a-f]{64}$/);
    expect(await deletedAt(STORE.allBlockers)).toBeNull();
    const auditAfter = await h.admin.query(`SELECT count(*)::int AS n FROM audit_events`);
    expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);
  });

  it("an open shift is force-close eligible only when no live cashier admission holds the terminal (the Console verdict, RT-1453)", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const eligibleOf = async (): Promise<boolean> => {
      const res = await preview(owner, STORE.shiftOnly).expect(200);
      return (res.body as { openShifts: Array<{ forceCloseEligible: boolean }> }).openShifts[0]!.forceCloseEligible;
    };
    expect(await eligibleOf()).toBe(true); // opened 2026-10-05: stale, nobody live

    // A live cashier admission on the opening terminal: not eligible.
    const admissionId = randomUUID();
    await h.admin.query(
      `INSERT INTO cashier_admissions (id, tenant_id, store_id, user_id, device_id, mode, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'online', now() + interval '1 hour')`,
      [admissionId, ACME_ID, STORE.shiftOnly, USERS.owner.id, DEVICE.shiftOnly],
    );
    try {
      expect(await eligibleOf()).toBe(false);
    } finally {
      await h.admin.query(`DELETE FROM cashier_admissions WHERE id = $1`, [admissionId]);
    }
    expect(await eligibleOf()).toBe(true);
  });

  it("a device that never reported its queue has queue null (unknown, never zero)", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const res = await preview(owner, STORE.deviceUnknownQueue).expect(200);
    expect((res.body as { devices: Array<{ queue: unknown; lastSeenAt: unknown }> }).devices[0]).toMatchObject({ queue: null, lastSeenAt: null });
  });

  it("the fingerprint is stable until the state changes, and a stale one is 409 preview_stale (grant kept)", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const a = await preview(owner, STORE.stale).expect(200);
    const b = await preview(owner, STORE.stale).expect(200);
    const fp = (a.body as { previewFingerprint: string }).previewFingerprint;
    expect((b.body as { previewFingerprint: string }).previewFingerprint).toBe(fp);

    const reauthToken = await h.grantFor(owner, STORE.stale, USERS.owner.password);
    await h.admin.query(`UPDATE stores SET name = 'Renamed after preview' WHERE id = $1`, [STORE.stale]);
    const stale = await consoleDelete(owner, STORE.stale, { previewFingerprint: fp, reauthToken });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe("preview_stale");
    expect(await deletedAt(STORE.stale)).toBeNull();
    expect(await auditRows(STORE.stale)).toHaveLength(0);

    // Read again, send the new fingerprint with the SAME grant: it was not spent.
    const fresh = await preview(owner, STORE.stale).expect(200);
    await consoleDelete(owner, STORE.stale, {
      previewFingerprint: (fresh.body as { previewFingerprint: string }).previewFingerprint,
      reauthToken,
    }).expect(200);
  });

  it("an unknown, a deleted and another tenant's store are the same 404", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    await preview(owner, randomUUID()).expect(404);
    await preview(owner, STORE.cleanConsole).expect(404); // deleted above
    await preview(owner, STORE.globex).expect(404);
  });
});

// ===== D9: the hourly cap, last (it counts the deletions above) ============

describe("the Console force-action hourly cap (D9)", () => {
  it("the 11th force action of the hour is 429 force_action_rate_limited, without spending the grant", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const { previewFingerprint, reauthToken } = await ready(owner, STORE.cap);
    const counted = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id = $1 AND metadata->>'channel' = 'console' AND action IN ('shift.force_closed', 'store.deleted')`,
      [ACME_ID],
    );
    for (let i = counted.rows[0]!.n; i < 10; i += 1) {
      await h.admin.query(
        // 59 minutes ago: still inside the rolling hour, and the oldest leaves it in about a minute.
        `INSERT INTO audit_events (id, actor_user_id, tenant_id, action, metadata, occurred_at)
         VALUES (gen_random_uuid(), $1, $2, 'shift.force_closed', '{"channel":"console"}'::jsonb, now() - interval '59 minutes')`,
        [USERS.owner.id, ACME_ID],
      );
    }
    const liveGrants = h.redis.grantKeys();
    const res = await consoleDelete(owner, STORE.cap, { previewFingerprint, reauthToken });
    expect(res.status).toBe(429);
    expect(errorOf(res).code).toBe("force_action_rate_limited");
    // Seconds until the OLDEST counted action leaves the hour: 60 minutes after the oldest filler (59 minutes ago).
    const retryAfter = Number(res.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(120);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toBe((res.body as { error: { request_id: string } }).error.request_id);
    expect(await deletedAt(STORE.cap)).toBeNull();
    expect(await auditRows(STORE.cap)).toHaveLength(0);
    // A refusal never spends the grant: it is still live for the retry after the hour.
    expect(h.redis.grantKeys()).toEqual(expect.arrayContaining(liveGrants));
  });

  it("a same-key retry of a deletion that already succeeded replays the 200 even with the cap spent", async () => {
    if (skip() || replayCall === null) return;
    const res = await consoleDelete(replayCall.cookie, STORE.replay, replayCall.body, replayCall.key).expect(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });
});
