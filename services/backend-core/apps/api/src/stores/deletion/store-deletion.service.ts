/**
 * StoreDeletionService — RT-1439 (RT-1437 B2; `stores.openapi.yaml` 1.3.0-draft):
 * `previewStoreDeletion` and `consoleDeleteStore`.
 *
 * Both run on a tenant-scoped transaction (`runWithTenantContext`, RLS on) and evaluate the SAME
 * facts (`store-deletion.facts.ts`) the legacy `softDeleteStore` guards use. The preview is a
 * snapshot that writes nothing and takes no lock. The write re-decides in its own transaction,
 * with the store row locked `FOR UPDATE`, in the contract's order (`consoleDeleteStore`):
 *
 *   store exists (404) -> grant (403 `reauth_required`) -> guards (409) -> fingerprint
 *   (409 `preview_stale`) -> hourly cap (429) -> spend the grant, delete, audit.
 *
 * The grant is PEEKED at its step and SPENT only at the end, in one atomic compare-and-delete
 * while the store lock is held, so a refusal at any earlier step leaves it valid and two
 * concurrent deletions cannot both use it. Role, `Origin`, support-session and per-user console
 * limits are the guards' (controller); idempotency is the interceptor's.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../../database";
import type { ForceActionAuditActor } from "../../common/force-action-actor";
import { lockPricingPublish } from "../../common/pricing-store-lifecycle";
import { enforceForceActionCap } from "../../console-action-cap/force-action-cap";
import { StoresRepository } from "../stores.repository";
import { type ReauthBinding, ReauthGrantStore } from "./reauth-grant.store";
import {
  previewStale,
  reauthRequired,
  storeDeletionBlocked,
  storeNotFound,
} from "./store-deletion.errors";
import {
  evaluateStoreDeletionBlockers,
  factsStoreOf,
  readStoreDeletionFacts,
  storeDeletionFingerprint,
  type StoreDeletionBlocker,
  type StoreDeletionFacts,
} from "./store-deletion.facts";
import { deleteStoreWithAudit } from "./store-deletion.write";

/** The `StoreDeletionPreview` of the contract. */
export interface StoreDeletionPreview {
  readonly store: StoreDeletionFacts["store"];
  readonly openShifts: ReadonlyArray<{
    shiftId: string;
    openedAt: string;
    terminalLabel: string | null;
    forceCloseEligible: boolean;
  }>;
  readonly devices: ReadonlyArray<{
    deviceId: string;
    label: string | null;
    trustState: string;
    lastSeenAt: string | null;
    queue: { pending: number; deadLetter: number; held: number } | null;
  }>;
  readonly openCountSessions: ReadonlyArray<{ sessionId: string; status: string }>;
  readonly warehouseMappings: ReadonlyArray<{ warehouseRef: string }>;
  readonly singleStoreMembers: ReadonlyArray<{ userId: string; roleCode: string }>;
  readonly offersRebuiltCount: number;
  readonly effects: { readonly willChange: readonly string[]; readonly willNotChange: readonly string[] };
  readonly blockers: readonly StoreDeletionBlocker[];
  readonly canDelete: boolean;
  readonly reversible: false;
  readonly reversibleAlternative: "suspend_store";
  readonly caveats: readonly string[];
  readonly previewFingerprint: string;
  readonly evaluatedAt: string;
}

export interface ConsoleDeleteInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly storeId: string;
  readonly reason: string;
  readonly previewFingerprint: string;
  readonly reauthToken: string;
  /** The admitted caller (kind, role, on-behalf-of), as `StoreDeletionOwnerGuard` published it. */
  readonly actor: ForceActionAuditActor;
  readonly requestId: string | null;
}

const WILL_CHANGE = [
  "store_hidden_from_lists",
  "devices_refused_immediately",
  "offer_packs_rebuilt",
  "single_store_members_lose_access",
  "count_readiness_excludes_store",
  "inventory_activation_excludes_store",
] as const;
const WILL_NOT_CHANGE = [
  "sales_unchanged",
  "shifts_unchanged",
  "stock_movements_unchanged",
  "erp_documents_unchanged",
  "warehouse_mapping_kept",
] as const;
const CAVEATS = ["offline_facts_not_visible", "queue_as_of_last_heartbeat"] as const;

