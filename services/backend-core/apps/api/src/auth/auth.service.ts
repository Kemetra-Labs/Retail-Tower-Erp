/**
 * AuthService — covers slice 3a (sign-in) plus the slice-3c surface
 * needed by AuthController (sign-out, refresh, password reset, email
 * verification). The controller is intentionally thin and delegates
 * every domain decision here.
 *
 * Cross-cutting rules:
 *   - FR-ISO-4: every sign-in failure path throws the SAME
 *     UnauthorizedException; we never leak whether an email exists,
 *     whether the password was wrong, or whether the user is SSO-only /
 *     soft-deleted. The global exception filter renders a 401 envelope.
 *   - Password-reset request always reports success to the controller
 *     (controller returns 202 unconditionally). Whether or not a token
 *     was actually issued is internal.
 *   - Token store: password-reset and email-verify reuse the existing
 *     `auth_tokens` table by adding two new `scope` values
 *     (`password_reset`, `email_verify`). No schema change.
 *   - Real email delivery is out of scope. The service calls an injected
 *     `EmailJobEnqueuer`; the default is `NoOpEmailJobEnqueuer`. T113
 *     swaps in the real BullMQ producer.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createLogger, newId, type Logger } from "@data-pulse-2/shared";
import {
  generateRawToken,
  hashPassword,
  hashToken,
  needsRehash,
  verifyPassword,
} from "@data-pulse-2/auth";
import { sessions, users } from "@data-pulse-2/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { SignInInput, SignInResult } from "./dto";
import type { SignInMembershipsReader } from "./signin-memberships";
import { SessionRepository } from "./session.repository";
import { AuthTokenRepository } from "./auth-token.repository";
import {
  type EmailJobEnqueuer,
  NoOpEmailJobEnqueuer,
} from "./email-job.enqueuer";
import {
  type AuditJobEnqueuer,
  NoOpAuditJobEnqueuer,
} from "../audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../audit/audit-job.types";
import { recordAuthFailure } from "../observability/metrics/api.metrics";
import { recordProviderSignOutFailure } from "../observability/metrics/auth-provider-signout.metrics";
import type { ExternalCredentialPort, LogoutAllResult } from "./external-credential.port";
import type { OperatorTokenVerifier } from "./operator-token-verifier";

/**
 * RT-1327: a provider-reset step that did not succeed. An outage is a 503 (the
 * contract's confirm route declares it), a refusal the generic invalid-token 400.
 */
function providerResetFailure(kind: "refused" | "unavailable"): BadRequestException | ServiceUnavailableException {
  return kind === "unavailable"
    ? new ServiceUnavailableException("Identity provider unavailable")
    : new BadRequestException(INVALID_RESET_TOKEN);
}

let serviceLogger: Logger | null = null;
function log(): Logger {
  serviceLogger ??= createLogger({ service: "api.auth", level: process.env["LOG_LEVEL"] ?? "info" });
  return serviceLogger;
}

/**
 * Pre-computed argon2id PHC string used for the constant-time path when
 * the email isn't found. The actual password value is irrelevant — we
 * only need a real PHC string so `verifyPassword` runs the full work,
 * keeping per-request latency consistent regardless of whether the user
 * exists. The string was generated once with the OWASP 2025 params.
 */
const DUMMY_PHC =
  "$argon2id$v=19$m=19456,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU";

/** One message for a wrong current password, a rejected new password and an unverifiable provider answer. */
const PASSWORD_CHANGE_REFUSED = "The password could not be changed";

/** One message for an unknown, used, expired or wrong-scope reset token, and for a linked user's token (RT-1262). */
const INVALID_RESET_TOKEN = "Invalid or expired token";

const SESSION_ABSOLUTE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h, per data-model §9.
const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000; // 15 min — research.md §PQ-4.
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h.

/**
 * Auth-token scope strings used by slice 3c. The `auth_tokens.scope`
 * column is plain text (no schema migration), and pre-existing slice-3a
 * scopes (`dashboard_api`, `pos`) coexist with these.
 */
