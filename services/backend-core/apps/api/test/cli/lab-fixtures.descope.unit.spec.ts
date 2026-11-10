/**
 * RT-1309 — the CLI-only Descope Test User adapter against a fake transport:
 * test-flag proof, non-test refusal, outages without retries, and no key leak.
 */
import { DescopeTestUsers, type DescopeFetch } from "../../src/cli/lab-fixtures/descope-test-users";

const PROJECT = "PLABproject";
const KEY = "K-secret-management-key";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(responses: Array<Response | Error>): { fetch: DescopeFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: DescopeFetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

function client(responses: Array<Response | Error>) {
  const f = fakeFetch(responses);
  return { users: new DescopeTestUsers({ projectId: PROJECT, managementKey: KEY, fetch: f.fetch }), calls: f.calls };
}

describe("DescopeTestUsers.findFixtureUser", () => {
  it("returns the test user found by the test-only search", async () => {
    const { users, calls } = client([json(200, { users: [{ userId: "U1", test: true }] })]);
    await expect(users.findFixtureUser("rtfx-cashier-001")).resolves.toEqual({ kind: "test_user", userId: "U1" });
    expect(calls[0]?.url).toBe("https://api.descope.com/v2/mgmt/user/search/test");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      loginIds: ["rtfx-cashier-001"],
      testUsersOnly: true,
      limit: 2,
    });
    expect((calls[0]?.init?.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${PROJECT}:${KEY}`);
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("treats a search hit without test=true as ambiguous (fail closed)", async () => {
    const { users } = client([json(200, { users: [{ userId: "U1" }] })]);
    await expect(users.findFixtureUser("x")).resolves.toEqual({ kind: "ambiguous" });
  });

  it("treats two matches as ambiguous", async () => {
    const { users } = client([json(200, { users: [{ userId: "U1", test: true }, { userId: "U2", test: true }] })]);
    await expect(users.findFixtureUser("x")).resolves.toEqual({ kind: "ambiguous" });
  });

  it("reports a non-test user holding the loginId", async () => {
    const { users, calls } = client([json(200, { users: [] }), json(200, { user: { userId: "U9" } })]);
    await expect(users.findFixtureUser("rtfx-cashier-001")).resolves.toEqual({ kind: "not_test_user" });
    expect(calls[1]?.url).toBe("https://api.descope.com/v1/mgmt/user?loginId=rtfx-cashier-001");
  });

  it("reports absent when neither lookup finds the loginId", async () => {
    const { users } = client([json(200, {}), json(400, { errorCode: "E" })]);
    await expect(users.findFixtureUser("x")).resolves.toEqual({ kind: "absent" });
  });

  it("reports absent when the load answer carries no user id", async () => {
    const { users } = client([json(200, { users: [] }), json(200, { user: {} })]);
    await expect(users.findFixtureUser("x")).resolves.toEqual({ kind: "absent" });
  });

  it.each([429, 500, 401, 403])("is unavailable on search status %d (no retry)", async (status) => {
    const { users, calls } = client([json(status, {})]);
    await expect(users.findFixtureUser("x")).resolves.toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("is unavailable on any other non-OK search answer", async () => {
    const { users } = client([json(400, {})]);
    await expect(users.findFixtureUser("x")).resolves.toEqual({ kind: "unavailable" });
  });

  it("is unavailable when the load lookup fails", async () => {
    const { users } = client([json(200, { users: [] }), json(503, {})]);
    await expect(users.findFixtureUser("x")).resolves.toEqual({ kind: "unavailable" });
  });

  it("is unavailable on a transport error and never leaks the key", async () => {
    const { users } = client([new Error(`socket closed; Authorization: Bearer ${PROJECT}:${KEY}`)]);
    const result = await users.findFixtureUser("x");
    expect(result).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("survives a non-JSON body", async () => {
    const { users } = client([new Response("not json", { status: 200 }), json(404, {})]);
    await expect(users.findFixtureUser("x")).resolves.toEqual({ kind: "absent" });
  });
});

describe("DescopeTestUsers.createTestUser", () => {
  it("creates a passwordless test user with no mail, SMS or invite", async () => {
    const { users, calls } = client([json(200, { user: { userId: "U7" } })]);
    await expect(users.createTestUser("rtfx-cashier-007", "RT Fixture Cashier 007")).resolves.toEqual({
      kind: "created",
      userId: "U7",
    });
    expect(calls[0]?.url).toBe("https://api.descope.com/v1/mgmt/user/create/test");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      loginId: "rtfx-cashier-007",
      name: "RT Fixture Cashier 007",
      test: true,
      invite: false,
      sendMail: false,
      sendSMS: false,
    });
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("email");
  });

  it.each([
    [json(409, {}), "rejected"],
    [json(200, { user: {} }), "rejected"],
    [json(429, {}), "unavailable"],
    [new Error("down"), "unavailable"],
  ])("maps the answer to %#", async (answer, kind) => {
    const { users } = client([answer]);
    await expect(users.createTestUser("x", "n")).resolves.toEqual({ kind });
  });
});

describe("DescopeTestUsers construction", () => {
  it("requires a management key", () => {
    expect(() => new DescopeTestUsers({ projectId: PROJECT, managementKey: " ", fetch: jest.fn() })).toThrow(
      "a Descope management key is required",
    );
  });

  it("rejects a malformed project id", () => {
    expect(() => new DescopeTestUsers({ projectId: "bad id!", managementKey: KEY, fetch: jest.fn() })).toThrow();
  });
});
