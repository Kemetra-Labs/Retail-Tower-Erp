/**
 * RT-797 — the pilot bootstrap seed writes the operator's identity link.
 *
 * Real Postgres (full schema, Testcontainers); every seed run, re-runs
 * included, uses the non-superuser app role so RLS applies. Proves: a
 * fresh seed writes the user (bridge column kept until RT-799) AND its active
 * `external_identity_links` row; a re-run is a no-op (RT-939: it finds the
 * pilot tenant under FORCE RLS instead of inserting a second); a pilot seeded before
 * RT-797 (bridge column, no link) gains the link without a second user; a user
 * moved to another provider by the cutover keeps its active link, and the
 * output says the configured identity is not the active one; the inputs are
 * provider-neutral and validated.
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
 * One run of the seed as the CLI does it: a FRESH session, one transaction, as
 * the non-superuser app role (FORCE ROW LEVEL SECURITY applies to it).
 */
async function runSeed(cfg: PilotConfig): Promise<MintedIds> {
  const { host, port } = pg();
  const client = new Client({
    connectionString: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${host}:${port}/test`,
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

/** Row counts the seed writes for one pilot slug, read as the superuser. */
async function pilotRowCounts(slug: string): Promise<Record<string, number>> {
  const { rows } = await pg().admin.query(
    `SELECT
       (SELECT count(*) FROM tenants WHERE slug = $1)::int AS tenants,
       (SELECT count(*) FROM stores s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = $1)::int AS stores,
       (SELECT count(*) FROM roles r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = $1)::int AS roles,
       (SELECT count(*) FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = $1)::int AS memberships`,
    [slug],
  );
  return rows[0];
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
    const ids = await runSeed(cfg);
    expect(ids).toMatchObject({
      operator_provider_key: "acme",
      operator_provider_subject: subject,
      operator_link_active: true,
    });
    const seeded = await operatorState(subject, cfg.operatorEmail);
    expect(seeded).toEqual({
      users: [{ id: ids.operator_user_id, clerk_user_id: subject }],
      links: [{ provider_key: "acme", issuer: ISSUER, subject, user_id: ids.operator_user_id, status: "active" }],
    });
    const counts = await pilotRowCounts(cfg.tenantSlug);
    expect(counts).toEqual({ tenants: 1, stores: 1, roles: 4, memberships: 1 });
    // RT-939: the re-run, also as the app role, finds the tenant under RLS.
    await expect(runSeed(cfg)).resolves.toEqual(ids);
    expect(await operatorState(subject, cfg.operatorEmail)).toEqual(seeded);
    expect(await pilotRowCounts(cfg.tenantSlug)).toEqual(counts);
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

  it("finds a user cut over to another provider through its (disabled) link, leaves its links alone and says so", async () => {
    if (skip()) return;
    const cfg = config();
    const { subject } = cfg.operatorIdentity;
    const ids = await runSeed(cfg);
    // The identity-link cutover moved this user to another provider. The bridge
    // column is cleared so only the (disabled) link can find the user.
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
    // Same user, no new link, and the output does not claim the configured
    // identity is the one the operator signs in with.
    await expect(runSeed(cfg)).resolves.toEqual({ ...ids, operator_link_active: false });
    expect(await operatorState(subject, cfg.operatorEmail)).toEqual(before);
  });

  it("never adopts a LINKED user through the bridge column: another provider's equal subject fails closed", async () => {
    if (skip()) return;
    const cfg = config();
    const { subject } = cfg.operatorIdentity;
    // An existing user of another provider whose bridge column happens to hold
    // the configured subject.
    const a = pg().admin;
    const other = "0a000000-0000-7000-8000-79700000b1d9";
    await a.query("INSERT INTO users (id, email, clerk_user_id) VALUES ($1, $2, $3)", [
      other,
      "other-provider@rt797.example",
      subject,
    ]);
    await a.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status)
       VALUES ('legacy', 'https://legacy.rt797.example', $1, $2, 'active')`,
      [subject, other],
    );
    await expect(runSeed(cfg)).rejects.toThrow();
    const memberships = await a.query("SELECT 1 FROM memberships WHERE user_id = $1", [other]);
    expect(memberships.rows).toHaveLength(0);
    const acme = await a.query("SELECT 1 FROM external_identity_links WHERE provider_key = 'acme' AND subject = $1", [
      subject,
    ]);
    expect(acme.rows).toHaveLength(0);
  });

  it("refuses an ambiguous identity (two users hold it active under two issuers), as sign-in does", async () => {
    if (skip()) return;
    const cfg = config();
    const { subject } = cfg.operatorIdentity;
    const a = pg().admin;
    const holders = ["0a000000-0000-7000-8000-79700000a001", "0a000000-0000-7000-8000-79700000a002"];
    for (const [i, user] of holders.entries()) {
      await a.query("INSERT INTO users (id, email) VALUES ($1, $2)", [user, `ambiguous${i}-${subject}@rt797.example`]);
      await a.query(
        `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status)
         VALUES ('acme', $1, $2, $3, 'active')`,
        [`https://issuer-${i}.rt797.example`, subject, user],
      );
    }
    await expect(runSeed(cfg)).rejects.toThrow(/more than one active link/);
    const memberships = await a.query("SELECT 1 FROM memberships WHERE user_id = ANY($1::uuid[])", [holders]);
    expect(memberships.rows).toHaveLength(0);
  });

  it("never re-activates a disabled configured link, even when it is the user's only link", async () => {
    if (skip()) return;
    const cfg = config();
    const { subject } = cfg.operatorIdentity;
    const ids = await runSeed(cfg);
    await pg().admin.query(
      "UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE user_id = $1",
      [ids.operator_user_id],
    );
    const before = await operatorState(subject, cfg.operatorEmail);
    await expect(runSeed(cfg)).resolves.toEqual({ ...ids, operator_link_active: false });
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