export const AUTH_TOKEN_SCOPES = {
  passwordReset: "password_reset",
  emailVerify: "email_verify",
} as const;

/**
 * Slice 3b's RateLimiter is enforced by the controller (per-account /
 * per-IP), not by this service — the interface here remains so future
 * call sites can opt in for service-internal limits if ever needed.
 */
export interface RateLimiter {
  checkAndConsume(key: string): Promise<{ allowed: boolean }>;
}

class NoOpRateLimiter implements RateLimiter {
  checkAndConsume(_key: string): Promise<{ allowed: boolean }> {
    return Promise.resolve({ allowed: true });
  }
}

export interface AuthServiceOptions {
  rateLimiter?: RateLimiter;
  /**
   * Enqueuer for `auth.signin.{ok|failed}` audit events (T238).
   *
   * Optional so the slice-3a `auth.service.spec.ts` (sign-in only) can keep
   * its two-arg `new AuthService(pool, sessions)` construction. When omitted,
   * a `NoOpAuditJobEnqueuer` is used and no audit jobs are produced — the
   * sign-in success/failure semantics are unchanged.
   *
   * Wired in production via `AuthModule` from `AuditEnqueuerModule` (a leaf
   * module also imported by `AuditModule`, breaking what would otherwise be
   * a `AuthModule ↔ AuditModule` cycle).
   */
  auditEnqueuer?: AuditJobEnqueuer;
  /**
   * Lists the signing-in user's memberships for the sign-in response
   * (RT-343). `AuthModule` always wires the domain-pool reader
   * (`signInMembershipsReader`); omitted only by unit specs, where sign-in
   * then reports no memberships.
   */
  listMemberships?: SignInMembershipsReader;
  /**
   * RT-414: ends (and audits, `signed_out`) the live support sessions of a
   * revoked auth session, or of every session of a user. `AuthModule` wires
   * it on the domain pool; omitted only by unit specs.
   */
  endSupportSessions?: (
    owner: { readonly authSessionId: string } | { readonly userId: string },
    requestId: string | null,
  ) => Promise<void>;
  /**
   * RT-937 (owner decision D-A): a user with an ACTIVE external identity link
   * signs in with the password held by the external provider, verified here on
   * the server. `AuthModule` wires it; omitted by unit specs that cover only the
   * native path, where every user signs in natively.
   */
  externalCredentials?: ExternalCredentials;
}

/** The seams a provider-backed sign-in needs; see {@link AuthServiceOptions.externalCredentials}. */
export interface ExternalCredentials {
  readonly port: ExternalCredentialPort;
  /** Verifies the session token the provider returns (signature, issuer, audience, expiry). */
  readonly verifier: OperatorTokenVerifier;
  /** The subject of the user's ACTIVE external link, or null when the user has none. */
  readonly activeLinkSubject: (userId: string) => Promise<string | null>;
  /**
   * RT-1327: the live user whose ACTIVE link to this provider has this subject, or
   * null (unlinked, disabled, soft-deleted or ambiguous). A recovery proof
   * authenticates only through this lookup.
   */
  readonly findUserByLinkSubject: (
    subject: string,
  ) => Promise<{ readonly userId: string; readonly email: string } | null>;
}

/** Audit action strings emitted from the sign-in flow (per `tasks.md` T230). */
export const AUTH_AUDIT_ACTIONS = {
  signinOk: "auth.signin.ok",
  signinFailed: "auth.signin.failed",
} as const;

export interface SignOutResult {
  /** True on the first revoke call; false if already revoked. */
  revoked: boolean;
}

export interface RefreshResult {
  sessionId: string;
  userId: string;
  /** Absolute expiry watermark — unchanged by refresh. */
  absoluteExpiresAt: Date;
}

