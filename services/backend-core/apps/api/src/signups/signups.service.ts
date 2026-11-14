/**
 * SignupsService — RT-1350 slice 3: customer self-signup (design RT-1333 v6; contract
 * `signups.openapi.yaml`; fallback A: Backend-Core's own opaque, single-use, emailed token,
 * stored only as a SHA-256 hash in `pending_signups.token_hash`).
 *
 * requestSignup
 *   Refusals that do not depend on the address come first (terms version, human proof),
 *   then the 202 is decided. Everything address-dependent (limits, disposable list,
 *   account state, the pending row, the email) runs AFTER the 202 in tracked background
 *   work (the RT-1248 pattern), so the answer and its timing are the same for every
 *   address and a failure never reaches the caller.
 *
 * completeSignup
 *   token -> pending row -> (provider user, outside the DB) -> ONE transaction on the
 *   narrow `signup` privilege (RT-1389), pinned to the new tenant: lock the pending row,
 *   user + link, tenant + roles + owner membership + `restricted` entitlement (the 0111
 *   signup INSERT policy, pinned to the target tenant, RT-1353), consent record,
 *   completion, audit.
 *   A rollback leaves the row `pending`. The session is minted after the commit.
 *   A signup completes at most once; a replay is the generic invalid.
 *
 * Retention note: the idempotent state of a completed signup (tenant_id, completed_at)
 * lasts only until the purge job of a later slice removes the row (expiry plus 7 days).
 */
import type { OnModuleDestroy } from "@nestjs/common";

import { runWithSystemPrivilege, type SystemContext } from "@data-pulse-2/db";
import { createLogger, newId, type Logger } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import type { AuditJobEnqueuer } from "../audit/audit-job.enqueuer";
import type { ExternalCredentialPort } from "../auth/external-credential.port";
import { accountIdentifier, clientIpIdentifier } from "../auth/public-auth-keys";
import { checkWithin } from "../auth/public-auth-limiter";
import { RATE_LIMIT_BUCKETS, type RateLimiter } from "../auth/rate-limit";
import type { SessionStarter } from "../memberships/invitations.service";
import { isDisposableEmail } from "./disposable-domains";
import type { HumanProofVerifier } from "./human-proof.port";
import type { PreparedSignupLink, SignupLinkProvider } from "./signup-link.port";
import { provisionProviderUser } from "./signup-provisioning";
import { deriveSlug } from "./signup-slug";
import {
  readCurrentTermsVersion,
  SIGNUP_LINK_TTL_MS,
  SIGNUP_RECENT_COMPLETION_MS,
} from "./signup.config";
import type { SignupCompleteInput, SignupRequestInput } from "./signup.dto";
import type { PendingSignupRecord, SignupAuditRow, SignupUserRecord, SignupsStore } from "./signups.store";

export type TenantTxRunner = <T>(pool: Pool, ctx: SystemContext, work: (client: PoolClient) => Promise<T>) => Promise<T>;

type Env = Readonly<Record<string, string | undefined>>;

export interface SignupsServiceDeps {
  readonly pool: Pool;
  readonly store: SignupsStore;
  readonly humanProof: HumanProofVerifier;
  readonly limiter: RateLimiter;
  /** Issues and verifies the owner's email-proof link (fallback A: Backend-Core's own token). */
  readonly links: SignupLinkProvider;
  readonly audit: AuditJobEnqueuer;
  /** The identity provider; null when none is wired (a new owner then cannot be provisioned: 503). */
  readonly external: ExternalCredentialPort | null;
  readonly sessions: SessionStarter;
  /**
   * The state of the user's identity link at the configured provider, read on the AUTH
   * LOOKUP pool (the domain role cannot read `external_identity_links`). `disabled` means
   * the account was switched off: it must not get a link or a session. Default: `none`.
   */
  readonly linkState?: (userId: string) => Promise<LinkState>;
  readonly tx?: TenantTxRunner;
  readonly now?: () => Date;
  readonly env?: Env;
  /** Bound on each limiter call (RT-628). */
  readonly limiterTimeoutMs: number;
}

export interface RequestContext {
  /** The caller's address as the server sees it (or "unknown"). Hashed before storage; never logged. */
  readonly ip: string;
  readonly requestId: string | null;
}

export type LinkState = "none" | "active" | "disabled";

export type RequestOutcome = "accepted" | "invalid" | "unavailable";

