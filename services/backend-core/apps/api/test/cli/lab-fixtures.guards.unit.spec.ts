/**
 * RT-1309 — each lab-fixture guard refuses on its own (static guards, no I/O).
 * The database guards are exercised against real Postgres in
 * lab-fixtures.store.spec.ts.
 */
import {
  ENABLE_ENV,
  LAB_DESCOPE_PROJECT_IDS,
  LAB_FIXTURE_TENANT_IDS,
  MAX_FIXTURES,
} from "../../src/cli/lab-fixtures/constants";
import {
  assertLabDatabase,
  assertStaticGuards,
  GuardRefusedError,
  type StaticGuardInput,
} from "../../src/cli/lab-fixtures/guards";
import { fixtureIdentities, fixtureIdentity } from "../../src/cli/lab-fixtures/identity";

const STORE = "fa76847c-8a5a-4c2c-92a5-a91551f394d5";

function valid(overrides: Partial<StaticGuardInput> = {}): StaticGuardInput {
  return {
    env: { [ENABLE_ENV]: "enabled" },
    descopeProjectId: LAB_DESCOPE_PROJECT_IDS[0] ?? "",
    tenantId: LAB_FIXTURE_TENANT_IDS[0] ?? "",
    storeId: STORE,
    count: 1,
    ...overrides,
  };
}

function familyOf(input: StaticGuardInput): string | null {
  try {
    assertStaticGuards(input);
    return null;
  } catch (err: unknown) {
    if (err instanceof GuardRefusedError) return err.family;
    throw err;
  }
}

describe("lab-fixtures static guards", () => {
  it("passes for the allowlisted lab inputs", () => {
    expect(familyOf(valid())).toBeNull();
  });

  it.each([
    ["flag missing", { env: {} }, "environment"],
    ["flag with another value", { env: { [ENABLE_ENV]: "true" } }, "environment"],
    ["NODE_ENV=development is not enough", { env: { NODE_ENV: "development" } }, "environment"],
    ["unknown Descope project", { descopeProjectId: "Pother" }, "identity"],
    ["empty Descope project", { descopeProjectId: "" }, "identity"],
    ["tenant not allowlisted", { tenantId: "00000000-0000-4000-8000-000000000001" }, "tenant"],
    ["malformed tenant", { tenantId: "not-a-uuid" }, "input"],
    ["malformed store", { storeId: "FA76847C" }, "input"],
    ["count zero", { count: 0 }, "input"],
    ["count above the bound", { count: MAX_FIXTURES + 1 }, "input"],
    ["count not an integer", { count: 1.5 }, "input"],
    ["count missing (NaN)", { count: Number.NaN }, "input"],
  ])("refuses: %s", (_name, overrides, family) => {
    expect(familyOf(valid(overrides as Partial<StaticGuardInput>))).toBe(family);
  });

  it("checks the flag before anything else (a production target with every other input valid)", () => {
    expect(familyOf(valid({ env: { NODE_ENV: "production" } }))).toBe("environment");
  });
});

describe("assertLabDatabase (also run on the auth-lookup connection)", () => {
  const db = (name: string | undefined) => ({
    query: jest.fn(async () => ({ rows: name === undefined ? [] : [{ name }] })),
  });

  it("accepts the lab database name", async () => {
    await expect(assertLabDatabase(db("rtlab") as never)).resolves.toBeUndefined();
  });

  it.each([["dp2_prod"], ["rtlab_copy"], [undefined]])("refuses %p", async (name) => {
    const err = await assertLabDatabase(db(name) as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardRefusedError);
    expect((err as GuardRefusedError).family).toBe("environment");
  });
});

describe("fixture identities", () => {
  it("are deterministic, namespaced and never a deliverable address", () => {
    expect(fixtureIdentity(7)).toEqual({
      index: 7,
      loginId: "rtfx-cashier-007",
      email: "rtfx-cashier-007@fixtures.invalid",
      displayName: "RT Fixture Cashier 007",
    });
    expect(fixtureIdentities(3).map((i) => i.loginId)).toEqual([
      "rtfx-cashier-001",
      "rtfx-cashier-002",
      "rtfx-cashier-003",
    ]);
  });

  it.each([0, -1, MAX_FIXTURES + 1, 2.5])("rejects index %p", (index) => {
    expect(() => fixtureIdentity(index)).toThrow(RangeError);
  });
});
