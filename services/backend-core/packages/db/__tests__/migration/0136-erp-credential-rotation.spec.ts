/**
 * RT-1362 S2: the six storage migrations of overlap credential rotation (owner go-ahead for the gated migrations:
 * RT-1362 comments 19102 and 19107):
 *   0136_erp_credential_rotation                       request routing/trigger columns, registration host binding
 *   0137_erp_provisioning_request_open_rotate_idx      CONCURRENTLY: one OPEN credential.rotate per registration
 *   0138_erp_provisioning_request_rotation_key_idx     CONCURRENTLY: (id, tenant, registration, kind), the FK target
 *   0139_auth_tokens_pending_rotation                  the pending marker (request id + kind), FK and shape CHECK
 *   0140/0141_auth_tokens_*_connector_credential_idx   CONCURRENTLY: one CURRENT / one PENDING per registration
 * Real PostgreSQL (Testcontainers):
 *   - 0136 and 0139 run as a NOSUPERUSER, NOBYPASSRLS owner (like production) with `app.current_tenant` pre-set to ''
 *     (0139's FK validation reads auth_tokens under FORCE RLS); a second up of each is a no-op (re-runnable);
 *   - NAMED: a pending credential names only a `credential.rotate` request of its OWN tenant AND registration
 *     (23503: another tenant, another registration, or a `tenant.provision` request); only a connector credential
 *     linked to a registration may be pending, and the kind discriminator is set with the id and is only
 *     'credential.rotate' (23514);
 *   - NAMED: a `credential.rotate` row carries its routed host label, its trigger and its registration, and no other
 *     kind carries the first two (23514); the adopted host binding is all-or-none and well-formed (23514);
 *   - NAMED: at most one OPEN `credential.rotate` per registration (23505); a terminal one does not count;
 *   - NAMED: the 0021 one-unrevoked-credential index stays, so a pending credential next to a current one is refused
 *     today (23505 on it); with it dropped (in a rolled-back transaction, as a later PR will), one current plus one
 *     pending coexist, a second of either is refused (23505 on 0140/0141), and the promote order holds;
 *   - every down: 0139 down refuses (P0001) as the owner while a pending credential exists; 0136 down refuses (P0001)
 *     while a `credential.rotate` request exists and while any registration carries a host binding (seen across
 *     tenants under FORCE RLS); otherwise every down drops its objects and every up applies again.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { ERP_CREDENTIAL_ROTATION_TRIGGERS } from "../../src/schema/erp-provisioning";
import { expectSingleConcurrentStatement, indexState, migrationPath } from "../_helpers/concurrent-index-migration";
import { applyMigrationsBefore, asMigrationOwner, errorCode, type MigrationOwner } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const M0136 = "0136_erp_credential_rotation";
const M0137 = "0137_erp_provisioning_request_open_rotate_idx";
const M0138 = "0138_erp_provisioning_request_rotation_key_idx";
const M0139 = "0139_auth_tokens_pending_rotation";
const M0140 = "0140_auth_tokens_current_connector_credential_idx";
const M0141 = "0141_auth_tokens_pending_connector_credential_idx";
const CONCURRENT = [M0137, M0138, M0140, M0141];

const IDX_OLD = "uq_auth_tokens_active_connector_credential";
const IDX_CURRENT = "uq_auth_tokens_current_connector_credential";
const IDX_PENDING = "uq_auth_tokens_pending_connector_credential";
const IDX_OPEN_ROTATE = "uq_erp_provisioning_request_open_credential_rotate";
const IDX_ROTATION_KEY = "uq_erp_provisioning_request_rotation_key";
const FK = { code: "23503", constraint: "auth_tokens_pending_rotation_request_fk" };
const TOKEN_SHAPE = { code: "23514", constraint: "auth_tokens_pending_rotation_shape" };
const REQUEST_SHAPE = { code: "23514", constraint: "erp_provisioning_request_rotation_shape" };
const BINDING = "connector_registration_provisioner_host_binding_valid";
const REQ = "erp_provisioning_request";

const read = (id: string, direction: "up" | "down"): string => readFileSync(migrationPath(id, direction), "utf8");

const id = (n: string): string => `13600000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const USER = id("0c001");
const REG_A = id("0a011");
const REG_A2 = id("0a012");
const REG_B = id("0b011");

const OWNER: MigrationOwner = {
  role: "mig_owner_0136",
  tables: ["auth_tokens", REQ, "connector_registration", "tenants"],
  functions: ["erp_provisioning_request_guard()", "erp_provisioning_transition_allowed(text, text)"],
};

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";
function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

type Queryable = Pick<PoolClient, "query">;

/** A request row, written as the superuser (fixtures bypass RLS; the guard trigger is UPDATE only). */
async function insertRequest(
  tenant: string,
  registration: string | null,
  over: { kind?: string; host?: string | null; trigger?: string | null; status?: string } = {},
): Promise<string> {
  const kind = over.kind ?? "credential.rotate";
  const status = over.status ?? "requested";
  const terminal = ["succeeded", "failed_permanent", "compensated", "cancelled"].includes(status);
  const r = await guard().admin.query<{ id: string }>(
    `INSERT INTO ${REQ} (tenant_id, kind, status, site_name, template_id, template_version, connector_registration_id,
                         routed_host_label, rotation_trigger, terminal_at)
     VALUES ($1, $2, $3, 's-' || substr(gen_random_uuid()::text, 1, 8), 'egypt-retail', 1, $4, $5, $6,
             CASE WHEN $7 THEN now() END)
     RETURNING id`,
    [tenant, kind, status, registration, over.host === undefined ? "lab-03" : over.host, over.trigger === undefined ? "forced" : over.trigger, terminal],
  );
  return r.rows[0]!.id;
}