@Injectable()
export class AuthService {
  private readonly db: NodePgDatabase;
  protected readonly rateLimiter: RateLimiter; // controller-level limits today; kept for injection
  private readonly emailJobs: EmailJobEnqueuer;
  private readonly auditEnqueuer: AuditJobEnqueuer;
  private readonly listMemberships: SignInMembershipsReader;
  private readonly endSupportSessions: NonNullable<AuthServiceOptions["endSupportSessions"]>;
  private readonly external: ExternalCredentials | null;

  constructor(
    private readonly pool: Pool,
    private readonly sessions: SessionRepository,
    /**
     * Required for password-reset and email-verify flows; optional only
     * so the slice-3a `auth.service.spec.ts` (sign-in only) can construct
     * the service with two args. Methods that need it throw clearly when
     * it isn't wired.
     */
    private readonly authTokens?: AuthTokenRepository,
    emailJobs?: EmailJobEnqueuer,
    opts: AuthServiceOptions = {},
  ) {
    this.db = drizzle(pool);
    this.rateLimiter = opts.rateLimiter ?? new NoOpRateLimiter();
    this.emailJobs = emailJobs ?? new NoOpEmailJobEnqueuer();
    this.auditEnqueuer = opts.auditEnqueuer ?? new NoOpAuditJobEnqueuer();
    this.listMemberships = opts.listMemberships ?? (() => Promise.resolve([]));
    this.endSupportSessions = opts.endSupportSessions ?? (() => Promise.resolve());
    this.external = opts.externalCredentials ?? null;
  }

  private requireAuthTokens(): AuthTokenRepository {
    if (!this.authTokens) {
      throw new Error(
        "AuthService: AuthTokenRepository not configured (slice-3c methods require it)",
      );
    }
    return this.authTokens;
  }

  // ---------------------------------------------------------------------
  // Sign-in (slice 3a)
  // ---------------------------------------------------------------------

