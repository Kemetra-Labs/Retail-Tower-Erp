/**
 * RT-1309 — provisioner orchestration with a fake Descope port and a fake
 * store: idempotent re-runs, partial-failure recovery, refusals and outages.
 */
import type { FixtureCreate, FixtureIdentityProvider, FixtureLookup } from "../../src/cli/lab-fixtures/provider-port";
import type { FixtureStore } from "../../src/cli/lab-fixtures/fixture-store";
import { fixtureIdentities, type FixtureIdentity } from "../../src/cli/lab-fixtures/identity";
import type { FixtureAction, FixtureDbState, ProviderSubject } from "../../src/cli/lab-fixtures/plan";
import { dryRunReports, Provisioner } from "../../src/cli/lab-fixtures/provisioner";

const ISSUER = "https://api.descope.com/v1/apps/PLAB";

/** In-memory Descope: loginId -> { userId, test }. */
class FakeDescope implements FixtureIdentityProvider {
  readonly users = new Map<string, { userId: string; test: boolean }>();
  creates = 0;
  outage = false;
  createAnswer: FixtureCreate | null = null;
  createAsNonTest = false;

  async findFixtureUser(loginId: string): Promise<FixtureLookup> {
    if (this.outage) return { kind: "unavailable" };
    const u = this.users.get(loginId);
    if (!u) return { kind: "absent" };
    return u.test ? { kind: "test_user", userId: u.userId } : { kind: "not_test_user" };
  }

  lastEmail: string | null = null;

  lastName: string | null = null;

  async createTestUser(loginId: string, email: string, name: string): Promise<FixtureCreate> {
    this.creates++;
    this.lastEmail = email;
    this.lastName = name;
    if (this.createAnswer) return this.createAnswer;
    const userId = `U-${loginId}`;
    this.users.set(loginId, { userId, test: !this.createAsNonTest });
    return { kind: "created", userId };
  }
}

/** In-memory database keyed by fixture email. */
class FakeStore implements FixtureStore {
  readonly rows = new Map<string, FixtureDbState>();
  readonly applied: Array<{ index: number; actions: readonly FixtureAction[] }> = [];
  failNextApply = false;
  guardError: Error | null = null;

  async assertGuards(): Promise<void> {
    if (this.guardError) throw this.guardError;
  }

  async readState(identity: FixtureIdentity): Promise<FixtureDbState> {
    return this.rows.get(identity.email) ?? { user: null, links: [], membership: null };
  }

  async apply(identity: FixtureIdentity, s: ProviderSubject, actions: readonly FixtureAction[]): Promise<void> {
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error("database write failed");
    }
    this.applied.push({ index: identity.index, actions });
    const userId = `user-${identity.index}`;
    this.rows.set(identity.email, {
      user: { id: userId, displayName: identity.displayName },
      links: [{ userId, ...s, status: "active" }],
      membership: { id: `m-${identity.index}`, roleCode: "store_staff", storeAccessKind: "specific", hasStore: true },
    });
  }
}

function setup() {
  const descope = new FakeDescope();
  const store = new FakeStore();
  const p = new Provisioner({ provider: descope, store, providerKey: "descope", issuer: ISSUER });
  return { descope, store, p };
}