/** A connector credential of `registration`; `pending` names the rotation request that issued it. */
async function insertToken(
  tenant: string,
  registration: string | null,
  over: { pending?: string | null; kind?: string | null; scope?: string; revoked?: boolean } = {},
  q: Queryable = guard().admin,
): Promise<string> {
  const pending = over.pending ?? null;
  const kind = over.kind !== undefined ? over.kind : pending === null ? null : "credential.rotate";
  const r = await q.query<{ id: string }>(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id,
                              pending_rotation_request_id, pending_rotation_kind, revoked_at)
     VALUES (gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), $1, $2, $3, now() + interval '90 days', $4, $5, $6,
             CASE WHEN $7 THEN now() END)
     RETURNING id`,
    [tenant, USER, over.scope ?? "connector", registration, pending, kind, over.revoked ?? false],
  );
  return r.rows[0]!.id;
}

/** The Postgres error `fn` raised, as `{ code, constraint }`, or null. */
async function pgError(fn: () => Promise<unknown>): Promise<{ code: string | undefined; constraint: string | undefined } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return { code: e.code, constraint: e.constraint };
  }
}

/** Run `fn` inside a SAVEPOINT of `c`, rolled back afterwards: the error it raised, or null. */
async function inSavepoint(c: PoolClient, fn: () => Promise<unknown>): Promise<{ code: string | undefined; constraint: string | undefined } | null> {
  await c.query("SAVEPOINT sp");
  const err = await pgError(fn);
  await c.query(err === null ? "RELEASE SAVEPOINT sp" : "ROLLBACK TO SAVEPOINT sp");
  return err;
}

/**
 * Run a migration file as the NOSUPERUSER owner with `app.current_tenant` pre-set to '' at SESSION level (the
 * empty-GUC cast case: the 0000 auth_tokens and tenants policies cast it to uuid with no guard). The error code or null.
 */
async function runAsOwner(path: string): Promise<string | null> {
  const e = guard();
  return asMigrationOwner(e, OWNER, async () => {
    const c = await e.admin.connect();
    try {
      await c.query("SELECT set_config('app.current_tenant', '', false)");
      await c.query(`SET ROLE ${OWNER.role}`);
      return await errorCode(() => c.query(readFileSync(path, "utf8")));
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query("RESET app.current_tenant").catch(() => undefined);
      c.release();
    }
  });
}

const columnCount = async (columns: readonly string[]): Promise<number> =>
  (
    await guard().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND column_name = ANY($1::text[])`,
      [columns],
    )
  ).rows[0]!.n;

