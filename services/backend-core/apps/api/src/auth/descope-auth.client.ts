/**
 * descope-auth.client.ts — RT-937 (RT-790 approach A, owner decision D-A).
 *
 * The server-side Descope REST client Backend-Core uses to verify an Admin
 * password, replace it, and provision an invited user. The password never
 * reaches a browser SDK: the Admin Console keeps posting to Backend-Core,
 * which calls Descope from here and then mints its own native session.
 *
 * Calls (`https://api.descope.com`, US default region):
 *   - `POST /v1/auth/password/signin`     Bearer <projectId>
 *   - `POST /v1/auth/password/replace`    Bearer <projectId>
 *   - `POST /v1/mgmt/user/create`         Bearer <projectId>:<managementKey>
 *   - `GET  /v1/mgmt/user?loginId=`       Bearer <projectId>:<managementKey>
 *   - `POST /v1/mgmt/user/password/set/active` Bearer <projectId>:<managementKey>
 *
 * Posture (mirrors the verifier and the POS exchanger):
 *   - every outcome is ONE small result kind. No HTTP status, response body,
 *     Descope error code or user object is returned, so nothing here can leak
 *     through a caller's response or log (FR-ISO-4);
 *   - the password and the management key are only ever written into one
 *     request; they are never logged and never part of a returned value or a
 *     thrown error (a transport error's `cause` can hold the request, so it is
 *     dropped);
 *   - a redirect is refused (`redirect: "error"`): following one would replay
 *     the password body to another URL;
 *   - a session JWT returned here is NOT trusted by this client. The caller
 *     verifies it with `DescopeJwksVerifier` and compares `sub` to the link's
 *     subject, so a Descope answer alone never authenticates anyone;
 *   - 429 and 5xx are `unavailable` (an outage is not a wrong password), and a
 *     Management call with no key is `unconfigured` (fail closed, no request).
 *
 * Needs verification on the lab (RT-793): Descope's exact error codes for
 * "loginId already exists", "user not found" and "password policy refused" are
 * not documented in the REST reference this was written from, so the client
 * relies on HTTP status classes only and the invite flow converges through
 * `loadUser` instead of reading an error code.
 */
import {
  assertProjectId,
  configuredDescopeIssuer,
  DESCOPE_API_BASE,
  DESCOPE_PROVIDER_KEY,
} from "../pos-operators/descope-verifier";
import type {
  CreateUserInput,
  CreateUserResult,
  ExternalCredentialPort,
  LoadUserResult,
  PasswordSignInResult,
  ReplacePasswordResult,
  SetPasswordResult,
} from "./external-credential.port";

export type DescopeFetch = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;

export interface DescopeAuthClientOptions {
  readonly projectId: string;
  /** `DESCOPE_MANAGEMENT_KEY`; null or empty leaves every Management call `unconfigured`. */
  readonly managementKey: string | null;
  readonly fetch: DescopeFetch;
  readonly timeoutMs?: number;
}

/** The value as a plain property bag, or null for a non-object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 429 and 5xx mean "try later", not "your input was wrong". */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

type Transport = { readonly kind: "response"; readonly res: Response } | { readonly kind: "failed" };

export class DescopeAuthClient implements ExternalCredentialPort {
  readonly identity: { readonly providerKey: string; readonly issuer: string };
  private readonly projectId: string;
  private readonly managementKey: string | null;
  private readonly fetchImpl: DescopeFetch;
  private readonly timeoutMs: number;