describe("Provisioner", () => {
  it("provisions fresh fixtures, then a second run writes nothing", async () => {
    const { descope, store, p } = setup();
    const first = await p.run("provision", fixtureIdentities(2));
    expect(first.map((r) => [r.outcome, r.provider])).toEqual([
      ["provisioned", "created"],
      ["provisioned", "created"],
    ]);
    expect(first[0]?.actions).toEqual(["create_user", "create_link", "create_membership"]);

    const second = await p.run("provision", fixtureIdentities(2));
    expect(second.map((r) => r.outcome)).toEqual(["ready", "ready"]);
    expect(descope.creates).toBe(2);
    expect(store.applied).toHaveLength(2);
  });

  it("status never writes: missing fixtures are reported, not created", async () => {
    const { descope, store, p } = setup();
    const reports = await p.run("status", fixtureIdentities(1));
    expect(reports[0]).toMatchObject({ outcome: "missing", provider: "absent" });
    expect(descope.creates).toBe(0);
    expect(store.applied).toHaveLength(0);
  });

  it("status reports a Descope test user whose database rows are missing", async () => {
    const { descope, p } = setup();
    descope.users.set("rtfx-cashier-001", { userId: "U1", test: true });
    const [r] = await p.run("status", fixtureIdentities(1));
    expect(r).toMatchObject({ outcome: "missing", provider: "test_user" });
    expect(r?.actions).toEqual(["create_user", "create_link", "create_membership"]);
  });

  it("recovers from Descope-created + database-failed by adopting the same test user", async () => {
    const { descope, store, p } = setup();
    store.failNextApply = true;
    await expect(p.run("provision", fixtureIdentities(1))).rejects.toThrow("database write failed");
    expect(descope.creates).toBe(1);

    const [r] = await p.run("provision", fixtureIdentities(1));
    expect(r).toMatchObject({ outcome: "provisioned", provider: "test_user" });
    expect(descope.creates).toBe(1);
  });

  it("refuses a loginId held by a non-test Descope user and continues", async () => {
    const { descope, store, p } = setup();
    descope.users.set("rtfx-cashier-001", { userId: "U-real", test: false });
    const reports = await p.run("provision", fixtureIdentities(2));
    expect(reports[0]).toMatchObject({ outcome: "refused", reason: "provider_not_test_user" });
    expect(reports[1]).toMatchObject({ outcome: "provisioned" });
    expect(store.applied.map((a) => a.index)).toEqual([2]);
  });

  it("refuses to create in Descope when the database already links the fixture user", async () => {
    const { descope, store, p } = setup();
    const [id] = fixtureIdentities(1) as [FixtureIdentity];
    store.rows.set(id.email, {
      user: { id: "user-1", displayName: id.displayName },
      links: [{ userId: "user-1", providerKey: "descope", issuer: ISSUER, subject: "U-gone", status: "active" }],
      membership: null,
    });
    const [r] = await p.run("provision", [id]);
    expect(r).toMatchObject({ outcome: "refused", reason: "db_linked_but_provider_user_absent" });
    expect(descope.creates).toBe(0);
  });

  it("refuses a database conflict without writing", async () => {
    const { descope, store, p } = setup();
    const [id] = fixtureIdentities(1) as [FixtureIdentity];
    descope.users.set(id.loginId, { userId: "U1", test: true });
    store.rows.set(id.email, {
      user: { id: "user-1", displayName: id.displayName },
      links: [{ userId: "user-1", providerKey: "descope", issuer: ISSUER, subject: "U-other", status: "active" }],
      membership: null,
    });
    const [r] = await p.run("provision", [id]);
    expect(r).toMatchObject({ outcome: "refused", reason: "user_linked_to_another_subject" });
    expect(store.applied).toHaveLength(0);
  });

  it("stops the whole run on a Descope outage (no retries)", async () => {
    const { descope, store, p } = setup();
    descope.outage = true;
    const reports = await p.run("provision", fixtureIdentities(3));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "stopped", reason: "provider_unavailable" });
    expect(store.applied).toHaveLength(0);
  });

  it.each([
    [{ kind: "unavailable" } as FixtureCreate, "stopped", "provider_unavailable"],
    [{ kind: "rejected" } as FixtureCreate, "refused", "provider_create_rejected"],
  ])("maps a failed create to %#", async (answer, outcome, reason) => {
    const { descope, p } = setup();
    descope.createAnswer = answer;
    const [r] = await p.run("provision", fixtureIdentities(1));
    expect(r).toMatchObject({ outcome, reason });
  });

  it("sends the fixture's non-deliverable email on create and reports the provider code on a rejection", async () => {
    const { descope, p } = setup();
    const [ok] = await p.run("provision", fixtureIdentities(1));
    expect(ok?.outcome).toBe("provisioned");
    expect(descope.lastEmail).toBe("rtfx-cashier-001@fixtures.invalid");

    const second = setup();
    second.descope.createAnswer = { kind: "rejected", code: "E011002" };
    const [r] = await second.p.run("provision", fixtureIdentities(1));
    expect(r).toMatchObject({ outcome: "refused", reason: "provider_create_rejected:E011002" });
  });

  it("refuses a created user that Descope does not report back as a test user", async () => {
    const { descope, store, p } = setup();
    descope.createAsNonTest = true;
    const [r] = await p.run("provision", fixtureIdentities(1));
    expect(r).toMatchObject({ outcome: "refused", reason: "created_user_not_verified_as_test" });
    expect(store.applied).toHaveLength(0);
  });

  it("stops when the re-verification after create hits an outage", async () => {
    const { descope, p } = setup();
    const original = descope.createTestUser.bind(descope);
    descope.createTestUser = async (loginId: string, email: string, name: string) => {
      const created = await original(loginId, email, name);
      descope.outage = true;
      return created;
    };
    const [r] = await p.run("provision", fixtureIdentities(1));
    expect(r).toMatchObject({ outcome: "stopped", reason: "provider_unavailable", provider: "created" });
  });

  it("runs the database guards first and writes nothing when they refuse", async () => {
    const { descope, store, p } = setup();
    store.guardError = new Error("guard");
    await expect(p.run("provision", fixtureIdentities(1))).rejects.toThrow("guard");
    expect(descope.creates).toBe(0);
  });
});

describe("dryRunReports", () => {
  it("plans every index without any Descope or database call", () => {
    expect(dryRunReports(fixtureIdentities(2))).toEqual([
      { index: 1, loginId: "rtfx-cashier-001", outcome: "would_provision", actions: [], provider: "not_checked", reason: "dry_run_no_io" },
      { index: 2, loginId: "rtfx-cashier-002", outcome: "would_provision", actions: [], provider: "not_checked", reason: "dry_run_no_io" },
    ]);
  });
});
