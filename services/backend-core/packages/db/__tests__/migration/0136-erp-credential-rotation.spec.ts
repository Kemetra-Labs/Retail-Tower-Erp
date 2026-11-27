/**
 * RT-1362 S2: `0136_erp_credential_rotation` and the three CONCURRENTLY index migrations
 * `0137_auth_tokens_current_connector_credential_idx`, `0138_auth_tokens_pending_connector_credential_idx` and
 * `0139_drop_auth_tokens_active_connector_credential_idx` (owner go-ahead for the gated migration: RT-1362 comments
 * 19102 and 19107). Real PostgreSQL (Testcontainers):
 *   - 0136 runs as a NOSUPERUSER, NOBYPASSRLS owner (like production) with `app.current_tenant` pre-set to '' (its FK
 *     validation reads auth_tokens under FORCE RLS), and a second run of its up is a no-op (re-runnable);
 *   - NAMED: a pending credential names only a rotation of its OWN tenant AND registration (23503), and only a
 *     connector credential linked to a registration may be pending (23514);
 *   - NAMED: a `credential.rotate` row carries its routed host label, its trigger and its registration, and no other
 *     kind carries the first two (23514); the adopted host binding is all-or-none and well-formed (23514);
 *   - NAMED: at most one OPEN `credential.rotate` per registration (23505); a terminal one does not count;
 *   - 0137-0139 are each one CONCURRENTLY statement; after them a registration holds at most one CURRENT and at most
 *     one PENDING unrevoked connector credential (23505 on a second of either), and a revoked one counts for neither;
 *   - 0139 down fails closed (23505) while a pending credential sits next to a current one, and passes once it is
 *     revoked; 0136 down refuses (P0001) as the NOSUPERUSER owner under FORCE RLS while a `credential.rotate` request
 *     exists, and drops everything otherwise; every up applies again.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ERP_CREDENTIAL_ROTATION_TRIGGERS } from "../../src/schema/erp-provisioning";
import { expectSingleConcurrentStatement, indexState, migrationPath } from "../_helpers/concurrent-index-migration";
import { applyMigrationsBefore, asMigrationOwner, errorCode, type MigrationOwner } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const M0136 = "0136_erp_credential_rotation";
const M0137 = "0137_auth_tokens_current_connector_credential_idx";
const M0138 = "0138_auth_tokens_pending_connector_credential_idx";
const M0139 = "0139_drop_auth_tokens_active_connector_credential_idx";
const IDX_OLD = "uq_auth_tokens_active_connector_credential";
const IDX_CURRENT = "uq_auth_tokens_current_connector_credential";
const IDX_PENDING = "uq_auth_tokens_pending_connector_credential";
const IDX_OPEN_ROTATE = "uq_erp_provisioning_request_open_credential_rotate";
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
  tables: ["auth_tokens", REQ, "connector_registration"],
  functions: ["erp_provisioning_request_guard()", "erp_provisioning_transition_allowed(text, text)"],
};

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";
function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** A `credential.rotate` (or other kind) request, written as the superuser (fixtures bypass RLS). */
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
  over: { pending?: string | null; scope?: string; revoked?: boolean } = {},
): Promise<string> {
  const r = await guard().admin.query<{ id: string }>(
    `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id,
                              pending_rotation_request_id, revoked_at)
     VALUES (gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), $1, $2, $3, now() + interval '90 days', $4, $5,
             CASE WHEN $6 THEN now() END)
     RETURNING id`,
    [tenant, USER, over.scope ?? "connector", registration, over.pending ?? null, over.revoked ?? false],
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

/**
 * Run a migration file as the NOSUPERUSER owner with `app.current_tenant` pre-set to '' at SESSION level (the
 * empty-GUC cast case: the 0000 auth_tokens policy casts it to uuid with no guard). Returns the error code or null.
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

describe("0137-0139: file shape", () => {
  it("each up and down is one CONCURRENTLY statement outside a transaction", () => {
    for (const m of [M0137, M0138, M0139]) {
      expectSingleConcurrentStatement(migrationPath(m, "up"));
      expectSingleConcurrentStatement(migrationPath(m, "down"));
    }
  });
});

describe("0136: up as the NOSUPERUSER owner", () => {
  it("applies with no superuser and no BYPASSRLS, with the tenant GUC pre-set to '' (FK validation under FORCE RLS)", async () => {
    if (skip()) return;
    const e = guard();
    // A current connector credential exists, so the FK validation reads real auth_tokens rows (written without the
    // new column, which does not exist yet).
    await e.admin.query(
      `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id)
       VALUES (gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), $1, $2, 'connector', now() + interval '90 days', $3)`,
      [TENANT_A, USER, REG_A],
    );
    expect(await runAsOwner(migrationPath(M0136, "up"))).toBeNull();
    await cleanRotationRows();
    const cols = await e.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE (table_name, column_name) IN (('auth_tokens', 'pending_rotation_request_id'),
              ('${REQ}', 'routed_host_label'), ('${REQ}', 'rotation_trigger'),
              ('connector_registration', 'provisioner_host_label'), ('connector_registration', 'provisioner_host_binding'),
              ('connector_registration', 'provisioner_host_binding_revision'))`,
    );
    expect(cols.rows[0]!.n).toBe(6);
    const unvalidated = await e.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname IN ('auth_tokens_pending_rotation_request_fk', 'auth_tokens_pending_rotation_shape',
                          'erp_provisioning_request_rotation_shape', 'connector_registration_provisioner_host_binding_valid')
          AND NOT convalidated`,
    );
    expect(unvalidated.rows[0]!.n).toBe(0);
  });
});

describe("0136: the pending marker on auth_tokens", () => {
  afterEach(async () => {
    if (!skip()) await cleanRotationRows();
  });

  it("NAMED: a pending credential names only a rotation of its own tenant and registration (23503)", async () => {
    if (skip()) return;
    const FK = { code: "23503", constraint: "auth_tokens_pending_rotation_request_fk" };
    const ra = await insertRequest(TENANT_A, REG_A);
    const rb = await insertRequest(TENANT_B, REG_B);
    await insertToken(TENANT_A, REG_A, { pending: ra });
    expect(await pgError(() => insertToken(TENANT_A, REG_A2, { pending: rb }))).toEqual(FK);
    // Same tenant, another registration's rotation.
    expect(await pgError(() => insertToken(TENANT_A, REG_A2, { pending: ra }))).toEqual(FK);
  });

  it("NAMED: only a connector credential linked to a registration may be pending (23514)", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    const SHAPE = { code: "23514", constraint: "auth_tokens_pending_rotation_shape" };
    expect(await pgError(() => insertToken(TENANT_A, null, { pending: ra, scope: "dashboard_api" }))).toEqual(SHAPE);
    expect(await pgError(() => insertToken(TENANT_A, null, { pending: ra }))).toEqual(SHAPE);
  });

  it("a request with a pending credential cannot be deleted (ON DELETE RESTRICT, 23503)", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    await insertToken(TENANT_A, REG_A, { pending: ra });
    expect(await pgError(() => guard().admin.query(`DELETE FROM ${REQ} WHERE id = $1`, [ra]))).toEqual({
      code: "23503",
      constraint: "auth_tokens_pending_rotation_request_fk",
    });
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
    const SHAPE = { code: "23514", constraint: "erp_provisioning_request_rotation_shape" };
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { host: null }))).toEqual(SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { trigger: null }))).toEqual(SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, null))).toEqual(SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { trigger: "manual" }))).toEqual(SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { host: "Lab_03" }))).toEqual(SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { host: "a".repeat(65) }))).toEqual(SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { kind: "tenant.provision" }))).toEqual(SHAPE);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { kind: "tenant.provision", host: null }))).toEqual(SHAPE);
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
    await insertRequest(TENANT_A, REG_A, { status: "failed_permanent" });
    await insertRequest(TENANT_A, REG_A, { status: "succeeded" });
    await insertRequest(TENANT_A, REG_A);
    const OPEN = { code: "23505", constraint: IDX_OPEN_ROTATE };
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { trigger: "scheduled" }))).toEqual(OPEN);
    expect(await pgError(() => insertRequest(TENANT_A, REG_A, { status: "failed_retryable" }))).toEqual(OPEN);
    await insertRequest(TENANT_A, REG_A2);
    await insertRequest(TENANT_A, REG_A, { kind: "store.provision", host: null, trigger: null });
    const state = await indexState(guard().admin, IDX_OPEN_ROTATE);
    expect(state?.valid).toBe(true);
    expect(state?.def).toMatch(/UNIQUE/);
  });
});

describe("0136: the adopted registration's provisioner host binding", () => {
  const BINDING = "connector_registration_provisioner_host_binding_valid";
  /** null, the code when the binding CHECK refused it, or `code:constraint` when anything else did. */
  const set = async (label: string | null, binding: string | null, revision: number | null): Promise<string | null> => {
    const err = await pgError(() =>
      guard().admin.query(
        `UPDATE connector_registration
            SET provisioner_host_label = $2, provisioner_host_binding = $3, provisioner_host_binding_revision = $4
          WHERE id = $1`,
        [REG_A, label, binding, revision],
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

describe("0137-0139: one current plus one pending credential per registration", () => {
  it("builds both new indexes valid, then drops the 0021 one", async () => {
    if (skip()) return;
    const a = guard().admin;
    expect((await indexState(a, IDX_OLD))?.valid).toBe(true);
    await a.query(read(M0137, "up"));
    await a.query(read(M0138, "up"));
    expect((await indexState(a, IDX_CURRENT))?.def).toMatch(/WHERE .*pending_rotation_request_id IS NULL/);
    expect((await indexState(a, IDX_PENDING))?.def).toMatch(/WHERE .*pending_rotation_request_id IS NOT NULL/);
    expect((await indexState(a, IDX_CURRENT))?.valid).toBe(true);
    expect((await indexState(a, IDX_PENDING))?.valid).toBe(true);
    await a.query(read(M0139, "up"));
    expect(await indexState(a, IDX_OLD)).toBeNull();
  });

  it("NAMED: a second current credential is refused (23505); a revoked one counts for nothing", async () => {
    if (skip()) return;
    await insertToken(TENANT_A, REG_A, { revoked: true });
    await insertToken(TENANT_A, REG_A);
    const err = await guard()
      .admin.query(
        `INSERT INTO auth_tokens (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id)
         VALUES (gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), $1, $2, 'connector', now() + interval '1 day', $3)`,
        [TENANT_A, USER, REG_A],
      )
      .then(
        () => null,
        (e: { code?: string; constraint?: string }) => e,
      );
    expect(err).toMatchObject({ code: "23505", constraint: IDX_CURRENT });
    await insertToken(TENANT_A, REG_A2);
    await cleanRotationRows();
  });

  it("NAMED: one current and one pending coexist; a second pending is refused (23505); a revoked pending frees the slot", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    await insertToken(TENANT_A, REG_A);
    const first = await insertToken(TENANT_A, REG_A, { pending: ra });
    expect(await pgError(() => insertToken(TENANT_A, REG_A, { pending: ra }))).toEqual({ code: "23505", constraint: IDX_PENDING });
    await guard().admin.query(`UPDATE auth_tokens SET revoked_at = now() WHERE id = $1`, [first]);
    await insertToken(TENANT_A, REG_A, { pending: ra });
    await cleanRotationRows();
  });

  it("the promote order holds: revoke the old current first, then clear the marker, in one transaction", async () => {
    if (skip()) return;
    const ra = await insertRequest(TENANT_A, REG_A);
    const current = await insertToken(TENANT_A, REG_A);
    const pending = await insertToken(TENANT_A, REG_A, { pending: ra });
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      // Clearing the marker first would make two CURRENT credentials: refused, never deferred.
      await client.query("SAVEPOINT wrong_order");
      expect(
        await pgError(() => client.query(`UPDATE auth_tokens SET pending_rotation_request_id = NULL WHERE id = $1`, [pending])),
      ).toEqual({ code: "23505", constraint: IDX_CURRENT });
      await client.query("ROLLBACK TO SAVEPOINT wrong_order");
      await client.query(`UPDATE auth_tokens SET revoked_at = now() WHERE id = $1`, [current]);
      await client.query(`UPDATE auth_tokens SET pending_rotation_request_id = NULL WHERE id = $1`, [pending]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const live = await guard().admin.query<{ id: string }>(
      `SELECT id FROM auth_tokens WHERE connector_registration_id = $1 AND revoked_at IS NULL`,
      [REG_A],
    );
    expect(live.rows.map((r) => r.id)).toEqual([pending]);
    await cleanRotationRows();
  });
});

describe("0139-0136: down and up again", () => {
  it("0139 down fails closed (23505) while a pending credential sits next to a current one, then passes once it is revoked", async () => {
    if (skip()) return;
    const a = guard().admin;
    const ra = await insertRequest(TENANT_A, REG_A);
    await insertToken(TENANT_A, REG_A);
    const pending = await insertToken(TENANT_A, REG_A, { pending: ra });
    await expect(a.query(read(M0139, "down"))).rejects.toMatchObject({ code: "23505" });
    expect((await indexState(a, IDX_OLD))?.valid).toBe(false);
    await a.query(`DROP INDEX CONCURRENTLY ${IDX_OLD}`);
    await a.query(`UPDATE auth_tokens SET revoked_at = now() WHERE id = $1`, [pending]);
    await a.query(read(M0139, "down"));
    expect((await indexState(a, IDX_OLD))?.valid).toBe(true);
    await a.query(read(M0138, "down"));
    await a.query(read(M0137, "down"));
    expect(await indexState(a, IDX_CURRENT)).toBeNull();
    expect(await indexState(a, IDX_PENDING)).toBeNull();
  });

  it("0136 down refuses (P0001) as the NOSUPERUSER owner under FORCE RLS while a credential.rotate request exists", async () => {
    if (skip()) return;
    const e = guard();
    const result = await runAsOwner(migrationPath(M0136, "down"));
    expect(result).toBe("P0001");
    const cols = await e.admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = '${REQ}' AND column_name = 'routed_host_label'`);
    expect(cols.rowCount).toBe(1);
  });

  it("0136 down drops everything once no rotation exists, and every up applies again", async () => {
    if (skip()) return;
    const e = guard();
    await cleanRotationRows();
    expect(await runAsOwner(migrationPath(M0136, "down"))).toBeNull();
    const left = await e.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE column_name IN ('pending_rotation_request_id', 'routed_host_label', 'rotation_trigger',
                              'provisioner_host_label', 'provisioner_host_binding', 'provisioner_host_binding_revision')`,
    );
    expect(left.rows[0]!.n).toBe(0);
    expect(await indexState(e.admin, IDX_OPEN_ROTATE)).toBeNull();
    // 0136 is re-runnable: a second up over an applied one changes nothing and does not fail.
    await e.admin.query(read(M0136, "up"));
    await e.admin.query(read(M0136, "up"));
    await e.admin.query(read(M0137, "up"));
    await e.admin.query(read(M0138, "up"));
    await e.admin.query(read(M0139, "up"));
    expect((await indexState(e.admin, IDX_CURRENT))?.valid).toBe(true);
    expect((await indexState(e.admin, IDX_PENDING))?.valid).toBe(true);
    expect(await indexState(e.admin, IDX_OLD)).toBeNull();
  });
});
