/**
 * descope-auth.client.unit.spec.ts — RT-937 (RT-790 approach A).
 *
 * The server-side Descope REST client: password sign-in, password replace and
 * the three Management calls invite acceptance needs. Docker-free: `fetch` is
 * injected, so no request leaves the process.
 *
 * Properties pinned here:
 *   - the exact endpoint, Authorization header and JSON body of each call;
 *   - a redirect is refused (it would replay the password to another URL);
 *   - every failure maps to ONE small result kind, with no status, body or
 *     password in it (FR-ISO-4, PR-1);
 *   - Management calls fail closed (`unconfigured`) when the key is unset, and
 *     the key only ever travels in the Authorization header.
 */
import {
  DescopeAuthClient,
  type DescopeFetch,
} from "../../src/auth/descope-auth.client";

const PROJECT_ID = "P2abcdefghijklmnopqrstuvwxyz";
const MGMT_KEY = "K2-management-key-value";
const SECRET_PASSWORD = "Correct-Horse-Battery-9!";

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(
  respond: (call: Call) => Response | Promise<Response>,
  opts: { managementKey?: string | null } = {},
): { client: DescopeAuthClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: DescopeFetch = (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  const client = new DescopeAuthClient({
    projectId: PROJECT_ID,
    managementKey: opts.managementKey === undefined ? MGMT_KEY : opts.managementKey,
    fetch: fetchImpl,
  });
  return { client, calls };
}

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

describe("DescopeAuthClient.passwordSignIn", () => {
  it("posts the loginId and password with the project id as bearer, refusing redirects", async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse(200, { sessionJwt: "jwt-1", refreshJwt: "refresh-1", user: { userId: "U1" } }),
    );

    const result = await client.passwordSignIn("manager@tower.com", SECRET_PASSWORD);

    expect(result).toEqual({ kind: "ok", sessionJwt: "jwt-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.descope.com/v1/auth/password/signin");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(header(calls[0] as Call, "Authorization")).toBe(`Bearer ${PROJECT_ID}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      loginId: "manager@tower.com",
      password: SECRET_PASSWORD,
    });
  });

  it("never returns the refresh token or the user object", async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, { sessionJwt: "jwt-1", refreshJwt: "refresh-1", user: { userId: "U1" } }),
    );
    const result = await client.passwordSignIn("a@b.co", SECRET_PASSWORD);
    expect(JSON.stringify(result)).not.toContain("refresh-1");
    expect(JSON.stringify(result)).not.toContain("U1");
  });

  it.each([400, 401, 403, 404])("maps a %i answer to a generic refusal", async (status) => {
    const { client } = clientWith(() => jsonResponse(status, { errorCode: "E061102" }));
    expect(await client.passwordSignIn("a@b.co", SECRET_PASSWORD)).toEqual({ kind: "refused" });
  });

  it.each([429, 500, 502, 503])("maps a %i answer to unavailable, not to a refusal", async (status) => {
    const { client } = clientWith(() => jsonResponse(status, {}));
    expect(await client.passwordSignIn("a@b.co", SECRET_PASSWORD)).toEqual({ kind: "unavailable" });
  });

  it("treats a 200 without a usable session JWT as a refusal", async () => {
    const { client } = clientWith(() => jsonResponse(200, { sessionJwt: "" }));
    expect(await client.passwordSignIn("a@b.co", SECRET_PASSWORD)).toEqual({ kind: "refused" });
  });

  it("treats a malformed 200 body as a refusal", async () => {
    const { client } = clientWith(() => new Response("not json", { status: 200 }));
    expect(await client.passwordSignIn("a@b.co", SECRET_PASSWORD)).toEqual({ kind: "refused" });
  });

  it("maps a transport failure to unavailable without leaking the error", async () => {
    const { client } = clientWith(() => {
      throw Object.assign(new Error(`connect failed ${SECRET_PASSWORD}`), {
        cause: { body: SECRET_PASSWORD },
      });
    });
    const result = await client.passwordSignIn("a@b.co", SECRET_PASSWORD);
    expect(result).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(SECRET_PASSWORD);
  });
});

describe("DescopeAuthClient.replacePassword", () => {
  it("posts old and new password and revokes the user's other Descope sessions", async () => {
    const { client, calls } = clientWith(() => jsonResponse(200, { sessionJwt: "jwt-2" }));

    const result = await client.replacePassword("a@b.co", "Old-Password-1!", "New-Password-2!");

    expect(result).toEqual({ kind: "ok", sessionJwt: "jwt-2" });
    expect(calls[0]?.url).toBe("https://api.descope.com/v1/auth/password/replace");
    expect(header(calls[0] as Call, "Authorization")).toBe(`Bearer ${PROJECT_ID}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      loginId: "a@b.co",
      oldPassword: "Old-Password-1!",
      newPassword: "New-Password-2!",
      revokeOtherSessions: true,
    });
  });

  it("maps a 4xx answer to a refusal and a 5xx or 429 answer to unavailable", async () => {
    const refused = clientWith(() => jsonResponse(400, { errorCode: "E061101" }));
    expect(await refused.client.replacePassword("a@b.co", "x", "y")).toEqual({ kind: "refused" });
    const down = clientWith(() => jsonResponse(503, {}));
    expect(await down.client.replacePassword("a@b.co", "x", "y")).toEqual({ kind: "unavailable" });
    const limited = clientWith(() => jsonResponse(429, {}));
    expect(await limited.client.replacePassword("a@b.co", "x", "y")).toEqual({ kind: "unavailable" });
  });

  it("refuses a 200 with no session JWT", async () => {
    const { client } = clientWith(() => jsonResponse(200, {}));
    expect(await client.replacePassword("a@b.co", "x", "y")).toEqual({ kind: "refused" });
  });
});