export type CompleteResult =
  | {
      readonly kind: "created";
      readonly tenantId: string;
      readonly session: { readonly sessionId: string; readonly sessionCredential: string; readonly absoluteExpiresAt: Date };
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

/**
 * The narrow signup privilege with no tenant: reads and the pre-tenant pending-row writes.
 * RT-1389: never the platform-admin flag (migration 0111 grants this privilege only
 * pending_signups, user_consents and the new tenant's `restricted` entitlement row).
 */
const SIGNUP_CTX: SystemContext = { tenantId: null, privilege: "signup" };

let logger: Logger | null = null;
function log(): Logger {
  logger ??= createLogger({ service: "api.signups", level: process.env["LOG_LEVEL"] ?? "info" });
  return logger;
}

function sqlState(err: unknown): string | null {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

export class SignupsService implements OnModuleDestroy {
  private readonly tx: TenantTxRunner;
  private readonly now: () => Date;
  private readonly env: Env;
  private readonly pendingWork = new Set<Promise<void>>();

  constructor(private readonly deps: SignupsServiceDeps) {
    this.tx = deps.tx ?? runWithSystemPrivilege;
    this.now = deps.now ?? (() => new Date());
    this.env = deps.env ?? process.env;
  }

  // ===== requestSignup ==============================================

  async requestSignup(body: SignupRequestInput, ctx: RequestContext): Promise<RequestOutcome> {
    const currentTerms = readCurrentTermsVersion(this.env);
    if (currentTerms === null) {
      log().warn({ reason: "terms_version_unset" }, "self-signup is closed: SIGNUP_CURRENT_TERMS_VERSION is not set");
      return "unavailable";
    }
    if (body.termsVersion !== currentTerms) return "invalid";

    const proof = await this.deps.humanProof.verify({ token: body.humanProof, remoteIp: ctx.ip });
    if (proof.kind === "refused") return "invalid";
    if (proof.kind === "unavailable") return "unavailable";

    this.track(this.processRequest(body, ctx));
    return "accepted";
  }

  /** The address-dependent work, after the 202. Never throws; logs the error class only. */
  private async processRequest(body: SignupRequestInput, ctx: RequestContext): Promise<void> {
    try {
      if (!(await this.withinEmailBudget(body.email))) return;
      if (isDisposableEmail(body.email, this.env)) return;

      const issued = await this.recordPending(body, ctx);
      if (issued === null) return;

      await issued.link.deliver();
      this.fireAudit({
        actor_user_id: null,
        actor_label: null,
        tenant_id: null,
        store_id: null,
        action: "signup.requested",
        target_type: "pending_signup",
        target_id: issued.pendingId,
        request_id: ctx.requestId,
        metadata: { email_hash: accountIdentifier(body.email) },
      });
    } catch (err: unknown) {
      if (sqlState(err) === "23505") return; // a concurrent request holds the pending slot; its link is valid
      log().error({ error: err instanceof Error ? err.name : typeof err }, "signup request work failed after the 202; nothing sent");
    }
  }

  /** Per-address budget. Over it, or a limiter outage, is silent (the per-IP check already failed closed). */
  private async withinEmailBudget(email: string): Promise<boolean> {
    try {
      const decision = await checkWithin(
        this.deps.limiter,
        { bucketName: "signup_create_email", identifier: accountIdentifier(email), bucket: RATE_LIMIT_BUCKETS.signupCreatePerEmail },
        this.deps.limiterTimeoutMs,
      );
      return decision.allowed;
    } catch {
      log().warn({ bucket: "signup_create_email" }, "signup per-email limiter unavailable; nothing sent");
      return false;
    }
  }

  /**
   * One signup-privilege transaction: decide eligibility, supersede any older pending row
   * (stale or live: a fresh request replaces it, comment 16878) and insert the new one.
   * Returns null when the address is not eligible.
   */
  private async recordPending(
    body: SignupRequestInput,
    ctx: RequestContext,
  ): Promise<{ link: PreparedSignupLink; pendingId: string } | null> {
    const { store } = this.deps;
    const now = this.now();
    const link = this.deps.links.prepare({ email: body.email, locale: body.locale ?? null });
    const pendingId = newId();
    const eligible = await this.tx(this.deps.pool, SIGNUP_CTX, async (client) => {
      const user = await store.findUserByEmail(client, body.email);
      if (user !== null && (user.isPlatformAdmin || (await this.isBlocked(user)))) return false;
      const since = new Date(now.getTime() - SIGNUP_RECENT_COMPLETION_MS);
      if (await store.hasCompletedSignupSince(client, body.email, since)) return false;
      await store.expirePendingByEmail(client, body.email);
      await store.insertPending(client, {
        id: pendingId,
        emailNormalized: body.email,
        name: body.name,
        businessName: body.businessName,
        locale: body.locale ?? null,
        termsVersion: body.termsVersion,
        termsAcceptedAt: now,
        ipHash: clientIpIdentifier(ctx.ip),
        tokenHash: link.tokenHash,
        expiresAt: new Date(now.getTime() + SIGNUP_LINK_TTL_MS),
      });
      return true;
    });
    return eligible ? { link, pendingId } : null;
  }

  // ===== completeSignup =============================================

  async completeSignup(body: SignupCompleteInput, ctx: RequestContext): Promise<CompleteResult> {
    const found = await this.findCompletable(body.token);
    if (found.kind !== "found") return found;
    const { pending, user } = found;
    if (user !== null && (await this.refusesExistingUser(user, ctx))) return { kind: "invalid" };

    let providerSubject: string | null = null;
    if (user === null) {
      if (this.deps.external === null) return { kind: "unavailable" };
      const provisioned = await provisionProviderUser(this.deps.external, {
        email: pending.emailNormalized,
        name: pending.name,
        password: body.password,
      });
      if (provisioned.kind !== "ok") return { kind: provisioned.kind };
      providerSubject = provisioned.subject;
    }

    const tenantId = newId();
    const ownerUserId = user?.id ?? newId();
    let committed: boolean;
    try {
      committed = await this.tx(this.deps.pool, { tenantId, privilege: "signup" }, (client) =>
        this.writeSignup(client, { pending, tenantId, ownerUserId, existingUser: user !== null, providerSubject, requestId: ctx.requestId }),
      );
    } catch (err: unknown) {
      if (sqlState(err) === "23505") return { kind: "invalid" }; // a user or link appeared concurrently: retry converges
      throw err;
    }
    if (!committed) return { kind: "invalid" };

    try {
      return { kind: "created", tenantId, session: await this.deps.sessions.startSession(ownerUserId) };
    } catch (err: unknown) {
      // The tenant exists; the owner can sign in. Not an invalid token.
      log().error({ error: err instanceof Error ? err.name : typeof err }, "signup committed but the session could not be started");
      return { kind: "unavailable" };
    }
  }

  /** The live pending row of a presented token (and its existing user, if any), or why there is none. */
  private async findCompletable(
    token: string,
  ): Promise<
    | { kind: "found"; pending: PendingSignupRecord; user: SignupUserRecord | null }
    | { kind: "invalid" }
    | { kind: "unavailable" }
  > {
    const verified = await this.deps.links.verify(token);
    if (verified.kind === "unavailable") return { kind: "unavailable" };
    // Only a hash-keyed adapter (A) is supported today; an email-keyed provider adapter would add its own lookup.
    if (verified.kind === "refused" || verified.tokenHash === null) return { kind: "invalid" };
    const tokenHash = verified.tokenHash;
    const found = await this.tx(this.deps.pool, SIGNUP_CTX, async (client) => {
      const pending = await this.deps.store.findPendingByTokenHash(client, tokenHash);
      if (!this.isLivePending(pending)) return null;
      return { pending, user: await this.deps.store.findUserByEmail(client, pending.emailNormalized) };
    });
    return found === null ? { kind: "invalid" } : { kind: "found", ...found };
  }

  /**
   * True when an existing account must not complete a signup: a platform admin (a platform
   * account is never signed in by an email token; the refusal is audited) or a blocked user.
   */
  private async refusesExistingUser(user: SignupUserRecord, ctx: RequestContext): Promise<boolean> {
    if (user.isPlatformAdmin) {
      this.fireAudit({
        actor_user_id: user.id,
        actor_label: null,
        tenant_id: null,
        store_id: null,
        action: "signup.completion_refused",
        target_type: "user",
        target_id: user.id,
        request_id: ctx.requestId,
        metadata: { reason: "platform_admin" },
      });
      return true;
    }
    return await this.isBlocked(user);
  }

  /** Soft-deleted, or its identity link was disabled: the account cannot sign in, so no link and no session. */
  private async isBlocked(user: SignupUserRecord): Promise<boolean> {
    if (user.blocked) return true;
    return (await (this.deps.linkState?.(user.id) ?? "none")) === "disabled";
  }

  private isLivePending(pending: PendingSignupRecord | null): pending is PendingSignupRecord {
    return pending !== null && pending.status === "pending" && pending.expiresAt.getTime() > this.now().getTime();
  }

  /** The signup transaction body. Returns false (nothing written) when the row is no longer completable. */
  private async writeSignup(
    client: PoolClient,
    input: {
      pending: PendingSignupRecord;
      tenantId: string;
      ownerUserId: string;
      existingUser: boolean;
      providerSubject: string | null;
      requestId: string | null;
    },
  ): Promise<boolean> {
    const { store, external } = this.deps;
    const { pending, tenantId, ownerUserId, existingUser, providerSubject, requestId } = input;

    const locked = await store.lockPending(client, pending.id);
    if (!this.isLivePending(locked)) return false;

    if (existingUser) {
      // Re-read under the lock: the account must still be the same, active, non-platform user.
      const again = await store.findUserByEmail(client, pending.emailNormalized);
      if (again === null || again.id !== ownerUserId || again.isPlatformAdmin || (await this.isBlocked(again))) return false;
    } else if (external !== null && providerSubject !== null) {
      await store.insertUser(client, { id: ownerUserId, email: pending.emailNormalized, displayName: pending.name });
      await store.insertIdentityLink(client, {
        providerKey: external.identity.providerKey,
        issuer: external.identity.issuer,
        subject: providerSubject,
        userId: ownerUserId,
        email: pending.emailNormalized,
      });
    }

    await store.createRestrictedTenant(client, {
      tenantId,
      slug: deriveSlug(pending.businessName),
      name: pending.businessName,
      ownerUserId,
      membershipId: newId(),
    });
    await store.insertConsent(client, {
      userId: ownerUserId,
      termsVersion: pending.termsVersion,
      acceptedAt: pending.termsAcceptedAt,
      ipHash: pending.ipHash,
      pendingSignupId: pending.id,
    });
    await store.markCompleted(client, pending.id, tenantId);

    const audit = (row: Omit<SignupAuditRow, "requestId" | "actorUserId">): Promise<void> =>
      store.insertAudit(client, { ...row, actorUserId: ownerUserId, requestId });
    await audit({
      tenantId,
      action: "signup.completed",
      targetType: "pending_signup",
      targetId: pending.id,
      metadata: { existing_user: existingUser ? "true" : "false" },
    });
    await audit({ tenantId, action: "tenant.self_service_created", targetType: "tenant", targetId: tenantId, metadata: {} });
    if (existingUser) {
      // An existing account was signed in by an email proof: always audited (coordinator decision).
      await audit({ tenantId, action: "signup.existing_user_completed", targetType: "user", targetId: ownerUserId, metadata: {} });
    }
    return true;
  }

  // ===== background work ============================================

  /** Resolves once every request work item started so far has settled. Never rejects. */
  async settleWork(): Promise<void> {
    while (this.pendingWork.size > 0) await Promise.all(this.pendingWork);
  }

  /** Like `settleWork`, but gives up after `timeoutMs`; returns how many items were left. */
  async drainWork(timeoutMs: number): Promise<number> {
    const stop = new AbortController();
    const expired = new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, timeoutMs);
      handle.unref();
      stop.signal.addEventListener("abort", () => clearTimeout(handle));
    });
    const finished = await Promise.race([this.settleWork().then(() => true), expired.then(() => false)]);
    stop.abort();
    if (finished) return 0;
    const dropped = this.pendingWork.size;
    log().warn({ dropped, timeoutMs }, "signup request work still pending at shutdown; not waiting longer");
    return dropped;
  }

  /** Delay app close for in-flight request work, for at most 5 s (well under Docker's 10 s stop grace). */
  async onModuleDestroy(): Promise<void> {
    await this.drainWork(5_000);
  }

  private track(work: Promise<void>): void {
    this.pendingWork.add(work);
    void work.finally(() => this.pendingWork.delete(work));
  }

  private fireAudit(payload: Parameters<AuditJobEnqueuer["enqueue"]>[0]): void {
    this.deps.audit.enqueue(payload).catch(() => {
      // Best effort, like every audit emitted outside a transaction.
    });
  }
}