const NEW_COLUMNS = [
  "routed_host_label",
  "rotation_trigger",
  "provisioner_host_label",
  "provisioner_host_binding",
  "provisioner_host_binding_revision",
  "pending_rotation_request_id",
  "pending_rotation_kind",
];

async function cleanRotationRows(): Promise<void> {
  const a = guard().admin;
  await a.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [USER]);
  await a.query(`DELETE FROM ${REQ} WHERE tenant_id = ANY($1::uuid[])`, [[TENANT_A, TENANT_B]]);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, `${M0136}.sql`);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rot-a', 'Rot A', 'USD'), ($2, 'rot-b', 'Rot B', 'USD')`,
      [TENANT_A, TENANT_B],
    );
    await env.admin.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'rot-admin@fixture.invalid', NULL)`, [USER]);
    await env.admin.query(
      `INSERT INTO connector_registration (id, tenant_id, display_name, erpnext_site_ref, environment, created_by, managed_by)
       VALUES ($1, $4, 'a', 'site-a', 'pilot', $6, 'provisioner'),
              ($2, $4, 'a2', 'site-a2', 'pilot', $6, 'provisioner'),
              ($3, $5, 'b', 'site-b', 'pilot', $6, 'provisioner')`,
      [REG_A, REG_A2, REG_B, TENANT_A, TENANT_B, USER],
    );
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0136-erp-credential-rotation.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0137, 0138, 0140, 0141: file shape", () => {
  it("each up and down is one CONCURRENTLY statement outside a transaction", () => {
    for (const m of CONCURRENT) {
      expectSingleConcurrentStatement(migrationPath(m, "up"));
      expectSingleConcurrentStatement(migrationPath(m, "down"));
    }
  });
});

describe("up: every migration applies, 0136 and 0139 as the NOSUPERUSER owner with the tenant GUC pre-set to ''", () => {
  it("0136 then 0137 and 0138", async () => {
    if (skip()) return;
    const a = guard().admin;
    expect(await runAsOwner(migrationPath(M0136, "up"))).toBeNull();
    await a.query(read(M0137, "up"));
    await a.query(read(M0138, "up"));
    expect((await indexState(a, IDX_OPEN_ROTATE))?.valid).toBe(true);
    expect((await indexState(a, IDX_ROTATION_KEY))?.valid).toBe(true);
  });

  it("0139 validates its FK over real auth_tokens rows under FORCE RLS, then 0140 and 0141; the 0021 index stays", async () => {
    if (skip()) return;
    const a = guard().admin;
    // A current connector credential, written without the new columns (they do not exist yet).
    await a.query(
      `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id)
       VALUES (gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), $1, $2, 'connector', now() + interval '90 days', $3)`,
      [TENANT_A, USER, REG_A],
    );
    expect(await runAsOwner(migrationPath(M0139, "up"))).toBeNull();
    await a.query(read(M0140, "up"));
    await a.query(read(M0141, "up"));
    expect((await indexState(a, IDX_CURRENT))?.def).toMatch(/WHERE .*pending_rotation_request_id IS NULL/);
    expect((await indexState(a, IDX_PENDING))?.def).toMatch(/WHERE .*pending_rotation_request_id IS NOT NULL/);
    expect((await indexState(a, IDX_CURRENT))?.valid).toBe(true);
    expect((await indexState(a, IDX_PENDING))?.valid).toBe(true);
    expect((await indexState(a, IDX_OLD))?.valid).toBe(true);
    const unvalidated = await a.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname IN ('auth_tokens_pending_rotation_request_fk', 'auth_tokens_pending_rotation_shape',
                          'erp_provisioning_request_rotation_shape', '${BINDING}')
          AND NOT convalidated`,
    );
    expect(unvalidated.rows[0]!.n).toBe(0);
    expect(await columnCount(NEW_COLUMNS)).toBe(NEW_COLUMNS.length);
    await cleanRotationRows();
  });
});