  /**
   * Verify credentials and create a dashboard session. Returns the row id
   * and a separate CSPRNG cookie value. The controller sets the cookie.
   * Only the SHA-256 of that cookie is persisted.
   *
   * Two credential authorities (RT-937, owner decision D-A):
   *   - a user with an ACTIVE external identity link signs in ONLY with the
   *     password held by the external provider; the local hash is ignored, so
   *     a migrated user's old local password never works;
   *   - a user with no active link keeps native sign-in until migrated.
   * Either way the session minted below is the same native session, with the
   * same cookie, rate limits, memberships and store authorization.
   *
   * Throws a uniform UnauthorizedException for ALL failure modes (a linked
   * user's refusal is indistinguishable from a wrong password), and a 503 only
   * when the provider itself is unavailable.
   */
  async signIn(input: SignInInput): Promise<SignInResult> {
    const { email, password } = input;
    const userRow = await this.findActiveUserByEmail(email);

    // Always run the verify call — even when the user is missing, using
    // a dummy PHC — so request latency doesn't depend on existence.
    const phc = userRow?.passwordHash ?? DUMMY_PHC;
    const passwordOk = await verifyPassword(phc, password);

    // The provider is asked only about a known user who is linked: an unknown
    // or unlinked email's password is never forwarded.
    const linkSubject = userRow ? await this.externalLinkSubject(userRow.id) : null;
    const viaProvider = userRow !== null && linkSubject !== null;
    const authenticated = viaProvider
      ? await this.authenticateExternally(email, password, linkSubject)
      : userRow !== null && userRow.passwordHash !== null && passwordOk;

    if (!userRow || !authenticated) {
      // T470 — observability: emit auth_failure_total{cause="bad_password"}
      // for every credential-verify failure branch (unknown email, SSO-only
      // null passwordHash, soft-deleted, wrong password). These branches are
      // deliberately indistinguishable to the client per FR-ISO-4 (anti-
      // enumeration); the metric mirrors that intent by emitting the same
      // outcome-derived `cause` label for all of them. The label set is
      // bounded by AuthFailureCause:
      //   cause: "bad_password" | "bad_token" | "expired" | "missing" | "rate_limited"
      // Emitted BEFORE the throw so a downstream catch can't suppress the
      // metric without also suppressing the exception.
      recordAuthFailure({ cause: "bad_password" });

      // T238 — emit anonymous-actor audit event AFTER the constant-time
      // verify path so timing is preserved across all failure modes
      // (unknown email, SSO-only, soft-deleted, wrong password). The
      // attempted email is the Zod-normalized form (lowercased, trimmed)
      // already validated by `SignInSchema`; we MUST NOT include the
      // password, the raw body, or any token in the payload.
      this.fireAndForgetAudit({
        actor_user_id: null,
        actor_label: email,
        tenant_id: null,
        store_id: null,
        action: AUTH_AUDIT_ACTIONS.signinFailed,
        target_type: null,
        target_id: null,
        request_id: null,
        metadata: null,
      });
      throw new UnauthorizedException("Invalid credentials");
    }

    // RT-130: only after a successful verify, so failure timing is untouched.
    // Only a native sign-in proved the local password; a provider sign-in never touches it.
    if (!viaProvider && userRow.passwordHash !== null) {
      await this.upgradeStalePasswordHash(userRow.id, userRow.passwordHash, password);
    }

    // RT-343: read before the session exists, so a failed read leaves no
    // session behind.
    const memberships = await this.listMemberships(userRow.id);

    const { sessionId, sessionCredential, absoluteExpiresAt } = await this.startSession(userRow.id);

    // T238/T230 — successful sign-in audit event. Action string is
    // mandated by `tasks.md` T230 (`auth.signin.{ok|failed}`); pairs with
    // the failure emission above so an audit reader sees a complete
    // outcome record for every credential evaluation.
    this.fireAndForgetAudit({
      actor_user_id: userRow.id,
      actor_label: userRow.email,
      tenant_id: null,
      store_id: null,
      action: AUTH_AUDIT_ACTIONS.signinOk,
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: null,
    });

    return {
      sessionId,
      sessionCredential,
      userId: userRow.id,
      absoluteExpiresAt,
      user: {
        id: userRow.id,
        email: userRow.email,
        display_name: userRow.displayName,
        is_platform_admin: userRow.isPlatformAdmin,
      },
      memberships,
    };
  }

  /**
   * Create one native dashboard session for `userId`. The row id and a separate
   * CSPRNG cookie value are returned; only the SHA-256 of the cookie value is
   * persisted. The caller sets the cookie. Shared by sign-in and by invitation
   * acceptance (RT-937: a NEW invitee's session), so both mint identically.
   */
  async startSession(
    userId: string,
  ): Promise<{ sessionId: string; sessionCredential: string; absoluteExpiresAt: Date }> {
    const sessionId = newId();
    const sessionCredential = generateRawToken();
    const absoluteExpiresAt = new Date(Date.now() + SESSION_ABSOLUTE_EXPIRY_MS);
    await this.sessions.create({
      id: sessionId,
      userId,
      absoluteExpiresAt,
      credentialHash: hashToken(sessionCredential),
    });
    return { sessionId, sessionCredential, absoluteExpiresAt };
  }

  /** The subject of the user's ACTIVE external link; null when none, or when no provider is wired. */
  private async externalLinkSubject(userId: string): Promise<string | null> {
    return this.external ? await this.external.activeLinkSubject(userId) : null;
  }

  /**
   * Verify a linked user's password at the provider. The provider's answer alone
   * authenticates nobody: its session token is verified and its subject must be
   * the one on the user's link. A refusal, a token that fails verification and a
   * subject mismatch are all `false` (one generic 401 upstream); an outage is a
   * 503, because an outage is not a wrong password.
   */
  private async authenticateExternally(
    email: string,
    password: string,
    linkSubject: string,
  ): Promise<boolean> {
    const external = this.external;
    if (!external) return false;
    const result = await external.port.passwordSignIn(email, password);
    if (result.kind === "unavailable") {
      throw new ServiceUnavailableException("Identity provider unavailable");
    }
    if (result.kind !== "ok") return false;
    return this.tokenIsForLink(external, result.sessionJwt, linkSubject);
  }

