/**
 * RT-1525 — Pricing's implementation of the stores port `StorePricingLifecycle`, and its DI wiring.
 *
 * The SQL moved verbatim from `common/pricing-store-lifecycle.ts` (RT-1484 PR-10b); these specs pin
 * what must not change in the move: the lock namespace (the advisory-lock key), the bootstrap row's
 * guards (none before the first revision, idempotent), the caller's client, and the token binding.
 * The database behaviour itself is covered by price-change-set-publish.http.integration.spec.ts
 * (a Store created or activated after a revision gets its row at the head; a repeat keeps one row).
 */
import "reflect-metadata";

import { Test } from "@nestjs/testing";

import { PricingStoreLifecycleModule } from "../../src/pricing/pricing-store-lifecycle.module";
import { lockPricingPublish } from "../../src/pricing/pricing-publish-lock";
import { PricingStoreLifecycleAdapter } from "../../src/pricing/store-lifecycle/pricing-store-lifecycle.adapter";
import { STORE_PRICING_LIFECYCLE, type StorePricingLifecycle } from "../../src/stores";

const TENANT = "01890000-0000-7000-8000-00000000000a";
const STORE = "01890000-0000-7000-8000-00000000000b";
const ACTOR = "01890000-0000-7000-8000-00000000000c";
const CORRELATION = "01890000-0000-7000-8000-00000000000d";

function recordingClient(): { client: { query: jest.Mock }; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
  };
  return { client, calls };
}

const squash = (sql: string): string => sql.replace(/\s+/g, " ").trim();

describe("PricingStoreLifecycleAdapter (RT-1525)", () => {
  it("lockForStoreWrite takes the transaction-scoped 'pricing-publish' advisory lock on the caller's client", async () => {
    const { client, calls } = recordingClient();
    await new PricingStoreLifecycleAdapter().lockForStoreWrite(client, TENANT);
    expect(calls).toEqual([
      { sql: `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, params: ["pricing-publish", TENANT] },
    ]);
  });

  it("lockForStoreWrite and Pricing's own lockPricingPublish take the same key", async () => {
    const viaPort = recordingClient();
    const direct = recordingClient();
    await new PricingStoreLifecycleAdapter().lockForStoreWrite(viaPort.client, TENANT);
    await lockPricingPublish(direct.client, TENANT);
    expect(viaPort.calls).toEqual(direct.calls);
  });

  it("bootstrapStore inserts at the tenant's head only, never before the first revision, and is idempotent", async () => {
    const { client, calls } = recordingClient();
    await new PricingStoreLifecycleAdapter().bootstrapStore(client, {
      tenantId: TENANT,
      storeId: STORE,
      actorUserId: ACTOR,
      correlationId: CORRELATION,
    });
    expect(calls).toHaveLength(1);
    const sql = squash(calls[0]!.sql);
    expect(sql).toContain("INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id)");
    // The head: the tenant's highest revision, from its own rows only.
    expect(sql).toContain("FROM (SELECT max(r.revision_no) AS head FROM pricing_revisions r WHERE r.tenant_id = $1::uuid) h");
    // No row before the tenant's first revision.
    expect(sql).toContain("WHERE h.head IS NOT NULL");
    // A repeat keeps the existing row.
    expect(sql).toContain("ON CONFLICT (tenant_id, store_id, revision_no) DO NOTHING");
    expect(calls[0]!.params).toEqual([TENANT, STORE, ACTOR, CORRELATION]);
  });

  it("PricingStoreLifecycleModule binds STORE_PRICING_LIFECYCLE to the adapter", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PricingStoreLifecycleModule] }).compile();
    const port = moduleRef.get<StorePricingLifecycle>(STORE_PRICING_LIFECYCLE);
    expect(port).toBeInstanceOf(PricingStoreLifecycleAdapter);
    await moduleRef.close();
  });
});
