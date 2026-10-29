/**
 * RT-797 — the provider-neutral identity-link cutover CLI against real Postgres
 * (full schema, Testcontainers), run as the non-superuser app role like the
 * deployed tool.
 *
 * Proves: apply flips the links in one transaction; rollback restores the
 * original link states exactly; both are idempotent (zero counts on re-run) and
 * repeatable (apply → rollback → apply → rollback); --dry-run writes nothing;
 * unexpected states are refused with nothing written; the result carries counts
 * only; `users.clerk_user_id` is never read or written (a user with a NULL bridge
 * column moves between providers by link rows alone); no link row is deleted.
 */
import type { PoolClient } from "pg";

import {
  CutoverRefusedError,
  runIdentityLinkCutover,
  type IdentityLinkCutoverCommand,
} from "../../src/cli/identity-link-cutover";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const OLD = "clerk";
const NEW = "descope";
const OLD_ISSUER = "https://clerk.dp2.local";
const NEW_ISSUER = "https://api.descope.com/v1/apps/P2cutoverTest01";
/** The form the first #889 CLI build stored (the rt9 lab has one such active row). */
const LEGACY_NEW_ISSUER = "https://api.descope.com/P2cutoverTest01";

let env: PgTestEnv | null = null;
let seq = 0;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

interface Fixture {
  readonly userId: string;
  readonly oldSub: string;
  readonly newSub: string;
}

interface SeedOptions {
  /** The bridge column; defaults to the old subject (a Clerk-era user). */
  readonly bridge?: string | null;
}

/** A user with an active link at the OLD provider (as the 0025 backfill writes it). */
async function seedUser(opts: SeedOptions = {}): Promise<Fixture> {
  seq += 1;
  const n = (0x797000000000 + seq).toString(16);
  const userId = `0a000000-0000-7000-8000-${n}`;
  const oldSub = `user_old_cutover_${seq}`;
  const newSub = `U2newCutover${seq}`;
  const a = pg().admin;
  await a.query(`INSERT INTO users (id, email, clerk_user_id) VALUES ($1, $2, $3)`, [
    userId,
    `cutover${seq}@rt797.example`,
    opts.bridge === undefined ? oldSub : opts.bridge,
  ]);
  await a.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [OLD, OLD_ISSUER, oldSub, userId, `cutover${seq}@rt797.example`],
  );
  return { userId, oldSub, newSub };
}

interface Snapshot {
  readonly bridge: string | null;
  readonly links: ReadonlyArray<{
    provider_key: string;
    issuer: string;
    subject: string;
    status: string;
    disabled: boolean;
  }>;
}

async function snapshot(userId: string): Promise<Snapshot> {
  const a = pg().admin;
  const u = await a.query<{ clerk_user_id: string | null }>("SELECT clerk_user_id FROM users WHERE id = $1", [
    userId,
  ]);
  const l = await a.query(
    `SELECT provider_key, issuer, subject, status, disabled_at IS NOT NULL AS disabled
       FROM external_identity_links WHERE user_id = $1 ORDER BY provider_key, subject`,
    [userId],
  );
  return { bridge: u.rows[0]?.clerk_user_id ?? null, links: l.rows };
}

async function linkCount(): Promise<number> {
  const r = await pg().admin.query<{ n: string }>("SELECT count(*) AS n FROM external_identity_links");
  return Number(r.rows[0]!.n);
}

async function run(cmd: IdentityLinkCutoverCommand) {
  const client: PoolClient = await pg().app.connect();
  try {
    return await runIdentityLinkCutover(client, cmd);
  } finally {
    client.release();
  }
}

const apply = (f: Fixture, dryRun = false): IdentityLinkCutoverCommand => ({
  kind: "apply",
  userId: f.userId,
  from: OLD,
  to: NEW,
  subject: f.newSub,
  issuer: NEW_ISSUER,
  dryRun,
});
const rollback = (f: Fixture, dryRun = false): IdentityLinkCutoverCommand => ({
  kind: "rollback",
  userId: f.userId,
  from: OLD,
  to: NEW,
  dryRun,
});

