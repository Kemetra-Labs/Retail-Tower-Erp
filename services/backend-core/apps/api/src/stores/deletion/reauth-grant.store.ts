/**
 * The re-authentication grant — RT-1439 (`console-force-actions.openapi.yaml`, `consoleReauthenticate`).
 *
 * An opaque, random, single-use token that proves the signed-in user re-entered their password
 * for ONE purpose on ONE store, within 5 minutes. It is bound to the Console session, the user,
 * the tenant, the purpose and the store; a token presented from any other session, or for any
 * other store or purpose, is the same refusal as a missing or used one.
 *
 * Storage. Redis, keyed by the SHA-256 of the token (the raw token is never stored), with a
 * 5-minute TTL. It is NOT `auth_tokens`: that table's `scope` is pinned by a CHECK and it has no
 * session or purpose column, so a grant there would need a migration. `peek` reads without
 * consuming (a deletion refused for another reason leaves the grant valid); `consume` is one
 * atomic compare-and-delete, so two concurrent writes cannot both spend one grant.
 *
 * Fail closed: with the stub Redis (no `REDIS_URL`, non-production only) nothing is ever stored,
 * so no grant is ever valid.
 */
import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { REDIS_CLIENT } from "../../auth/auth.module";

export const REAUTH_GRANT_TTL_MS = 5 * 60 * 1000;

export type ReauthPurpose = "store_deletion";

export interface ReauthBinding {
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly purpose: ReauthPurpose;
}

/** The Redis surface the grant needs (the ioredis adapter and the test fakes implement it). */
export interface GrantRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { px: number }): Promise<unknown>;
  /** Delete `key` only when its value equals `expected`; true when it deleted. One atomic step. */
  compareAndDelete(key: string, expected: string): Promise<boolean>;
}

const KEY_PREFIX = "reauth:grant:";

function keyOf(token: string): string {
  return KEY_PREFIX + createHash("sha256").update(token).digest("hex");
}

/** A fixed key order, so the stored value and the expected value compare byte for byte. */
function encode(binding: ReauthBinding): string {
  return JSON.stringify([binding.sessionId, binding.userId, binding.tenantId, binding.storeId, binding.purpose]);
}

@Injectable()
export class ReauthGrantStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: GrantRedis) {}

  /** Mint a grant for the binding. The token is returned once and kept nowhere else. */
  async issue(binding: ReauthBinding, now: Date = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url"); // 43 characters of [A-Za-z0-9_-]
    await this.redis.set(keyOf(token), encode(binding), { px: REAUTH_GRANT_TTL_MS });
    return { token, expiresAt: new Date(now.getTime() + REAUTH_GRANT_TTL_MS) };
  }

  /** True when a live grant exists for exactly this binding. Does not consume it. */
  async peek(token: string, binding: ReauthBinding): Promise<boolean> {
    return (await this.redis.get(keyOf(token))) === encode(binding);
  }

  /** Spend the grant. True for exactly one caller; false for every other (used, expired, other binding). */
  async consume(token: string, binding: ReauthBinding): Promise<boolean> {
    return await this.redis.compareAndDelete(keyOf(token), encode(binding));
  }
}