  constructor(options: DescopeAuthClientOptions) {
    this.projectId = assertProjectId(options.projectId);
    this.identity = {
      providerKey: DESCOPE_PROVIDER_KEY,
      issuer: configuredDescopeIssuer(this.projectId),
    };
    const key = (options.managementKey ?? "").trim();
    this.managementKey = key === "" ? null : key;
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async passwordSignIn(loginId: string, password: string): Promise<PasswordSignInResult> {
    return this.sessionCall("/v1/auth/password/signin", { loginId, password });
  }

  async replacePassword(
    loginId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<ReplacePasswordResult> {
    return this.sessionCall("/v1/auth/password/replace", {
      loginId,
      oldPassword,
      newPassword,
      revokeOtherSessions: true,
    });
  }

  async createUser(input: CreateUserInput): Promise<CreateUserResult> {
    if (this.managementKey === null) return { kind: "unconfigured" };
    const sent = await this.send("POST", "/v1/mgmt/user/create", this.managementBearer(this.managementKey), {
      loginId: input.loginId,
      email: input.email,
      verifiedEmail: true,
      name: input.name,
      // Invite acceptance is the email proof; Descope sends no mail of its own here.
      sendMail: false,
      invite: false,
    });
    if (sent.kind === "failed") return { kind: "unavailable" };
    if (isTransientStatus(sent.res.status)) return { kind: "unavailable" };
    if (!sent.res.ok) return { kind: "rejected" };
    const userId = nonEmptyString(asRecord(asRecord(await this.readJson(sent.res))?.["user"])?.["userId"]);
    return userId === null ? { kind: "rejected" } : { kind: "created", userId };
  }

  async loadUser(loginId: string): Promise<LoadUserResult> {
    if (this.managementKey === null) return { kind: "unconfigured" };
    const path = `/v1/mgmt/user?loginId=${encodeURIComponent(loginId)}`;
    const sent = await this.send("GET", path, this.managementBearer(this.managementKey), undefined);
    if (sent.kind === "failed") return { kind: "unavailable" };
    const { status } = sent.res;
    // 401/403 here is a bad management key: a deployment fault, so fail closed as an outage.
    if (isTransientStatus(status) || status === 401 || status === 403) return { kind: "unavailable" };
    if (!sent.res.ok) return { kind: "not_found" };
    const user = asRecord(asRecord(await this.readJson(sent.res))?.["user"]);
    const userId = nonEmptyString(user?.["userId"]);
    if (userId === null) return { kind: "not_found" };
    return { kind: "found", userId, passwordSet: user?.["password"] === true };
  }

  async setActivePassword(loginId: string, password: string): Promise<SetPasswordResult> {
    if (this.managementKey === null) return { kind: "unconfigured" };
    const sent = await this.send(
      "POST",
      "/v1/mgmt/user/password/set/active",
      this.managementBearer(this.managementKey),
      { loginId, password },
    );
    if (sent.kind === "failed" || isTransientStatus(sent.res.status)) return { kind: "unavailable" };
    return sent.res.ok ? { kind: "ok" } : { kind: "rejected" };
  }

  // -------------------------------------------------------------------------

  private managementBearer(key: string): string {
    return `${this.projectId}:${key}`;
  }

  /** The shared shape of sign-in and replace: a 200 carrying a non-empty `sessionJwt`. */
  private async sessionCall(path: string, body: Record<string, unknown>): Promise<PasswordSignInResult> {
    const sent = await this.send("POST", path, this.projectId, body);
    if (sent.kind === "failed" || isTransientStatus(sent.res.status)) return { kind: "unavailable" };
    if (!sent.res.ok) return { kind: "refused" };
    const sessionJwt = nonEmptyString(asRecord(await this.readJson(sent.res))?.["sessionJwt"]);
    return sessionJwt === null ? { kind: "refused" } : { kind: "ok", sessionJwt };
  }

  /** One request. A transport error's `cause` can carry the request body, so it is dropped. */
  private async send(
    method: "GET" | "POST",
    path: string,
    bearer: string,
    body: Record<string, unknown> | undefined,
  ): Promise<Transport> {
    try {
      const res = await this.fetchImpl(`${DESCOPE_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { kind: "response", res };
    } catch {
      return { kind: "failed" };
    }
  }

  private async readJson(res: Response): Promise<unknown> {
    try {
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  }
}

/**
 * Production factory: `DESCOPE_PROJECT_ID` (required) and `DESCOPE_MANAGEMENT_KEY`
 * (optional, env only) from the environment, with the global `fetch`.
 *
 * With no project id, a non-production boot gets a client whose password calls
 * all report `unavailable` and whose Management calls are `unconfigured`;
 * production already refuses to boot without it (the verifier factory).
 */
/** Placeholder issuer for a non-production boot without DESCOPE_PROJECT_ID (every call is refused). */
const UNCONFIGURED_ISSUER = `${DESCOPE_API_BASE}/unconfigured`;

export function descopeAuthFactory(): ExternalCredentialPort {
  const projectId = (process.env["DESCOPE_PROJECT_ID"] ?? "").trim();
  if (projectId === "") {
    const unavailable = (): Promise<{ kind: "unavailable" }> => Promise.resolve({ kind: "unavailable" });
    const unconfigured = (): Promise<{ kind: "unconfigured" }> => Promise.resolve({ kind: "unconfigured" });
    return {
      identity: { providerKey: DESCOPE_PROVIDER_KEY, issuer: UNCONFIGURED_ISSUER },
      passwordSignIn: unavailable,
      replacePassword: unavailable,
      createUser: unconfigured,
      loadUser: unconfigured,
      setActivePassword: unconfigured,
    };
  }
  return new DescopeAuthClient({
    projectId,
    managementKey: process.env["DESCOPE_MANAGEMENT_KEY"] ?? null,
    fetch: (input, init) => fetch(input, init),
  });
}