const link = (provider: string, issuer: string, subject: string, active: boolean) => ({
  provider_key: provider,
  issuer,
  subject,
  status: active ? "active" : "disabled",
  disabled: !active,
});

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[identity-link-cutover.spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("identity-link-cutover apply", () => {
  it("disables the source link and activates the target link; the bridge column is untouched", async () => {
    if (skip()) return;
    const f = await seedUser();
    const result = await run(apply(f));
    expect(result).toEqual({
      command: "apply",
      dryRun: false,
      alreadyInTargetState: false,
      linksDisabled: 1,
      linksActivated: 1,
    });
    expect(await snapshot(f.userId)).toEqual({
      bridge: f.oldSub,
      links: [link(OLD, OLD_ISSUER, f.oldSub, false), link(NEW, NEW_ISSUER, f.newSub, true)],
    });
    // Counts only: no id, subject or email in the result.
    const flat = JSON.stringify(result);
    for (const v of [f.userId, f.oldSub, f.newSub, "@rt797.example"]) {
      expect(flat).not.toContain(v);
    }
  });

  it("is idempotent: a second apply writes nothing", async () => {
    if (skip()) return;
    const f = await seedUser();
    await run(apply(f));
    const before = await snapshot(f.userId);
    await expect(run(apply(f))).resolves.toEqual({
      command: "apply",
      dryRun: false,
      alreadyInTargetState: true,
      linksDisabled: 0,
      linksActivated: 0,
    });
    expect(await snapshot(f.userId)).toEqual(before);
  });

  it("--dry-run reports the counts and writes nothing", async () => {
    if (skip()) return;
    const f = await seedUser();
    const before = await snapshot(f.userId);
    await expect(run(apply(f, true))).resolves.toMatchObject({ dryRun: true, linksDisabled: 1, linksActivated: 1 });
    expect(await snapshot(f.userId)).toEqual(before);
  });
});

describe("identity-link-cutover rollback", () => {
  it("restores the original links exactly; the target link ends disabled; the bridge column is untouched", async () => {
    if (skip()) return;
    const f = await seedUser();
    const original = await snapshot(f.userId);
    await run(apply(f));
    await expect(run(rollback(f))).resolves.toEqual({
      command: "rollback",
      dryRun: false,
      alreadyInTargetState: false,
      linksDisabled: 1,
      linksActivated: 1,
    });
    expect(await snapshot(f.userId)).toEqual({
      bridge: original.bridge,
      links: [...original.links, link(NEW, NEW_ISSUER, f.newSub, false)],
    });
  });

  it("is idempotent and repeatable: apply → rollback → apply → rollback → rollback", async () => {
    if (skip()) return;
    const f = await seedUser();
    await run(apply(f));
    const applied = await snapshot(f.userId);
    await run(rollback(f));
    const rolledBack = await snapshot(f.userId);
    await expect(run(apply(f))).resolves.toMatchObject({ alreadyInTargetState: false });
    expect(await snapshot(f.userId)).toEqual(applied);
    await run(rollback(f));
    expect(await snapshot(f.userId)).toEqual(rolledBack);
    await expect(run(rollback(f))).resolves.toMatchObject({ alreadyInTargetState: true, linksDisabled: 0 });
    expect(await snapshot(f.userId)).toEqual(rolledBack);
  });

  it("--dry-run writes nothing", async () => {
    if (skip()) return;
    const f = await seedUser();
    await run(apply(f));
    const applied = await snapshot(f.userId);
    await run(rollback(f, true));
    expect(await snapshot(f.userId)).toEqual(applied);
  });
});

describe("identity-link-cutover moves a user by link rows alone", () => {
  it("a user with a NULL bridge column moves to the new provider and back; no link row is deleted", async () => {
    if (skip()) return;
    const f = await seedUser({ bridge: null });
    const original = await snapshot(f.userId);
    const count = await linkCount();
    await run(apply(f));
    expect(await snapshot(f.userId)).toEqual({
      bridge: null,
      links: [link(OLD, OLD_ISSUER, f.oldSub, false), link(NEW, NEW_ISSUER, f.newSub, true)],
    });
    expect(await linkCount()).toBe(count + 1);
    await run(rollback(f));
    expect(await snapshot(f.userId)).toEqual({
      bridge: null,
      links: [...original.links, link(NEW, NEW_ISSUER, f.newSub, false)],
    });
    expect(await linkCount()).toBe(count + 1);
  });

  it("moves between any two providers the CLI has never heard of", async () => {
    if (skip()) return;
    const f = await seedUser({ bridge: null });
    const third: IdentityLinkCutoverCommand = {
      kind: "apply",
      userId: f.userId,
      from: OLD,
      to: "acme",
      subject: "acme|rt797",
      issuer: "https://idp.acme.example",
      dryRun: false,
    };
    await run(third);
    await run({ ...third, from: "acme", to: NEW, subject: f.newSub, issuer: NEW_ISSUER });
    expect(await snapshot(f.userId)).toEqual({
      bridge: null,
      links: [
        link("acme", "https://idp.acme.example", "acme|rt797", false),
        link(OLD, OLD_ISSUER, f.oldSub, false),
        link(NEW, NEW_ISSUER, f.newSub, true),
      ],
    });
  });
});

// --- refusals: each case stages one unexpected state; nothing may be written --

async function unlinkAll(f: Fixture): Promise<void> {
  await pg().admin.query("DELETE FROM external_identity_links WHERE user_id = $1", [f.userId]);
}

interface StrayLink {
  readonly provider: string;
  readonly issuer: string;
  readonly subject: string;
}

/** Give a fresh other user a disabled link (the unique index allows that alongside ours). */
async function linkToOtherUser(stray: StrayLink): Promise<void> {
  const other = await seedUser();
  await pg().admin.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
     VALUES ($1, $2, $3, $4, 'disabled', now())`,
    [stray.provider, stray.issuer, stray.subject, other.userId],
  );
}

interface RefusalCase {
  readonly code: string;
  /** Stage the state on fixture `f`; return the command that must be refused. */
  readonly arrange: (f: Fixture) => Promise<IdentityLinkCutoverCommand>;
}

const REFUSALS: Record<string, RefusalCase> = {
  "an unknown user": {
    code: "user_not_found",
    arrange: async (f) => ({ ...apply(f), userId: "0a000000-0000-7000-8000-ffffffffffff" }),
  },
  "only disabled source links": {
    code: "no_active_source_link",
    arrange: async (f) => {
      await pg().admin.query(
        "UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE user_id = $1",
        [f.userId],
      );
      return apply(f);
    },
  },
  "a bridge column with no link row (the bridge column is never read)": {
    code: "no_active_source_link",
    arrange: async (f) => {
      await unlinkAll(f);
      return apply(f);
    },
  },
  "a target subject linked to another user": {
    code: "target_subject_linked_to_other_user",
    arrange: async (f) => {
      await linkToOtherUser({ provider: NEW, issuer: NEW_ISSUER, subject: f.newSub });
      return apply(f);
    },
  },
  "a target subject linked to another user under a DIFFERENT issuer": {
    code: "target_subject_linked_to_other_user",
    arrange: async (f) => {
      await linkToOtherUser({ provider: NEW, issuer: "https://other.issuer.example", subject: f.newSub });
      return apply(f);
    },
  },
  "a different target subject while one is active": {
    code: "inconsistent_target_state",
    arrange: async (f) => {
      await run(apply(f));
      return { ...apply(f), subject: "U2someoneElse" } as IdentityLinkCutoverCommand;
    },
  },
  "apply when a third provider's link is the active one": {
    code: "unexpected_active_link",
    arrange: async (f) => {
      await unlinkAll(f);
      await pg().admin.query(
        `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status)
         VALUES ('keycloak', 'https://kc.example', $1, $2, 'active')`,
        [`kc-${f.oldSub}`, f.userId],
      );
      return apply(f);
    },
  },
  "rollback with no active link at all": {
    code: "no_active_target_link",
    arrange: async (f) => {
      await pg().admin.query(
        "UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE user_id = $1",
        [f.userId],
      );
      return rollback(f);
    },
  },
  "rollback when a third provider's link is the active one": {
    code: "unexpected_active_link",
    arrange: async (f) => {
      await run({ ...apply(f), to: "keycloak", issuer: "https://kc.example" } as IdentityLinkCutoverCommand);
      return rollback(f);
    },
  },
  "rollback with no disabled source link to restore": {
    code: "no_disabled_source_link",
    arrange: async (f) => {
      await run(apply(f));
      await pg().admin.query("DELETE FROM external_identity_links WHERE user_id = $1 AND provider_key = $2", [
        f.userId,
        OLD,
      ]);
      return rollback(f);
    },
  },
  "rollback when another user was linked to the source subject after apply": {
    code: "source_subject_linked_to_other_user",
    arrange: async (f) => {
      await run(apply(f));
      await linkToOtherUser({ provider: OLD, issuer: "https://clerk.other.example", subject: f.oldSub });
      return rollback(f);
    },
  },
};

describe("identity-link-cutover refusals (nothing written)", () => {
  it.each(Object.entries(REFUSALS))("%s", async (_name, c) => {
    if (skip()) return;
    const f = await seedUser();
    const cmd = await c.arrange(f);
    const before = await snapshot(f.userId);
    const count = await linkCount();
    const err = await run(cmd).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CutoverRefusedError);
    expect((err as CutoverRefusedError).code).toBe(c.code);
    expect(await snapshot(f.userId)).toEqual(before);
    expect(await linkCount()).toBe(count);
  });
});

describe("identity-link-cutover rollback with older source history", () => {
  it("restores the source link apply disabled, not an older disabled one", async () => {
    if (skip()) return;
    const f = await seedUser();
    await pg().admin.query(
      `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
       VALUES ($1, $2, $3, $4, 'disabled', now() - interval '30 days')`,
      [OLD, OLD_ISSUER, `${f.oldSub}_older`, f.userId],
    );
    const original = await snapshot(f.userId);
    await run(apply(f));
    await run(rollback(f));
    expect(await snapshot(f.userId)).toEqual({
      bridge: original.bridge,
      links: [...original.links, link(NEW, NEW_ISSUER, f.newSub, false)],
    });
  });
});

// ---------------------------------------------------------------------------
// rt9 lab state: an ACTIVE target link stored under the legacy issuer form
// (https://api.descope.com/<projectId>) by the first #889 CLI build. Re-apply,
// rollback and re-apply with the canonical issuer must all still work.
// ---------------------------------------------------------------------------

describe("identity-link-cutover with a target link stored under a legacy issuer", () => {
  async function seedLabState(): Promise<Fixture> {
    const f = await seedUser();
    await run({ ...apply(f), issuer: LEGACY_NEW_ISSUER } as IdentityLinkCutoverCommand);
    return f;
  }

  it("re-apply with the canonical issuer is a no-op (matched on subject, not issuer)", async () => {
    if (skip()) return;
    const f = await seedLabState();
    const before = await snapshot(f.userId);
    await expect(run(apply(f))).resolves.toMatchObject({ alreadyInTargetState: true, linksActivated: 0 });
    expect(await snapshot(f.userId)).toEqual(before);
  });

  it("rollback restores the source; a later apply re-activates the same legacy row (no second row)", async () => {
    if (skip()) return;
    const f = await seedLabState();
    await expect(run(rollback(f))).resolves.toMatchObject({ alreadyInTargetState: false, linksActivated: 1 });
    expect(await snapshot(f.userId)).toEqual({
      bridge: f.oldSub,
      links: [link(OLD, OLD_ISSUER, f.oldSub, true), link(NEW, LEGACY_NEW_ISSUER, f.newSub, false)],
    });
    await expect(run(apply(f))).resolves.toMatchObject({ alreadyInTargetState: false, linksActivated: 1 });
    expect(await snapshot(f.userId)).toEqual({
      bridge: f.oldSub,
      links: [link(OLD, OLD_ISSUER, f.oldSub, false), link(NEW, LEGACY_NEW_ISSUER, f.newSub, true)],
    });
  });
});
