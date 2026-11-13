/**
 * The data seam of the signup service (RT-1350 slice 3). Every method runs on the
 * caller's `PoolClient`, inside a platform-admin transaction the service opened, so
 * the service owns the transaction boundaries and the unit specs can fake this
 * interface. The real implementation is `SignupsRepository` (plain SQL).
 */
import type { PoolClient } from "pg";

export type SignupLocale = "ar" | "en";

/** A `pending_signups` row as the service reads it. */
export interface PendingSignupRecord {
  readonly id: string;
  readonly emailNormalized: string;
  readonly name: string;
  readonly businessName: string;
  readonly locale: SignupLocale | null;
  readonly termsVersion: string;
  readonly termsAcceptedAt: Date;
  readonly ipHash: string;
  readonly status: "pending" | "completed" | "expired";
  readonly expiresAt: Date;
}

/** What the service needs to know about an existing Backend-Core user. */
export interface SignupUserRecord {
  readonly id: string;
  readonly isPlatformAdmin: boolean;
  /** Soft-deleted. (A disabled identity link is read separately, on the lookup pool.) */
  readonly blocked: boolean;
}

export interface NewPendingSignup {
  readonly id: string;
  readonly emailNormalized: string;
  readonly name: string;
  readonly businessName: string;
  readonly locale: SignupLocale | null;
  readonly termsVersion: string;
  readonly termsAcceptedAt: Date;
  readonly ipHash: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface RestrictedTenantInput {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly membershipId: string;
}

export interface SignupAuditRow {
  readonly actorUserId: string | null;
  readonly tenantId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SignupsStore {
  /** The live user with this normalized email, or null. */
  findUserByEmail(client: PoolClient, email: string): Promise<SignupUserRecord | null>;
  /** A `completed` signup for this email whose `completed_at` is at or after `since`. */
  hasCompletedSignupSince(client: PoolClient, email: string, since: Date): Promise<boolean>;
  /** Mark every `pending` row of this email `expired` (stale or superseded). */
  expirePendingByEmail(client: PoolClient, email: string): Promise<void>;
  /** Insert a pending row; a concurrent pending row for the email raises SQLSTATE 23505. */
  insertPending(client: PoolClient, row: NewPendingSignup): Promise<void>;
  findPendingByTokenHash(client: PoolClient, tokenHash: string): Promise<PendingSignupRecord | null>;
  /** The pending row, `FOR UPDATE`. */
  lockPending(client: PoolClient, id: string): Promise<PendingSignupRecord | null>;
  insertUser(client: PoolClient, row: { id: string; email: string; displayName: string }): Promise<void>;
  insertIdentityLink(
    client: PoolClient,
    row: { providerKey: string; issuer: string; subject: string; userId: string; email: string },
  ): Promise<void>;
  /** Tenant `active`, the default roles, the `owner` membership and the `restricted` entitlement. */
  createRestrictedTenant(client: PoolClient, input: RestrictedTenantInput): Promise<void>;
  insertConsent(
    client: PoolClient,
    row: { userId: string; termsVersion: string; acceptedAt: Date; ipHash: string; pendingSignupId: string },
  ): Promise<void>;
  markCompleted(client: PoolClient, id: string, tenantId: string): Promise<void>;
  insertAudit(client: PoolClient, row: SignupAuditRow): Promise<void>;
}

/** DI token for the store. */
export const SIGNUPS_STORE = "SIGNUPS_STORE";
