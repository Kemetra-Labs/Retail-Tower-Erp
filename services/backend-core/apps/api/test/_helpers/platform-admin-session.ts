/**
 * RT-1470 test helper: a platform admin with NO membership in the tenant, on a cookie session whose
 * active tenant is `tenantId` (and optionally an active store). It is the caller a platform admin is
 * when they open an organization directly from /platform (RT-1468), with no support session.
 *
 * Registers the session with the header-session harness, so `x-test-session: <sessionId>` signs the
 * request in as that user. `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import type { Pool } from "pg";

import { registerTestSession } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";

export interface PlatformAdminSessionSeed {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly tenantId: string;
  readonly activeStoreId?: string | null;
}

export async function seedPlatformAdminSession(admin: Pool, seed: PlatformAdminSessionSeed): Promise<void> {
  await admin.query(`INSERT INTO users (id, email, is_platform_admin) VALUES ($1, $2, true)`, [seed.userId, seed.email]);
  await admin.query(
    `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [seed.sessionId, seed.userId, seed.tenantId, seed.activeStoreId ?? null],
  );
  registerTestSession(seed.sessionId, seed.userId);
}
