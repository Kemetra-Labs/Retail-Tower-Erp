/**
 * ConsoleReauthService — RT-1439 (`console-force-actions.openapi.yaml`, `consoleReauthenticate`).
 *
 * Re-entering the password for ONE sensitive action (today: `store_deletion`) yields a 5-minute,
 * single-use grant bound to the session, the user, the purpose and the store. The password is
 * the LAST thing checked, so no caller who fails an earlier step can use this endpoint to test a
 * password (contract, evaluation order). Steps handled here, after the guards (authentication,
 * `Origin`, support session, owner gate, console limit) and body validation:
 *
 *   3. the store in the caller's tenant, not deleted (404); a `tenant_admin` (403
 *      `store_deletion_owner_only`);
 *   4. the failed-attempt budget, 5 per 15 minutes per user, read BEFORE any password is
 *      verified (429 `reauth_rate_limited`); the reserved hit is given back on a success and on
 *      an outage, so only wrong guesses count;
 *   5. the password verification (403 `reauth_failed`, one generic answer; 503
 *      `identity_provider_unavailable`);
 *   6. the grant (200).
 *
 * The password lives in this call's stack only: it is never logged, stored, audited or returned.
 * The audit rows `auth.reauth.granted` and `auth.reauth.refused` carry `purpose` and `store_id`
 * only.
 */
import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { createLogger, newId, type Logger } from "@data-pulse-2/shared";

import { AuthService } from "../../auth/auth.service";
import { PG_POOL } from "../../auth/database-pools";
import { RATE_LIMIT_BUCKETS, RateLimiter } from "../../auth/rate-limit";
import { StoresRepository } from "../stores.repository";
import { ConsoleActionRateLimited } from "./console-429";
import { type ReauthBinding, ReauthGrantStore, type ReauthPurpose } from "./reauth-grant.store";
import { storeDeletionOwnerOnly, storeNotFound } from "./store-deletion.errors";

const REAUTH_FAILED = "reauth_failed";
const IDENTITY_PROVIDER_UNAVAILABLE = "identity_provider_unavailable";
const GRANTED_ACTION = "auth.reauth.granted";
const REFUSED_ACTION = "auth.reauth.refused";
const BUCKET = "reauth_user";

let serviceLogger: Logger | null = null;
function log(): Logger {
  serviceLogger ??= createLogger({ service: "api.reauth", level: process.env["LOG_LEVEL"] ?? "info" });
  return serviceLogger;
}

export interface ReauthInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly storeId: string;
  readonly purpose: ReauthPurpose;
  readonly password: string;
  /** The caller's role in the tenant, as the guard read it. */
  readonly role: string | null;
  readonly requestId: string | null;
}

export interface ReauthGrantBody {
  readonly reauthToken: string;
  readonly purpose: ReauthPurpose;
  readonly storeId: string;
  readonly expiresAt: string;
}

function unavailable(): HttpException {
  return new HttpException(
    { code: IDENTITY_PROVIDER_UNAVAILABLE, message: "Temporarily unavailable. Retry later." },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

@Injectable()
export class ConsoleReauthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly stores: StoresRepository,
    private readonly auth: AuthService,
    private readonly grants: ReauthGrantStore,
    private readonly limiter: RateLimiter,
  ) {}

  async reauthenticate(input: ReauthInput): Promise<ReauthGrantBody> {
    await this.requireStoreAndRole(input);
    await this.reserveAttempt(input.userId);

    let verdict: "ok" | "refused";
    try {
      verdict = await this.auth.verifyCurrentPassword(input.userId, input.password);
    } catch (err) {
      await this.giveBackAttempt(input.userId); // an outage is not a wrong guess
      if (err instanceof HttpException && err.getStatus() === HttpStatus.SERVICE_UNAVAILABLE) throw unavailable();
      throw err;
    }
    if (verdict === "refused") {
      await this.recordAudit(input, REFUSED_ACTION, false);
      throw new ForbiddenException({ code: REAUTH_FAILED, message: "Re-authentication failed." });
    }

    await this.giveBackAttempt(input.userId); // only failed attempts count
    const binding: ReauthBinding = {
      sessionId: input.sessionId,
      userId: input.userId,
      tenantId: input.tenantId,
      storeId: input.storeId,
      purpose: input.purpose,
    };
    let grant: { token: string; expiresAt: Date };
    try {
      grant = await this.grants.issue(binding);
    } catch {
      log().warn({ result: "grant_store_unavailable" }, "re-authentication grant could not be stored");
      throw unavailable();
    }
    await this.recordAudit(input, GRANTED_ACTION, true);
    return {
      reauthToken: grant.token,
      purpose: input.purpose,
      storeId: input.storeId,
      expiresAt: grant.expiresAt.toISOString(),
    };
  }

  /** Step 3: the store (404), then the owner-only refusal of a `tenant_admin` (403). */
  private async requireStoreAndRole(input: ReauthInput): Promise<void> {
    const store = await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, (client) =>
      this.stores.findById(client, input.storeId),
    );
    if (!store) throw storeNotFound();
    if (input.role !== "owner") throw storeDeletionOwnerOnly();
  }

  /** Step 4: reserve one failed-attempt slot BEFORE the password is looked at. */
  private async reserveAttempt(userId: string): Promise<void> {
    let decision: Awaited<ReturnType<RateLimiter["check"]>>;
    try {
      decision = await this.limiter.check(BUCKET, userId, RATE_LIMIT_BUCKETS.reauthPerUser);
    } catch {
      log().warn({ bucket: BUCKET }, "re-authentication limiter unavailable; failing closed (503)");
      throw unavailable();
    }
    if (decision.allowed) return;
    await this.giveBackAttempt(userId); // a refused request tested no password
    throw new ConsoleActionRateLimited("reauth_rate_limited", decision.resetMs < 0 ? 1 : decision.resetMs / 1000);
  }

  private async giveBackAttempt(userId: string): Promise<void> {
    try {
      await this.limiter.release(BUCKET, userId);
    } catch {
      // Best effort: a failed release leaves the slot to expire with its window.
    }
  }

  /** `auth.reauth.granted` / `auth.reauth.refused`: `purpose` and `store_id` only; never a secret. */
  private async recordAudit(input: ReauthInput, action: string, required: boolean): Promise<void> {
    const write = (): Promise<unknown> =>
      runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, (client) =>
        client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
           VALUES ($1, $2, $3, $4, $5, 'store', $4, $6, $7::jsonb)`,
          [
            newId(),
            input.userId,
            input.tenantId,
            input.storeId,
            action,
            input.requestId,
            JSON.stringify({ purpose: input.purpose, store_id: input.storeId }),
          ],
        ),
      );
    if (required) {
      await write();
      return;
    }
    try {
      await write();
    } catch {
      log().warn({ action }, "re-authentication audit row could not be written");
    }
  }
}