  /** True only when the provider's session token verifies and names the link's subject. */
  private async tokenIsForLink(
    external: ExternalCredentials,
    sessionJwt: string,
    linkSubject: string,
  ): Promise<boolean> {
    try {
      const claims = await external.verifier.verify(sessionJwt);
      return claims.sub === linkSubject;
    } catch {
      return false;
    }
  }

  /**
   * Re-hash the password with the current `ARGON2_PARAMS` when the stored
   * hash was produced with older ones (RT-130), so a parameter bump reaches
   * every active user on their next sign-in.
   *
   * Compare-and-swap on the old hash: a password changed concurrently (e.g.
   * a reset) is never overwritten. Best-effort: any failure leaves the old,
   * still-valid hash in place and never fails the sign-in — the next
   * successful sign-in retries.
   */
  private async upgradeStalePasswordHash(
    userId: string,
    storedHash: string,
    password: string,
  ): Promise<void> {
    if (!needsRehash(storedHash)) return;
    try {
      const upgraded = await hashPassword(password);
      await this.db
        .update(users)
        .set({ passwordHash: upgraded, updatedAt: sql`now()` })
        .where(
          and(
            eq(users.id, userId),
            eq(users.passwordHash, storedHash),
            isNull(users.deletedAt),
          ),
        );
    } catch {
      // Keep the old hash; it still verifies.
    }
  }

  /**
   * Enqueue an audit job without awaiting completion and without surfacing
   * enqueue errors to the caller. Mirrors the policy used by
   * `AuditEmitterInterceptor` (audit-emitter.interceptor.ts:92): an audit
   * emission failure is non-fatal — it MUST NOT cause the sign-in flow to
   * differ in shape, status, or timing from the no-audit baseline.
   *
   * NOTE: this is intentionally not `async` and intentionally returns
   * `void`. Callers MUST NOT await it — doing so would couple sign-in
   * latency to queue health.
   */
  private fireAndForgetAudit(payload: AuditJobPayload): void {
    this.auditEnqueuer.enqueue(payload).catch(() => {
      // Swallow — see method docstring.
    });
  }

  // ---------------------------------------------------------------------
  // Sign-out
  // ---------------------------------------------------------------------

  /**
   * Idempotent revocation of an existing session. The controller has
   * already verified — via AuthGuard — that the caller owns the cookie
   * being revoked, so no additional ownership check is needed.
   */
  async signOut(sessionId: string, requestId: string | null = null): Promise<SignOutResult> {
    const revoked = await this.sessions.revoke(sessionId);
    // RT-414: a support session ends with its auth session.
    await this.endSupportSessions({ authSessionId: sessionId }, requestId);
    return { revoked };
  }

  // ---------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------