describe("0139: the pending marker on auth_tokens", () => {
  afterEach(async () => {
    if (!skip()) await cleanRotationRows();
  });

  it("NAMED: a pending credential names only a credential.rotate request of its own tenant and registration (23503)", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    const rb = await insertRequest(TENANT_B, REG_B);
    const provision = await insertRequest(TENANT_A, REG_A2, { kind: "tenant.provision", host: null, trigger: null });
    // Another tenant's rotation.
    expect(await pgError(() => insertToken(TENANT_A, REG_A2, { pending: rb }))).toEqual(FK);
    // Same tenant, another registration's rotation.
    expect(await pgError(() => insertToken(TENANT_A, REG_A2, { pending: ra }))).toEqual(FK);
    // Same tenant and registration, but a tenant.provision request.
    expect(await pgError(() => insertToken(TENANT_A, REG_A2, { pending: provision }))).toEqual(FK);
    await insertToken(TENANT_A, REG_A, { pending: ra });
  });

  it("NAMED: the kind is set with the id and is only credential.rotate; only a linked connector credential may be pending (23514)", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    const provision = await insertRequest(TENANT_A, REG_A2, { kind: "tenant.provision", host: null, trigger: null });
    expect(await pgError(() => insertToken(TENANT_A, REG_A2, { pending: provision, kind: "tenant.provision" }))).toEqual(TOKEN_SHAPE);
    expect(await pgError(() => insertToken(TENANT_A, REG_A, { pending: ra, kind: null }))).toEqual(TOKEN_SHAPE);
    expect(await pgError(() => insertToken(TENANT_A, REG_A, { pending: null, kind: "credential.rotate" }))).toEqual(TOKEN_SHAPE);
    expect(await pgError(() => insertToken(TENANT_A, null, { pending: ra, scope: "dashboard_api" }))).toEqual(TOKEN_SHAPE);
    expect(await pgError(() => insertToken(TENANT_A, null, { pending: ra }))).toEqual(TOKEN_SHAPE);
  });

  it("a request with a pending credential cannot be deleted (ON DELETE RESTRICT, 23503)", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    await insertToken(TENANT_A, REG_A, { pending: ra });
    expect(await pgError(() => guard().admin.query(`DELETE FROM ${REQ} WHERE id = $1`, [ra]))).toEqual(FK);
  });
});

describe("0136: the shape of a credential.rotate request", () => {
  afterEach(async () => {
    if (!skip()) await cleanRotationRows();
  });

  it("accepts both triggers on credential.rotate", async () => {
    if (skip()) return;
    for (const trigger of ERP_CREDENTIAL_ROTATION_TRIGGERS) {
      await insertRequest(TENANT_A, REG_A, { trigger, status: "cancelled" });
    }
  });

  it("NAMED: credential.rotate needs a routed host, a trigger and a registration; no other kind carries them (23514)", async () => {
    if (skip()) return;
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { host: null }))).toEqual(REQUEST_SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { trigger: null }))).toEqual(REQUEST_SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, null))).toEqual(REQUEST_SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { trigger: "manual" }))).toEqual(REQUEST_SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { host: "Lab_03" }))).toEqual(REQUEST_SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { host: "a".repeat(65) }))).toEqual(REQUEST_SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { kind: "tenant.provision" }))).toEqual(REQUEST_SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { kind: "tenant.provision", host: null }))).toEqual(REQUEST_SHAPE);
    await insertRequest(TENANT_A, REG_A, { kind: "tenant.provision", host: null, trigger: null });
  });

  it("the routed host of an open request can be re-routed (a correction); the guard trigger allows it", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    await guard().admin.query(`UPDATE ${REQ} SET routed_host_label = 'lab-04' WHERE id = $1`, [ra]);
    const r = await guard().admin.query<{ routed_host_label: string }>(`SELECT routed_host_label FROM ${REQ} WHERE id = $1`, [ra]);
    expect(r.rows[0]!.routed_host_label).toBe("lab-04");
  });

  it("NAMED: at most one OPEN credential.rotate per registration (23505); terminal ones and other registrations do not count", async () => {
    if (skip()) return;
    const OPEN = { code: "23505", constraint: IDX_OPEN_ROTATE };
    await insertRequest(TENANT_A, REG_A, { status: "failed_permanent" });
    await insertRequest(TENANT_A, REG_A, { status: "succeeded" });
    await insertRequest(TENANT_A, REG_A);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { trigger: "scheduled" }))).toEqual(OPEN);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { status: "failed_retryable" }))).toEqual(OPEN);
    await insertRequest(TENANT_A, REG_A2);
    await insertRequest(TENANT_A, REG_A, { kind: "store.provision", host: null, trigger: null });
  });
});