describe("DescopeAuthClient management calls", () => {
  it("fail closed as unconfigured, with no request, when the management key is unset", async () => {
    for (const managementKey of [null, ""]) {
      const { client, calls } = clientWith(() => jsonResponse(200, {}), { managementKey });
      expect(await client.createUser({ loginId: "a@b.co", email: "a@b.co", name: "A" })).toEqual({
        kind: "unconfigured",
      });
      expect(await client.loadUser("a@b.co")).toEqual({ kind: "unconfigured" });
      expect(await client.setActivePassword("a@b.co", SECRET_PASSWORD)).toEqual({ kind: "unconfigured" });
      expect(calls).toHaveLength(0);
    }
  });

  it("createUser posts a verified-email user with projectId:key as bearer", async () => {
    const { client, calls } = clientWith(() => jsonResponse(200, { user: { userId: "U9" }, created: true }));

    const result = await client.createUser({ loginId: "new@b.co", email: "new@b.co", name: "New User" });

    expect(result).toEqual({ kind: "created", userId: "U9" });
    expect(calls[0]?.url).toBe("https://api.descope.com/v1/mgmt/user/create");
    expect(header(calls[0] as Call, "Authorization")).toBe(`Bearer ${PROJECT_ID}:${MGMT_KEY}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      loginId: "new@b.co",
      email: "new@b.co",
      verifiedEmail: true,
      name: "New User",
      sendMail: false,
      invite: false,
    });
  });

  it("createUser reports a 4xx as rejected (the caller then loads the user) and a 5xx as unavailable", async () => {
    const exists = clientWith(() => jsonResponse(409, { errorCode: "E062108" }));
    expect(await exists.client.createUser({ loginId: "a@b.co", email: "a@b.co", name: "A" })).toEqual({
      kind: "rejected",
    });
    const down = clientWith(() => jsonResponse(500, {}));
    expect(await down.client.createUser({ loginId: "a@b.co", email: "a@b.co", name: "A" })).toEqual({
      kind: "unavailable",
    });
  });

  it("createUser treats a 200 without a user id as rejected", async () => {
    const { client } = clientWith(() => jsonResponse(200, { user: {} }));
    expect(await client.createUser({ loginId: "a@b.co", email: "a@b.co", name: "A" })).toEqual({
      kind: "rejected",
    });
  });

  it("loadUser GETs by encoded loginId and reports id and whether a password is set", async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse(200, { user: { userId: "U7", password: false, verifiedEmail: true } }),
    );

    const result = await client.loadUser("a+b@c.co");

    expect(result).toEqual({ kind: "found", userId: "U7", passwordSet: false });
    expect(calls[0]?.url).toBe("https://api.descope.com/v1/mgmt/user?loginId=a%2Bb%40c.co");
    expect(calls[0]?.init.method).toBe("GET");
    expect(header(calls[0] as Call, "Authorization")).toBe(`Bearer ${PROJECT_ID}:${MGMT_KEY}`);
  });

  it("loadUser reports not_found for 400/404, and unavailable for auth, rate-limit and server failures", async () => {
    for (const status of [400, 404]) {
      const { client } = clientWith(() => jsonResponse(status, {}));
      expect(await client.loadUser("a@b.co")).toEqual({ kind: "not_found" });
    }
    for (const status of [401, 403, 429, 500]) {
      const { client } = clientWith(() => jsonResponse(status, {}));
      expect(await client.loadUser("a@b.co")).toEqual({ kind: "unavailable" });
    }
  });

  it("setActivePassword posts the password to the active-password endpoint", async () => {
    const { client, calls } = clientWith(() => jsonResponse(200, {}));

    expect(await client.setActivePassword("a@b.co", SECRET_PASSWORD)).toEqual({ kind: "ok" });
    expect(calls[0]?.url).toBe("https://api.descope.com/v1/mgmt/user/password/set/active");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ loginId: "a@b.co", password: SECRET_PASSWORD });
  });

  it("setActivePassword reports a policy refusal as rejected and an outage as unavailable", async () => {
    const policy = clientWith(() => jsonResponse(400, { errorCode: "E061102" }));
    expect(await policy.client.setActivePassword("a@b.co", "short")).toEqual({ kind: "rejected" });
    const down = clientWith(() => jsonResponse(503, {}));
    expect(await down.client.setActivePassword("a@b.co", SECRET_PASSWORD)).toEqual({ kind: "unavailable" });
  });

  it("never puts the management key or a password in any result", async () => {
    const { client } = clientWith(() => jsonResponse(200, { user: { userId: "U9" }, created: true }));
    const results = [
      await client.createUser({ loginId: "a@b.co", email: "a@b.co", name: "A" }),
      await client.setActivePassword("a@b.co", SECRET_PASSWORD),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain(MGMT_KEY);
    expect(text).not.toContain(SECRET_PASSWORD);
  });
});

describe("DescopeAuthClient.identity", () => {
  it("names the provider key and the canonical issuer that links to its users must carry", () => {
    const { client } = clientWith(() => jsonResponse(200, {}));
    expect(client.identity).toEqual({
      providerKey: "descope",
      issuer: `https://api.descope.com/v1/apps/${PROJECT_ID}`,
    });
  });
});

describe("DescopeAuthClient construction", () => {
  it("rejects a malformed project id at construction", () => {
    expect(
      () =>
        new DescopeAuthClient({
          projectId: "not a project id!",
          managementKey: null,
          fetch: () => Promise.resolve(jsonResponse(200, {})),
        }),
    ).toThrow(/DESCOPE_PROJECT_ID/);
  });
});
