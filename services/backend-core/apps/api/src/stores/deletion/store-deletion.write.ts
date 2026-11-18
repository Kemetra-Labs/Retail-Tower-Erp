/**
 * The store deletion write — RT-1439. One function for every deletion path (`consoleDeleteStore`
 * and the legacy `softDeleteStore`), run on the caller's tenant-scoped transaction with the store
 * row already locked `FOR UPDATE` and its blockers already evaluated:
 *
 *   soft delete (`deleted_at = now()`) -> rebuild the offers' packs (RT-1337) -> ONE
 *   `store.deleted` audit row, in the same transaction, so a deletion and its record commit or
 *   roll back together. Irreversible (D7a): no supported operation restores the store.
 *
 * The audit metadata (`stores.openapi.yaml`, "Audit"): `channel` (`console` | `api`),
 * `actor_role`, `reason` (null on the `api` path), `preview_fingerprint` (null on the `api`
 * path), `before` (name, code, is_active, device_count, open_shift_count) and `after`
 * (deleted_at). RT-1462: a Console deletion also carries `actor_kind` and `on_behalf_of`
 * (`force-action-actor.ts`). The reason is stored here and never written to an application log.
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

import { auditFieldsOf, type ForceActionAuditActor } from "../../common/force-action-actor";
import { rebuildOfferPackForStoreChange } from "../../offers/offer-pack.rebuild";
import { storeNotFound } from "./store-deletion.errors";
import type { StoreDeletionFacts } from "./store-deletion.facts";
import type { StoresRepository } from "../stores.repository";

const STORE_DELETED_ACTION = "store.deleted";

export interface StoreDeletionAudit {
  readonly channel: "console" | "api";
  readonly actorUserId: string | null;
  readonly actorRole: string | null;
  /** The Console actor (RT-1462); absent on the `api` path. */
  readonly actor?: ForceActionAuditActor;
  readonly requestId: string | null;
  readonly reason: string | null;
  readonly previewFingerprint: string | null;
}

/** Soft-delete the store and write its audit row; returns the `deleted_at` the database stamped. */
export async function deleteStoreWithAudit(
  client: PoolClient,
  repo: StoresRepository,
  tenantId: string,
  facts: StoreDeletionFacts,
  audit: StoreDeletionAudit,
): Promise<Date> {
  const storeId = facts.store.storeId;
  const deletedAt = await repo.markDeleted(client, storeId);
  if (deletedAt === null) throw storeNotFound();
  // RT-1337: a deleted store leaves every offer's Pack.
  await rebuildOfferPackForStoreChange(client, tenantId);
  const metadata = {
    store_id: storeId,
    channel: audit.channel,
    actor_role: audit.actorRole,
    ...(audit.actor === undefined ? {} : auditFieldsOf(audit.actor)),
    reason: audit.reason,
    preview_fingerprint: audit.previewFingerprint,
    before: {
      name: facts.store.name,
      code: facts.store.code,
      is_active: facts.store.isActive,
      // Exact totals: the lists are capped for the preview.
      device_count: facts.counts.totalDevices,
      open_shift_count: facts.counts.openShifts,
    },
    after: { deleted_at: deletedAt.toISOString() },
  };
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, 'store', $4, $6, $7::jsonb)`,
    [newId(), audit.actorUserId, tenantId, storeId, STORE_DELETED_ACTION, audit.requestId, JSON.stringify(metadata)],
  );
  return deletedAt;
}
