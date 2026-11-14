/**
 * Shared fakes for the signup service unit specs (RT-1350 slice 3). Not a spec file.
 */
import type { Pool, PoolClient } from "pg";

import type { AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";
import type { SignupLinkEmailJob } from "../../src/auth/email-job.enqueuer";
import type {
  CreateUserResult,
  ExternalCredentialPort,
  LoadUserResult,
  SetPasswordResult,
} from "../../src/auth/external-credential.port";
import type { RateLimitDecision, RateLimiter } from "../../src/auth/rate-limit";
import type { HumanProofInput, HumanProofResult, HumanProofVerifier } from "../../src/signups/human-proof.port";
import { OwnTokenSignupLinkProvider } from "../../src/signups/own-token-signup-link.provider";
import { SignupsService, type LinkState, type SignupsServiceDeps } from "../../src/signups/signups.service";
import type {
  NewPendingSignup,
  PendingSignupRecord,
  RestrictedTenantInput,
  SignupAuditRow,
  SignupUserRecord,
  SignupsStore,
} from "../../src/signups/signups.store";

export const REQUEST = {
  email: "owner@example.com",
  name: "Mona Hassan",
  businessName: "Hassan Market",
  locale: "ar" as const,
  termsVersion: "2026-11",
  termsAccepted: true as const,
  humanProof: "turnstile-token",
};

export const CTX = { ip: "203.0.113.9", requestId: null as string | null };

export const NOW = new Date("2026-11-13T12:00:00.000Z");

const FAKE_CLIENT = { fake: true } as unknown as PoolClient;

export class FakeHumanProof implements HumanProofVerifier {
  next: HumanProofResult = { kind: "ok" };
  calls: HumanProofInput[] = [];
  verify(input: HumanProofInput): Promise<HumanProofResult> {
    this.calls.push(input);
    return Promise.resolve(this.next);
  }
}

export class FakeLimiter {
  blocked = new Set<string>();
  broken = false;
  buckets: string[] = [];
  check(bucketName: string): Promise<RateLimitDecision> {
    this.buckets.push(bucketName);
    if (this.broken) return Promise.reject(new Error("redis down"));
    const allowed = !this.blocked.has(bucketName);
    return Promise.resolve({ allowed, count: allowed ? 1 : 99, remaining: allowed ? 1 : 0, resetMs: 60_000 });
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
}

export class FakeEmails {
  sent: SignupLinkEmailJob[] = [];
  fail = false;
  enqueueSignupLink(job: SignupLinkEmailJob): Promise<void> {
    if (this.fail) return Promise.reject(new Error("queue down"));
    this.sent.push(job);
    return Promise.resolve();
  }
}

export class FakeAudit implements AuditJobEnqueuer {
  events: AuditJobPayload[] = [];
  enqueue(payload: AuditJobPayload): Promise<void> {
    this.events.push(payload);
    return Promise.resolve();
  }
}

export class FakeSessions {
  started: string[] = [];
  fail = false;
  startSession(userId: string) {
    if (this.fail) return Promise.reject(new Error("session store down"));
    this.started.push(userId);
    return Promise.resolve({ sessionId: "sess-1", sessionCredential: "cookie-1", absoluteExpiresAt: new Date(NOW.getTime() + 1000) });
  }
}

export class FakeExternal {
  identity = { providerKey: "descope", issuer: "https://api.descope.test/P1" };
  create: CreateUserResult = { kind: "created", userId: "prov-1" };
  load: LoadUserResult = { kind: "not_found" };
  setPassword: SetPasswordResult = { kind: "ok" };
  calls: string[] = [];
  passwordsSet: string[] = [];
  createUser(input: { loginId: string; email: string; name: string }): Promise<CreateUserResult> {
    this.calls.push(`createUser:${input.loginId}`);
    return Promise.resolve(this.create);
  }
  loadUser(loginId: string): Promise<LoadUserResult> {
    this.calls.push(`loadUser:${loginId}`);
    return Promise.resolve(this.load);
  }
  setActivePassword(loginId: string, password: string): Promise<SetPasswordResult> {
    this.calls.push(`setActivePassword:${loginId}`);
    this.passwordsSet.push(password);
    return Promise.resolve(this.setPassword);
  }
}

/** In-memory SignupsStore: records every call in order; behaviour is set by the fields. */
export class FakeStore implements SignupsStore {
  calls: string[] = [];
  user: SignupUserRecord | null = null;
  existingPending = false;
  recentCompletion = false;
  recentCompletionSince: Date | null = null;
  inserted: NewPendingSignup[] = [];
  insertError: Error | null = null;
  gate: Promise<void> | null = null;
  /** Complete flow. */
  pendingByTokenHash = new Map<string, PendingSignupRecord>();
  lockStatus: PendingSignupRecord["status"] | "missing" | null = null;
  users: { id: string; email: string; displayName: string }[] = [];
  links: { subject: string; userId: string }[] = [];
  tenants: RestrictedTenantInput[] = [];
  consents: { userId: string; termsVersion: string; pendingSignupId: string }[] = [];
  completed: { id: string; tenantId: string }[] = [];
  audits: SignupAuditRow[] = [];
  tenantError: Error | null = null;

  async findUserByEmail(): Promise<SignupUserRecord | null> {
    this.calls.push("findUserByEmail");
    if (this.gate) await this.gate;
    return this.user;
  }
  hasCompletedSignupSince(_c: PoolClient, _e: string, since: Date): Promise<boolean> {
    this.calls.push("hasCompletedSignupSince");
    this.recentCompletionSince = since;
    return Promise.resolve(this.recentCompletion);
  }
  expirePendingByEmail(): Promise<void> {
    this.calls.push("expirePendingByEmail");
    return Promise.resolve();
  }
  insertPending(_c: PoolClient, row: NewPendingSignup): Promise<void> {
    this.calls.push("insertPending");
    if (this.insertError) return Promise.reject(this.insertError);
    this.inserted.push(row);
    return Promise.resolve();
  }
  findPendingByTokenHash(_c: PoolClient, tokenHash: string): Promise<PendingSignupRecord | null> {
    this.calls.push("findPendingByTokenHash");
    return Promise.resolve(this.pendingByTokenHash.get(tokenHash) ?? null);
  }
  lockPending(_c: PoolClient, id: string): Promise<PendingSignupRecord | null> {
    this.calls.push("lockPending");
    if (this.lockStatus === "missing") return Promise.resolve(null);
    const found = [...this.pendingByTokenHash.values()].find((p) => p.id === id) ?? null;
    if (found && this.lockStatus) return Promise.resolve({ ...found, status: this.lockStatus });
    return Promise.resolve(found);
  }
  insertUser(_c: PoolClient, row: { id: string; email: string; displayName: string }): Promise<void> {
    this.calls.push("insertUser");
    this.users.push(row);
    return Promise.resolve();
  }
  insertIdentityLink(_c: PoolClient, row: { subject: string; userId: string }): Promise<void> {
    this.calls.push("insertIdentityLink");
    this.links.push(row);
    return Promise.resolve();
  }
  createRestrictedTenant(_c: PoolClient, input: RestrictedTenantInput): Promise<void> {
    this.calls.push("createRestrictedTenant");
    if (this.tenantError) return Promise.reject(this.tenantError);
    this.tenants.push(input);
    return Promise.resolve();
  }
  insertConsent(_c: PoolClient, row: { userId: string; termsVersion: string; pendingSignupId: string }): Promise<void> {
    this.calls.push("insertConsent");
    this.consents.push(row);
    return Promise.resolve();
  }
  markCompleted(_c: PoolClient, id: string, tenantId: string): Promise<void> {
    this.calls.push("markCompleted");
    this.completed.push({ id, tenantId });
    for (const [hash, rec] of this.pendingByTokenHash) {
      if (rec.id === id) this.pendingByTokenHash.set(hash, { ...rec, status: "completed" });
    }
    return Promise.resolve();
  }
  insertAudit(_c: PoolClient, row: SignupAuditRow): Promise<void> {
    this.calls.push(`insertAudit:${row.action}`);
    this.audits.push(row);
    return Promise.resolve();
  }
}

export interface Harness {
  readonly service: SignupsService;
  readonly store: FakeStore;
  readonly humanProof: FakeHumanProof;
  readonly limiter: FakeLimiter;
  readonly emails: FakeEmails;
  readonly audit: FakeAudit;
  readonly sessions: FakeSessions;
  readonly external: FakeExternal;
  readonly txContexts: { tenantId: string | null; privilege: string }[];
  readonly clock: { now: () => Date };
}

export function makeService(
  opts: {
    env?: Record<string, string | undefined>;
    external?: FakeExternal | null;
    linkState?: (userId: string) => Promise<LinkState>;
  } = {},
): Harness {
  const store = new FakeStore();
  const humanProof = new FakeHumanProof();
  const limiter = new FakeLimiter();
  const emails = new FakeEmails();
  const audit = new FakeAudit();
  const sessions = new FakeSessions();
  const external = opts.external === undefined ? new FakeExternal() : opts.external;
  const txContexts: Harness["txContexts"] = [];
  const clock = { now: () => NOW };
  const deps: SignupsServiceDeps = {
    pool: {} as Pool,
    store,
    humanProof,
    limiter: limiter as unknown as RateLimiter,
    links: new OwnTokenSignupLinkProvider(emails),
    audit,
    external: external as unknown as ExternalCredentialPort | null,
    sessions,
    ...(opts.linkState ? { linkState: opts.linkState } : {}),
    tx: async (_pool, ctx, work) => {
      txContexts.push({ ...ctx });
      return work(FAKE_CLIENT);
    },
    now: clock.now,
    env: opts.env ?? { SIGNUP_CURRENT_TERMS_VERSION: "2026-11" },
    limiterTimeoutMs: 50,
  };
  return { service: new SignupsService(deps), store, humanProof, limiter, emails, audit, sessions, external: external ?? new FakeExternal(), txContexts, clock };
}
