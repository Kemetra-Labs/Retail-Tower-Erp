/**
 * RT-1309 — the per-fixture plan: complete only what is ours, refuse the rest,
 * and write nothing when everything is present (idempotency).
 */
import { planFixture, preCreateRefusal, type FixtureDbState, type LinkRow } from "../../src/cli/lab-fixtures/plan";

const S = { providerKey: "descope", issuer: "https://api.descope.com/v1/apps/PLAB", subject: "U-fixture" };
const USER = { id: "11111111-1111-4111-8111-111111111111", displayName: "RT Fixture Cashier 001" };
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

function link(overrides: Partial<LinkRow> = {}): LinkRow {
  return { userId: USER.id, ...S, status: "active", ...overrides };
}

function state(overrides: Partial<FixtureDbState> = {}): FixtureDbState {
  return { user: null, links: [], membership: null, ...overrides };
}

const MEMBERSHIP = { id: "m1", roleCode: "store_staff", storeAccessKind: "specific", hasStore: true };

describe("planFixture", () => {
  it("creates everything for a fresh fixture", () => {
    expect(planFixture(state(), S)).toEqual({
      kind: "apply",
      actions: ["create_user", "create_link", "create_membership"],
    });
  });

  it("writes nothing when the fixture is complete (second run)", () => {
    expect(planFixture(state({ user: USER, links: [link()], membership: MEMBERSHIP }), S)).toEqual({
      kind: "apply",
      actions: [],
    });
  });

  it("completes a fixture whose earlier run stopped after the user row", () => {
    expect(planFixture(state({ user: USER }), S)).toEqual({
      kind: "apply",
      actions: ["create_link", "create_membership"],
    });
  });

  it("adds the store to a 'specific' membership that lacks it", () => {
    const m = { ...MEMBERSHIP, hasStore: false };
    expect(planFixture(state({ user: USER, links: [link()], membership: m }), S)).toEqual({
      kind: "apply",
      actions: ["grant_store_access"],
    });
  });

  it("accepts an 'all' membership as it is", () => {
    const m = { ...MEMBERSHIP, storeAccessKind: "all", hasStore: false };
    expect(planFixture(state({ user: USER, links: [link()], membership: m }), S).kind).toBe("apply");
  });

  it.each([
    ["the subject belongs to another user", state({ user: USER, links: [link({ userId: OTHER_USER })] }), "subject_linked_to_another_user"],
    ["the subject is linked but the fixture user does not exist", state({ links: [link({ userId: OTHER_USER })] }), "subject_linked_to_another_user"],
    ["the user is linked to another subject", state({ user: USER, links: [link({ subject: "U-other" })] }), "user_linked_to_another_subject"],
    ["the user is linked under another issuer", state({ user: USER, links: [link({ issuer: "https://elsewhere" })] }), "user_linked_to_another_subject"],
    ["the user's link is disabled (never re-activated)", state({ user: USER, links: [link({ status: "disabled" })] }), "user_has_inactive_link"],
    ["the user has no display name (cannot be updated here)", state({ user: { ...USER, displayName: null } }), "user_has_no_display_name"],
    ["the membership has another role", state({ user: USER, links: [link()], membership: { ...MEMBERSHIP, roleCode: "owner" } }), "membership_role_conflict"],
  ])("refuses when %s", (_name, s, reason) => {
    expect(planFixture(s, S)).toEqual({ kind: "refuse", reason });
  });
});

describe("preCreateRefusal", () => {
  it("allows a fresh fixture and a user without links", () => {
    expect(preCreateRefusal(state())).toBeNull();
    expect(preCreateRefusal(state({ user: USER }))).toBeNull();
  });

  it("refuses a linked user whose Descope test user is absent", () => {
    expect(preCreateRefusal(state({ user: USER, links: [link()] }))).toBe("db_linked_but_descope_user_absent");
  });
});