function toPreview(
  tenantId: string,
  facts: StoreDeletionFacts,
  blockers: readonly StoreDeletionBlocker[],
  evaluatedAt: Date,
): StoreDeletionPreview {
  return {
    store: facts.store,
    openShifts: facts.openShifts.map((s) => ({
      shiftId: s.shiftId,
      openedAt: s.openedAt.toISOString(),
      terminalLabel: s.terminalLabel,
      forceCloseEligible: s.forceCloseEligible === true,
    })),
    devices: facts.devices.map((d) => ({
      deviceId: d.deviceId,
      label: d.label,
      trustState: d.trustState,
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
      queue: d.queue,
    })),
    openCountSessions: facts.openCountSessions.map((c) => ({ sessionId: c.sessionId, status: c.status })),
    warehouseMappings: facts.warehouseMappings.map((warehouseRef) => ({ warehouseRef })),
    singleStoreMembers: facts.singleStoreMembers.map((m) => ({ userId: m.userId, roleCode: m.roleCode })),
    offersRebuiltCount: facts.offersRebuiltCount,
    effects: { willChange: WILL_CHANGE, willNotChange: WILL_NOT_CHANGE },
    blockers,
    canDelete: blockers.length === 0,
    reversible: false,
    reversibleAlternative: "suspend_store",
    caveats: CAVEATS,
    previewFingerprint: storeDeletionFingerprint(tenantId, facts),
    evaluatedAt: evaluatedAt.toISOString(),
  };
}

async function transactionNow(client: PoolClient): Promise<Date> {
  const r = await client.query<{ now: Date }>("SELECT now() AS now");
  return r.rows[0]?.now ?? new Date();
}

@Injectable()
export class StoreDeletionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly stores: StoresRepository,
    private readonly grants: ReauthGrantStore,
  ) {}

  /** `previewStoreDeletion`: read-only, no lock. A deleted, unknown or other tenant's store is the 404. */
  async preview(tenantId: string, storeId: string): Promise<StoreDeletionPreview> {
    return await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const store = await this.stores.findById(client, storeId);
      if (!store) throw storeNotFound();
      const facts = await readStoreDeletionFacts(client, factsStoreOf(store), store.tenantId);
      return toPreview(tenantId, facts, evaluateStoreDeletionBlockers(facts), await transactionNow(client));
    });
  }

  /** `consoleDeleteStore`: the guarded, audited, irreversible deletion. */
  async delete(input: ConsoleDeleteInput): Promise<{ storeId: string; deletedAt: string }> {
    const binding: ReauthBinding = {
      sessionId: input.sessionId,
      userId: input.userId,
      tenantId: input.tenantId,
      storeId: input.storeId,
      purpose: "store_deletion",
    };
    return await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      // RT-1484 (spec 042 §8): a Store deletion is a lifecycle write; the pricing publish lock first.
      await lockPricingPublish(client, input.tenantId);
      const store = await this.stores.findByIdForUpdate(client, input.storeId);
      if (!store) throw storeNotFound();
      if (!(await this.grants.peek(input.reauthToken, binding))) throw reauthRequired();

      const facts = await readStoreDeletionFacts(client, factsStoreOf(store), store.tenantId, { withEligibility: false });
      const blockers = evaluateStoreDeletionBlockers(facts);
      if (blockers.length > 0) throw storeDeletionBlocked(blockers);
      if (storeDeletionFingerprint(input.tenantId, facts) !== input.previewFingerprint) throw previewStale();

      await enforceForceActionCap(client, input.tenantId);

      const deletedAt = await deleteStoreWithAudit(client, this.stores, input.tenantId, facts, {
        channel: "console",
        actorUserId: input.userId,
        actorRole: input.actor.role,
        actor: input.actor,
        requestId: input.requestId,
        reason: input.reason,
        previewFingerprint: input.previewFingerprint,
      });
      // The grant is spent LAST: a failure of the SQL above leaves it valid for the retry, and a lost
      // race for it (a concurrent use) rolls the whole transaction back. Redis is not part of the
      // database commit, so a failure of the commit itself still spends it (fail closed).
      if (!(await this.grants.consume(input.reauthToken, binding))) throw reauthRequired();
      return { storeId: input.storeId, deletedAt: deletedAt.toISOString() };
    });
  }
}
