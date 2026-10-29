/**
 * RT-797 — the pilot bootstrap seed writes the operator's identity link.
 *
 * Real Postgres (full schema, Testcontainers); the first seed runs as the
 * non-superuser app role so RLS applies (re-runs: see `runSeed`). Proves: a fresh seed writes the user (bridge column
 * kept until RT-799) AND its active `external_identity_links` row; a re-run is
 * a no-op; a pilot seeded before RT-797 (bridge column, no link) gains the link
 * without a second user; a user moved to another provider by the cutover keeps
 * its active link; the inputs are provider-neutral and validated.
 */
import { Client } from "pg";

import { PilotConfigError, readConfig, seed, type MintedIds, type PilotConfig } from "../../src/cli/bootstrap-pilot";
import {
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const ISSUER = "https://issuer.rt797.example";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

/** A config for its own tenant, so the cases never share rows. */
function config(subject?: string): PilotConfig {
  seq += 1;
  return readConfig({
    OPERATOR_PROVIDER_KEY: "acme",
    OPERATOR_PROVIDER_ISSUER: ISSUER,
    OPERATOR_PROVIDER_SUBJECT: subject ?? `acme|rt797-${seq}`,
    PILOT_TENANT_SLUG: `rt797-pilot-${seq}`,
    PILOT_OPERATOR_EMAIL: `operator${seq}@rt797.example`,
  });
}

/**
 * One run of the seed as the CLI does it: a FRESH session, one transaction.
 *
 * Re-runs use the superuser. The seed's existing-tenant lookup runs before it
 * sets the tenant GUC, and `tenants` has FORCE ROW LEVEL SECURITY, so a
 * non-superuser re-run cannot see the pilot tenant (a pre-existing gap, not
 * RT-797's). The first run is also proven under RLS as the app role.
 */
async function runSeed(cfg: PilotConfig, role: "app" | "superuser" = "superuser"): Promise<MintedIds> {
  const { host, port, adminUri } = pg();
  const client = new Client({
    connectionString:
      role === "app" ? `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${host}:${port}/test` : adminUri,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const ids = await seed(client, cfg);
    await client.query("COMMIT");
    return ids;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

interface OperatorState {
  readonly users: ReadonlyArray<{ id: string; clerk_user_id: string | null }>;
  readonly links: ReadonlyArray<{ provider_key: string; issuer: string; subject: string; user_id: string; status: string }>;
}

async function operatorState(subject: string, email: string): Promise<OperatorState> {
  const a = pg().admin;
  const users = await a.query("SELECT id, clerk_user_id FROM users WHERE email = $1 ORDER BY id", [email]);
  const links = await a.query(
    `SELECT provider_key, issuer, subject, user_id, status FROM external_identity_links
      WHERE subject = $1 OR user_id = ANY($2::uuid[]) ORDER BY provider_key, subject`,
    [subject, users.rows.map((u: { id: string }) => u.id)],
  );
  return { users: users.rows, links: links.rows };
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[bootstrap-pilot.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("bootstrap-pilot seed", () => {
  it("writes the operator user and its ACTIVE identity link; a re-run is a no-op", async () => {
    if (skip()) return;
    const cfg = config();
    const { subject } = cfg.operatorIdentity;
    const ids = await runSeed(cfg, "app");
    expect(ids).toMatchObject({ operator_provider_key: "acme", operator_provider_subject: subject });
    const seeded = await operatorState(subject, cfg.operatorEmail);
    expect(seeded).toEqual({
      users: [{ id: ids.operator_user_id, clerk_user_id: subject }],
      links: [{ provider_key: "acme", issuer: ISSUER, subject, user_id: ids.operator_user_id, status: "active" }],
    });
    await expect(runSeed(cfg)).resolves.toEqual(ids);
    expect(await operatorState(subject, cfg.operatorEmail)).toEqual(seeded);
  });

  it("a pilot seeded before RT-797 (bridge column, no link) gains the link and no second user", async () => {
    if (skip()) return;
    const cfg = config();
    const { subject } = cfg.operatorIdentity;
    const ids = await runSeed(cfg);
    await pg().admin.query("DELETE FROM external_identity_links WHERE user_id = $1", [ids.operator_user_id]);
    await expect(runSeed(cfg)).resolves.toEqual(ids);
    expect(await operatorState(subject, cfg.operatorEmail)).toEqual({
      users: [{ id: ids.operator_user_id, clerk_user_id: subject }],
      links: [{ provider_key: "acme", issuer: ISSUER, subject, user_id: ids.operator_user_id, status: "active" }],
    });
  });

  it("finds a user cut over to another provider through its (disabled) link and leaves its links alone", async () => {
    if (skip()) return;
    const cfg = config();
    const { subject } = cfg.operatorIdentity;
    const ids = await runSeed(cfg);
    // The identity-link cutover moved this user to another provider; the
    // bridge column still holds the old subject, but the lookup goes by link.
    const a = pg().admin;
    await a.query("UPDATE users SET clerk_user_id = NULL WHERE id = $1", [ids.operator_user_id]);
    await a.query("UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE user_id = $1", [
      ids.operator_user_id,
    ]);
    await a.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status)
       VALUES ('other', 'https://other.rt797.example', $1, $2, 'active')`,
      [`${subject}-other`, ids.operator_user_id],
    );
    const before = await operatorState(subject, cfg.operatorEmail);
    await expect(runSeed(cfg)).resolves.toEqual(ids);
    expect(await operatorState(subject, cfg.operatorEmail)).toEqual(before);
  });
});

describe("bootstrap-pilot readConfig", () => {
  const ENV = {
    OPERATOR_PROVIDER_KEY: "acme",
    OPERATOR_PROVIDER_ISSUER: ISSUER,
    OPERATOR_PROVIDER_SUBJECT: "acme|rt797",
  };

  it("reads the neutral operator identity inputs", () => {
    expect(readConfig(ENV).operatorIdentity).toEqual({ providerKey: "acme", issuer: ISSUER, subject: "acme|rt797" });
  });

  it.each<[string, NodeJS.ProcessEnv, RegExp]>([
    ["a missing provider key", { ...ENV, OPERATOR_PROVIDER_KEY: undefined }, /OPERATOR_PROVIDER_KEY/],
    ["an upper-case provider key", { ...ENV, OPERATOR_PROVIDER_KEY: "Acme" }, /OPERATOR_PROVIDER_KEY/],
    ["a missing issuer", { ...ENV, OPERATOR_PROVIDER_ISSUER: undefined }, /OPERATOR_PROVIDER_ISSUER/],
    ["an http issuer", { ...ENV, OPERATOR_PROVIDER_ISSUER: "http://x.example" }, /OPERATOR_PROVIDER_ISSUER/],
    ["a blank subject", { ...ENV, OPERATOR_PROVIDER_SUBJECT: "  " }, /OPERATOR_PROVIDER_SUBJECT/],
  ])("refuses %s (exit 4), never echoing the value", (_label, bad, message) => {
    expect(() => readConfig(bad)).toThrow(PilotConfigError);
    expect(() => readConfig(bad)).toThrow(message);
    expect(() => readConfig({ ...bad, OPERATOR_PROVIDER_KEY: "Secret-ish" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("Secret-ish") }),
    );
  });

  it("no longer reads the retired provider-named input", () => {
    expect(() => readConfig({ CLERK_OPERATOR_SUBJECT: "user_x" } as NodeJS.ProcessEnv)).toThrow(PilotConfigError);
  });
});