  /**
   * Sliding-window refresh: bumps `last_seen_at` to now without extending
   * `absolute_expires_at`. The session's hard cap doesn't move, so a
   * freshly refreshed cookie still expires by the original absolute
   * watermark. Returns null if the session is no longer active (revoked
   * mid-flight, or aged past the absolute cap) — the controller renders
   * that as 401.
   */
  async refresh(sessionId: string): Promise<RefreshResult | null> {
    const session = await this.sessions.findActiveById(sessionId);
    if (!session) return null;
    await this.sessions.touchLastSeen(sessionId);
    return {
      sessionId: session.id,
      userId: session.userId,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  // ---------------------------------------------------------------------
  // Change password (RT-937 item 2)
  // ---------------------------------------------------------------------

  /**
   * Replace the signed-in user's password at the external provider (old + new),
   * then revoke the user's OTHER native sessions and end their support sessions
   * (owner decision D-C). The caller's own session survives: it just proved the
   * current password.
   *
   * Only a user with an ACTIVE external identity link can change a password here;
   * there is no native change-password, and none is invented (409). A wrong
   * current password, a rejected new password and an answer that fails
   * verification are ONE generic 400, so the response cannot be used to probe
   * either password; a provider outage is a 503. Nothing is revoked unless the
   * provider's answer is verified against the user's link.
   */
  async changePassword(input: {
    userId: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
    requestId: string | null;
  }): Promise<void> {
    const user = await this.findActiveUserById(input.userId);
    if (!user) throw new UnauthorizedException("Unauthorized");

    const external = this.external;
    const linkSubject = await this.externalLinkSubject(user.id);
    if (!external || linkSubject === null) {
      throw new ConflictException("Password change is not available for this account");
    }

    const result = await external.port.replacePassword(user.email, input.currentPassword, input.newPassword);
    if (result.kind === "unavailable") {
      throw new ServiceUnavailableException("Identity provider unavailable");
    }
    if (result.kind !== "ok" || !(await this.tokenIsForLink(external, result.sessionJwt, linkSubject))) {
      throw new BadRequestException(PASSWORD_CHANGE_REFUSED);
    }

    const revoked = await this.sessions.revokeOthersForUser(user.id, input.sessionId);
    // sequential: ends support sessions one revoked session at a time, so pool load stays bounded and the first failure stops the rest.
    for (const authSessionId of revoked) {
      await this.endSupportSessions({ authSessionId }, input.requestId);
    }
  }

  // ---------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------

  /**
   * Always succeeds from the caller's perspective. If the email maps to
   * an active user, issue a one-shot reset token and enqueue the email
   * job; otherwise do nothing. The controller returns 202 either way.
   *
   * RT-1262 / RT-1327: a user with an ACTIVE external identity link signs in with
   * the provider's password only, so a local reset cannot help them. No local
   * token is issued and no local email is sent; the provider is asked to send its
   * own recovery link instead (it mails only a verified address). Every provider
   * outcome stays inside this method, so the route's 202 never discloses the link,
   * the verification state or an outage. Anything but `sent` is logged with its
   * result kind only, so an operator sees a missing return URL or a failing provider.
   */
  async requestPasswordReset(input: { email: string }): Promise<void> {
    const userRow = await this.findActiveUserByEmail(input.email);
    if (!userRow) return; // silent success — no leak
    if ((await this.externalLinkSubject(userRow.id)) !== null) {
      const sent = await this.external?.port.sendPasswordReset(userRow.email);
      if (sent !== undefined && sent.kind !== "sent") {
        log().warn({ result: sent.kind }, "provider password reset for a linked account was not sent");
      }
      return;
    }

    const rawToken = generateRawToken();
    await this.requireAuthTokens().issue(rawToken, {
      id: newId(),
      tenantId: null, // platform-scoped: anyone with the link can act
      userId: userRow.id,
      deviceId: null,
      storeId: null,
      scope: AUTH_TOKEN_SCOPES.passwordReset,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });

    await this.emailJobs.enqueuePasswordReset({
      email: userRow.email,
      rawToken,
      userId: userRow.id,
    });
  }

  /**
   * Confirm a password reset using a token from the email. Throws
   * BadRequestException for invalid / expired / wrong-scope tokens — the
   * exception filter renders that as a 400 envelope.
   *
   * The token is consumed atomically FIRST (RT-146): one conditional
   * `UPDATE … RETURNING` revokes it only if it is still unrevoked,
   * unexpired and password_reset-scoped, so concurrent or replayed confirms
   * of the same token cannot both proceed — exactly one wins, the rest get
   * the same generic 400. Then: hash the new password (argon2id), update
   * the user, and revoke ALL of the user's active sessions so a stolen
   * cookie can't outlive the credential change. If a later step fails the
   * token stays consumed (fail closed); the user requests a new link.
   *
   * RT-1262: a token whose user has an ACTIVE external identity link at confirm
   * time (issued before the request guard, or linked since) is consumed and
   * refused with the same 400: no local hash is written, no session is revoked
   * and no address is returned, so the controller clears no sign-in lockout.
   */
  async confirmPasswordReset(input: {
    rawToken: string;
    newPassword: string;
  }): Promise<string | null> {
    const repo = this.requireAuthTokens();
    const tokenRow = await repo.consumeActiveByRawToken(
      input.rawToken,
      AUTH_TOKEN_SCOPES.passwordReset,
    );
    // RT-1327: a token Backend-Core does not hold is the provider's recovery proof.
    if (!tokenRow) return this.confirmProviderReset(input);
    if (tokenRow.userId === null) {
      throw new BadRequestException(INVALID_RESET_TOKEN);
    }
    const userId = tokenRow.userId;
    if ((await this.externalLinkSubject(userId)) !== null) {
      throw new BadRequestException(INVALID_RESET_TOKEN);
    }

    const newHash = await hashPassword(input.newPassword);
    const updated = await this.db
      .update(users)
      .set({ passwordHash: newHash, updatedAt: sql`now()` })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({ email: users.email });

    await this.revokeAllSessionsForUser(userId);
    await this.endSupportSessions({ userId }, null);
    // RT-625 D2: the address whose sign-in lockout the controller lifts. Null
    // when no live user took the new password (nothing to clear).
    return updated[0]?.email ?? null;
  }

  /**
   * RT-1327: complete a provider-backed recovery. The provider owns the one-time
   * proof, so nothing here validates the token itself:
   *
   *   1. the provider consumes the proof and returns a session (a used, expired
   *      or unknown proof is refused);
   *   2. that session token must verify, and its subject must be an ACTIVE link
   *      of a live user (the link, not the provider's answer, names the account);
   *   3. the provider then sets the new password (its policy applies; a refusal
   *      has already consumed the link, so the user requests a new one);
   *   4. every provider session of the user is ended with the same refresh token
   *      (`logoutall`), so a session opened with the old password does not survive.
   *      This runs whenever step 1 succeeded, also when step 2 or 3 refused, so the
   *      session the proof itself opened never outlives this call;
   *   5. every Backend-Core session of the user is revoked, as in the legacy reset.
   *
   * No local hash is written and no session is minted: the user signs in again
   * through `POST /auth/signin`. The refresh token lives only in this call. Every
   * refusal up to step 3 is the same generic 400, so nothing reveals which step
   * refused. A provider outage at step 1 or 3 is a 503, as for sign-in and
   * password change: an outage is not an invalid link. An outage at step 3 comes
   * after the link was consumed, so the user then needs a new link. A failed step 4
   * is logged and does not fail the request: the password is already changed.
   */
  private async confirmProviderReset(input: { rawToken: string; newPassword: string }): Promise<string> {
    const external = this.external;
    if (!external) throw new BadRequestException(INVALID_RESET_TOKEN);

    const proof = await external.port.verifyResetToken(input.rawToken);
    if (proof.kind !== "ok") throw providerResetFailure(proof.kind);

    let user: { readonly userId: string; readonly email: string };
    try {
      user = await this.setProviderPassword(external, proof, input.newPassword);
    } finally {
      await this.endProviderSessions(external, proof.refreshJwt);
    }

    await this.revokeAllSessionsForUser(user.userId);
    await this.endSupportSessions({ userId: user.userId }, null);
    // The proof showed control of the address: the controller lifts its sign-in lockout (RT-625 D2).
    return user.email;
  }

  /** Steps 2 and 3 of `confirmProviderReset`: the linked live user whose provider password was set. */
  private async setProviderPassword(
    external: ExternalCredentials,
    proof: { readonly sessionJwt: string; readonly refreshJwt: string },
    newPassword: string,
  ): Promise<{ readonly userId: string; readonly email: string }> {
    const subject = await this.verifiedSubject(external, proof.sessionJwt);
    const user = subject === null ? null : await external.findUserByLinkSubject(subject);
    if (!user) throw new BadRequestException(INVALID_RESET_TOKEN);

    const updated = await external.port.updatePassword(user.email, newPassword, proof.refreshJwt);
    if (updated.kind === "unavailable") {
      // Ambiguous: the provider may have applied the password before its answer was
      // lost, and the proof is spent, so no retry can finish this reset. Fail closed:
      // revoke as on success (never retry the write), then report the outage.
      await this.revokeAllSessionsForUser(user.userId);
      await this.endSupportSessions({ userId: user.userId }, null);
    }
    if (updated.kind !== "ok") throw providerResetFailure(updated.kind);
    return user;
  }

  /**
   * Step 4 of `confirmProviderReset`, never thrown. An outage is retried once (a
   * refusal is not: retrying cannot help it). A sign-out that still failed is an
   * alert (owner decision 2026-11-11): the `auth_provider_signout_failure_total`
   * counter and an error log, with the result kind only.
   */
  private async endProviderSessions(external: ExternalCredentials, refreshJwt: string): Promise<void> {
    const attempt = (): Promise<LogoutAllResult> =>
      external.port.logoutAllSessions(refreshJwt).catch((): LogoutAllResult => ({ kind: "unavailable" }));
    let signedOut = await attempt();
    if (signedOut.kind === "unavailable") signedOut = await attempt();
    if (signedOut.kind === "ok") return;
    recordProviderSignOutFailure({ result: signedOut.kind });
    // Fixed message and result kind only: no token, subject, email or user id.
    log().error({ result: signedOut.kind }, "provider sign-out after password reset failed; provider sessions may survive");
  }

  /** The subject of a provider session token that verifies, or null. */
  private async verifiedSubject(external: ExternalCredentials, sessionJwt: string): Promise<string | null> {
    try {
      return (await external.verifier.verify(sessionJwt)).sub;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Email verification
  // ---------------------------------------------------------------------

  /**
   * Issue a verification token for the signed-in user and enqueue the
   * email job. The controller has already authenticated the caller via
   * AuthGuard; we look the user up to read their canonical email.
   */
  async requestEmailVerification(input: { userId: string }): Promise<void> {
    const userRow = await this.findActiveUserById(input.userId);
    if (!userRow) return; // session referenced a user that vanished

    const rawToken = generateRawToken();
    await this.requireAuthTokens().issue(rawToken, {
      id: newId(),
      tenantId: null,
      userId: userRow.id,
      deviceId: null,
      storeId: null,
      scope: AUTH_TOKEN_SCOPES.emailVerify,
      expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    });

    await this.emailJobs.enqueueEmailVerification({
      email: userRow.email,
      rawToken,
      userId: userRow.id,
    });
  }

  /**
   * Confirm email verification. Stamps `users.email_verified_at` to now
   * and revokes the token. Wrong scope / expired / unknown all map to
   * the same 400 — no information leak.
   */
  async confirmEmailVerification(input: { rawToken: string }): Promise<void> {
    const repo = this.requireAuthTokens();
    const tokenRow = await repo.findActiveByRawToken(input.rawToken);
    if (tokenRow?.scope !== AUTH_TOKEN_SCOPES.emailVerify) {
      throw new BadRequestException("Invalid or expired token");
    }
    if (tokenRow.userId === null) {
      throw new BadRequestException("Invalid or expired token");
    }
    const userId = tokenRow.userId;

    await this.db
      .update(users)
      .set({ emailVerifiedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));

    await repo.revoke(tokenRow.id);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async findActiveUserByEmail(email: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async findActiveUserById(id: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Revoke every active session belonging to a user. Inlined here so the
   * slice doesn't extend `SessionRepository` (out of scope per the slice
   * approval). Uses Drizzle on the same admin pool the rest of the
   * service shares.
   */
  private async revokeAllSessionsForUser(userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }
}