describe("0136: the adopted registration's provisioner host binding", () => {
  /** null, the code when the binding CHECK refused it, or `code:constraint` when anything else did. */
  const set = async (label: string | null, binding: string | null, revision: number | null, reg = REG_A): Promise<string | null> => {
    const err = await pgError(() =>
      guard().admin.query(
        `UPDATE connector_registration
            SET provisioner_host_label = $2, provisioner_host_binding = $3, provisioner_host_binding_revision = $4
          WHERE id = $1`,
        [reg, label, binding, revision],
      ),
    );
    if (err === null) return null;
    return err.constraint === BINDING ? (err.code ?? "unknown") : `${err.code}:${err.constraint}`;
  };

  afterEach(async () => {
    if (!skip()) await set(null, null, null);
  });

  it("accepts none, a provisional and a confirmed binding", async () => {
    if (skip()) return;
    expect(await set(null, null, null)).toBeNull();
    expect(await set("lab-03", "provisional", 1)).toBeNull();
    expect(await set("lab-04", "confirmed", 2)).toBeNull();
  });

  it("NAMED: refuses a partial or malformed binding (23514)", async () => {
    if (skip()) return;
    expect(await set("lab-03", null, null)).toBe("23514");
    expect(await set("lab-03", "provisional", null)).toBe("23514");
    expect(await set(null, "confirmed", 1)).toBe("23514");
    expect(await set("lab-03", "pending", 1)).toBe("23514");
    expect(await set("lab-03", "provisional", 0)).toBe("23514");
    expect(await set("LAB 03", "provisional", 1)).toBe("23514");
  });
});

describe("0140, 0141 beside the 0021 index", () => {
  afterEach(async () => {
    if (!skip()) await cleanRotationRows();
  });

  it("NAMED: while the 0021 index exists a pending credential next to a current one is refused (23505): no overlap writes yet", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    await insertToken(TENANT_A, REG_A);
    expect(await pgError(() => insertToken(TENANT_A, REG_A, { pending: ra }))).toMatchObject({ code: "23505" });
    const second = await pgError(() => insertToken(TENANT_A, REG_A));
    expect(second?.code).toBe("23505");
    expect([IDX_OLD, IDX_CURRENT]).toContain(second?.constraint);
  });

  it("NAMED: with the 0021 index dropped (rolled back), one current and one pending coexist; a second of either is refused; the promote order holds", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    const c = await guard().admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(`DROP INDEX ${IDX_OLD}`);
      await insertToken(TENANT_A, REG_A, { revoked: true }, c);
      const current = await insertToken(TENANT_A, REG_A, {}, c);
      const pending = await insertToken(TENANT_A, REG_A, { pending: ra }, c);
      expect(await inSavepoint(c, () => insertToken(TENANT_A, REG_A, {}, c))).toEqual({ code: "23505", constraint: IDX_CURRENT });
      expect(await inSavepoint(c, () => insertToken(TENANT_A, REG_A, { pending: ra }, c))).toEqual({ code: "23505", constraint: IDX_PENDING });
      // Clearing the marker first would make two CURRENT credentials: refused, never deferred.
      const clear = (): Promise<unknown> =>
        c.query(`UPDATE auth_tokens SET pending_rotation_request_id = NULL, pending_rotation_kind = NULL WHERE id = $1`, [pending]);
      expect(await inSavepoint(c, clear)).toEqual({ code: "23505", constraint: IDX_CURRENT });
      await c.query(`UPDATE auth_tokens SET revoked_at = now() WHERE id = $1`, [current]);
      expect(await inSavepoint(c, clear)).toBeNull();
      const live = await c.query<{ id: string }>(
        `SELECT id FROM auth_tokens WHERE connector_registration_id = $1 AND revoked_at IS NULL`,
        [REG_A],
      );
      expect(live.rows.map((r) => r.id)).toEqual([pending]);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect((await indexState(guard().admin, IDX_OLD))?.valid).toBe(true);
  });
});

