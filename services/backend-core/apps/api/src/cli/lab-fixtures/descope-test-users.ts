/**
 * CLI-only Descope Test User adapter — RT-1309.
 *
 * Deliberately NOT part of `ExternalCredentialPort`: no HTTP path in the API
 * can reach test-user provisioning. Calls (Bearer <projectId>:<managementKey>):
 *   - `POST /v2/mgmt/user/search/test` — the proof of `test=true` (it returns
 *     test users only, and each returned user must also say `test: true`);
 *   - `GET  /v1/mgmt/user?loginId=`    — distinguishes "absent" from "exists
 *     but is NOT a test user" (which the provisioner refuses);
 *   - `POST /v1/mgmt/user/create/test` — passwordless, no mail, no invite.
 *
 * No retries: a 429 or 5xx is `unavailable` and the run stops; re-running is
 * safe because provisioning is idempotent. The management key never appears
 * in a result, a thrown error or output.
 */
import { assertProjectId, DESCOPE_API_BASE } from "../../pos-operators/descope-verifier";
import type { FixtureCreate, FixtureIdentityProvider, FixtureLookup } from "./provider-port";

export type DescopeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DescopeTestUsersOptions {
  readonly projectId: string;
  readonly managementKey: string;
  readonly fetch: DescopeFetch;
  readonly timeoutMs?: number;
}

type Sent = { readonly kind: "response"; readonly res: Response } | { readonly kind: "failed" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function userIdOf(value: unknown): string | null {
  const id = asRecord(value)?.["userId"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isTransient(status: number): boolean {
  return status === 429 || status >= 500 || status === 401 || status === 403;
}

export class DescopeTestUsers implements FixtureIdentityProvider {
  private readonly bearer: string;
  private readonly fetchImpl: DescopeFetch;
  private readonly timeoutMs: number;

  constructor(options: DescopeTestUsersOptions) {
    const key = options.managementKey.trim();
    if (key === "") throw new Error("a Descope management key is required");
    this.bearer = `${assertProjectId(options.projectId)}:${key}`;
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async findFixtureUser(loginId: string): Promise<FixtureLookup> {
    const search = await this.send("POST", "/v2/mgmt/user/search/test", {
      loginIds: [loginId],
      testUsersOnly: true,
      limit: 2,
    });
    if (search.kind === "failed" || isTransient(search.res.status)) return { kind: "unavailable" };
    if (!search.res.ok) return { kind: "unavailable" };
    const users = asRecord(await readJson(search.res))?.["users"];
    const list = Array.isArray(users) ? users : [];
    if (list.length > 1) return { kind: "ambiguous" };
    if (list.length === 1) {
      const userId = userIdOf(list[0]);
      if (userId === null || asRecord(list[0])?.["test"] !== true) return { kind: "ambiguous" };
      return { kind: "test_user", userId };
    }
    return this.lookupNonTest(loginId);
  }

  async createTestUser(loginId: string, email: string, name: string): Promise<FixtureCreate> {
    const sent = await this.send("POST", "/v1/mgmt/user/create/test", {
      loginId,
      // Descope refuses a create with neither email nor phone (E011002), test user or not.
      email,
      name,
      test: true,
      invite: false,
      sendMail: false,
      sendSMS: false,
    });
    if (sent.kind === "failed" || isTransient(sent.res.status)) return { kind: "unavailable" };
    const json = await readJson(sent.res);
    if (!sent.res.ok) return rejected(json);
    const userId = userIdOf(asRecord(json)?.["user"]);
    return userId === null ? { kind: "rejected" } : { kind: "created", userId };
  }

  /** No test user matched: is there a NON-test user holding the loginId? */
  private async lookupNonTest(loginId: string): Promise<FixtureLookup> {
    const sent = await this.send("GET", `/v1/mgmt/user?loginId=${encodeURIComponent(loginId)}`, undefined);
    if (sent.kind === "failed" || isTransient(sent.res.status)) return { kind: "unavailable" };
    if (!sent.res.ok) return { kind: "absent" };
    const user = asRecord(asRecord(await readJson(sent.res))?.["user"]);
    return userIdOf(user) === null ? { kind: "absent" } : { kind: "not_test_user" };
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<Sent> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.bearer}` };
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    // A rejection's cause can hold the request (and its Authorization header): drop it.
    return this.fetchImpl(`${DESCOPE_API_BASE}${path}`, init).then(
      (res): Sent => ({ kind: "response", res }),
      (): Sent => ({ kind: "failed" }),
    );
  }
}

/** A rejection carries only a well-formed provider error code (`E` + 6 digits), never a message or body. */
function rejected(json: unknown): FixtureCreate {
  const code = asRecord(json)?.["errorCode"];
  return typeof code === "string" && /^E\d{6}$/.test(code) ? { kind: "rejected", code } : { kind: "rejected" };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}