describe("down and up again", () => {
  it("0141 and 0140 down drop their indexes; 0139 down refuses (P0001) as the owner while a pending credential exists", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(read(M0141, "down"));
    await a.query(read(M0140, "down"));
    expect(await indexState(a, IDX_PENDING)).toBeNull();
    expect(await indexState(a, IDX_CURRENT)).toBeNull();
    const ra = await insertRequest(TENANT_A, REG_A);
    await insertToken(TENANT_A, REG_A, { pending: ra });
    expect(await runAsOwner(migrationPath(M0139, "down"))).toBe("P0001");
    expect(await columnCount(["pending_rotation_request_id", "pending_rotation_kind"])).toBe(2);
  });

  it("0139 down drops the marker once no credential is pending; 0138 and 0137 down drop their indexes", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [USER]);
    expect(await runAsOwner(migrationPath(M0139, "down"))).toBeNull();
    expect(await columnCount(["pending_rotation_request_id", "pending_rotation_kind"])).toBe(0);
    await a.query(read(M0138, "down"));
    await a.query(read(M0137, "down"));
    expect(await indexState(a, IDX_ROTATION_KEY)).toBeNull();
    expect(await indexState(a, IDX_OPEN_ROTATE)).toBeNull();
  });

  it("0136 down refuses (P0001) as the owner under FORCE RLS while a credential.rotate request exists", async () => {
    if (skip()) return;
    expect(await runAsOwner(migrationPath(M0136, "down"))).toBe("P0001");
    expect(await columnCount(["routed_host_label"])).toBe(1);
  });

  it("0136 down refuses (P0001) while a registration of any tenant carries a host binding", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(`DELETE FROM ${REQ} WHERE tenant_id = ANY($1::uuid[])`, [[TENANT_A, TENANT_B]]);
    await a.query(
      `UPDATE connector_registration SET provisioner_host_label = 'lab-03', provisioner_host_binding = 'provisional',
              provisioner_host_binding_revision = 1 WHERE id = $1`,
      [REG_B],
    );
    expect(await runAsOwner(migrationPath(M0136, "down"))).toBe("P0001");
    expect(await columnCount(["provisioner_host_label"])).toBe(1);
    await a.query(
      `UPDATE connector_registration SET provisioner_host_label = NULL, provisioner_host_binding = NULL,
              provisioner_host_binding_revision = NULL WHERE id = $1`,
      [REG_B],
    );
  });

  it("0136 down drops everything once nothing remains, and every up applies again (0136 and 0139 twice)", async () => {
    if (skip()) return;
    const a = guard().admin;
    expect(await runAsOwner(migrationPath(M0136, "down"))).toBeNull();
    expect(await columnCount(NEW_COLUMNS)).toBe(0);
    await a.query(read(M0136, "up"));
    await a.query(read(M0136, "up"));
    await a.query(read(M0137, "up"));
    await a.query(read(M0138, "up"));
    await a.query(read(M0139, "up"));
    await a.query(read(M0139, "up"));
    await a.query(read(M0140, "up"));
    await a.query(read(M0141, "up"));
    expect(await columnCount(NEW_COLUMNS)).toBe(NEW_COLUMNS.length);
    for (const idx of [IDX_OPEN_ROTATE, IDX_ROTATION_KEY, IDX_CURRENT, IDX_PENDING, IDX_OLD]) {
      expect((await indexState(a, idx))?.valid).toBe(true);
    }
  });
});
