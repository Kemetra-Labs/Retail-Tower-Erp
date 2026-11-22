/**
 * RT-1034 — Postgres side of the sync-failure email alert sweep.
 *
 * READ-ONLY on the failure state. The alert observes `erpnext_posting_status.status =
 * 'permanently_rejected'` and `sales.sync_status = 'failed-needs-repair'` with SELECT only and
 * never writes a posting, reconciliation, repair or sale table (S13). Its own writes are the two
 * alert tables (0130) and `audit_events`.
 *
 * RLS posture (the RT-123 lesson): tenant ids come from the shared `listAllTenantIds` platform
 * read (one site, RT-1389 ratchet); every other statement runs in its own transaction under ONE
 * tenant's GUC (`isPlatformAdmin: false`).
 *
 * Module boundaries (RT-1525): this file's SQL names only its own two tables. Everything else goes
 * through the owning module's worker port, on this transaction's client: the tenant check and the
 * tenant listing (`../tenants`), the failure counts (`../catalog`), the live store names
 * (`../stores`), the recipient rule (`../memberships`), the addresses (`../auth`) and the audit rows
 * (`../audit`).
 *
 * Dedup (S3/S4, AC2): a (window, recipient) delivery row is CLAIMED by an INSERT guarded by the
 * unique key BEFORE the provider is called. A redelivery finds the row and does not send. The
 * only way a row is claimed again is `failed` (the provider threw, so nothing was sent) -> a
 * retry. A row stuck at `claimed` (the process died between claim and outcome) is never re-sent:
 * the design is at-most-once, so a crash can lose one email but never duplicates one.
 *
 * Audit rows use the system actor label and a deterministic id per fact, so a retried write is a
 * no-op (ON CONFLICT DO NOTHING). They carry ids, the condition key and counts: no address, no
 * body, no error message.
 */
import { createHash } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { insertSystemAuditEvent } from "../audit";
import { liveUserEmails } from "../auth";
import { syncFailureCounts, syncFailurePresent } from "../catalog";
import { storeAlertRecipientUserIds } from "../memberships";
import { liveStoreNames } from "../stores";
import { isTenantActive, listAllTenantIds } from "../tenants";
import type { SyncFailureCondition } from "./sync-failure-alert.template";

/** `audit_events.actor_label` of every alert audit row (no human actor). */
export const SYNC_FAILURE_ALERT_ACTOR_LABEL = "system:sync-failure-alert-sweep";

const SYNC_FAILURE_ALERT_AUDIT_ACTIONS = {
  fired: "sync_failure_alert.fired",
  suppressed: "sync_failure_alert.suppressed",
  delivered: "sync_failure_alert.delivered",
  failed: "sync_failure_alert.failed",
  staleClaim: "sync_failure_alert.stale_claim",
} as const;

/** One (store, condition) with open failures, as the sweep observes it. */
export interface ObservedCondition {
  readonly storeId: string;
  readonly storeName: string;
  readonly condition: SyncFailureCondition;
  readonly failureCount: number;
}

/** An OPEN alert window (the condition is still present). */
export interface OpenWindow extends ObservedCondition {
  readonly windowId: string;
  readonly windowSeq: number;
  /** True only on the tick that opened it. */
  readonly justOpened: boolean;
}

export interface ReconcileResult {
  readonly windows: readonly OpenWindow[];
  /** Windows closed because their condition cleared (the condition re-arms). */
  readonly cleared: number;
}

export interface AlertRecipient {
  readonly userId: string;
  readonly email: string;
}

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly deliveryId: string; readonly retry: boolean }
  | { readonly kind: "exists" };

export interface SyncFailureAlertRepository {
  listTenantIds(): Promise<string[]>;
  /**
   * Read-only: every (store, condition) of the tenant with at least one failure, or `null` when
   * the tenant is not active (suspended or deleted): such a tenant is skipped, not alerted.
   */
  observeConditions(tenantId: string): Promise<ObservedCondition[] | null>;
  /** Open a window per new condition, refresh open ones, close cleared ones. */
  reconcileWindows(
    tenantId: string,
    observed: readonly ObservedCondition[],
    now: Date,
  ): Promise<ReconcileResult>;
  /**
   * Owner / tenant_admin, plus a store_manager whose store access covers the store: a
   * `store_access` row for it (`specific`), or tenant-wide access (`all`, the API's
   * `callerStoreScope` "tenant" rule). A store_manager with neither is never alerted.
   */
  listRecipients(tenantId: string, storeId: string): Promise<AlertRecipient[]>;
  /** Claim the (window, recipient) delivery BEFORE the provider call. */
  claimDelivery(input: ClaimInput): Promise<ClaimOutcome>;
  /** Send-time authorization re-check: the recipient's address when still authorized, else null. */
  authorizedEmail(tenantId: string, storeId: string, userId: string): Promise<string | null>;
  markDelivered(input: OutcomeInput & { readonly at: Date }): Promise<void>;
  markFailed(input: OutcomeInput & { readonly errorClass: string; readonly at: Date }): Promise<void>;
  /** One audit row per window for the suppression fact. */
  recordSuppressed(tenantId: string, window: OpenWindow): Promise<void>;
  /**
   * Audit (once per delivery) every delivery still `claimed` after `olderThanMs`: a worker died between
   * the claim and the send. Returns how many were newly recorded, for the metric.
   */
  recordStaleClaims(tenantId: string, now: Date, olderThanMs: number): Promise<number>;
}

export interface ClaimInput {
  readonly tenantId: string;
  readonly windowId: string;
  readonly userId: string;
  readonly now: Date;
}

export interface OutcomeInput {
  readonly tenantId: string;
  readonly window: OpenWindow;
  readonly deliveryId: string;
}

/** A stable UUID-shaped id for one audit fact, so a retried write is a no-op. */
function auditFactId(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Failed attempts of one delivery that get an audit row; later ones are only in the delivery row. */
const FAILED_AUDIT_MAX_ATTEMPTS = 3;

const keyOf = (storeId: string, condition: string): string => `${storeId}|${condition}`;

export class PgSyncFailureAlertRepository implements SyncFailureAlertRepository {
  constructor(private readonly pool: Pool) {}

  listTenantIds(): Promise<string[]> {
    return listAllTenantIds(this.pool);
  }

  /** Run `work` in one transaction under the tenant's own GUC (never platform admin). */
  private inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const context = { tenantId, isPlatformAdmin: false } as const;
    return runWithTenantContext(this.pool, context, (client) => work(client));
  }

  observeConditions(tenantId: string): Promise<ObservedCondition[] | null> {
    return this.inTenant(tenantId, async (client) => {
      if (!(await isTenantActive(client, tenantId))) return null;
      // RT-1525: the failure counts are catalog's and the store names are stores'; a deleted store's
      // failures are dropped here (the counts keep catalog's store-then-condition order).
      const counts = await syncFailureCounts(client, tenantId);
      const names = await liveStoreNames(client, tenantId, [...new Set(counts.map((c) => c.storeId))]);
      return counts.flatMap((c) => {
        const storeName = names.get(c.storeId);
        return storeName === undefined ? [] : [{ storeId: c.storeId, storeName, condition: c.condition, failureCount: c.failureCount }];
      });
    });
  }

  reconcileWindows(
    tenantId: string,
    observed: readonly ObservedCondition[],
    now: Date,
  ): Promise<ReconcileResult> {
    return this.inTenant(tenantId, async (client) => {
      const windows: OpenWindow[] = [];
      for (const o of observed) {
        windows.push(await this.openOrRefresh(client, tenantId, o, now));
      }
      const live = new Set(observed.map((o) => keyOf(o.storeId, o.condition)));
      const cleared = await this.closeCleared(client, tenantId, live, now);
      return { windows, cleared };
    });
  }

  private async openOrRefresh(
    client: PoolClient,
    tenantId: string,
    o: ObservedCondition,
    now: Date,
  ): Promise<OpenWindow> {
    await this.lockCondition(client, tenantId, o.storeId, o.condition);
    const open = await client.query<{ id: string; window_seq: number }>(
      `UPDATE sync_failure_alert_windows
          SET last_seen_at = $4, failure_count = $5
        WHERE tenant_id = $1 AND store_id = $2 AND condition_key = $3 AND cleared_at IS NULL
        RETURNING id, window_seq`,
      [tenantId, o.storeId, o.condition, now, o.failureCount],
    );
    const existing = open.rows[0];
    if (existing) {
      return { ...o, windowId: existing.id, windowSeq: existing.window_seq, justOpened: false };
    }
    const windowId = newId();
    const seq = await client.query<{ window_seq: number }>(
      `INSERT INTO sync_failure_alert_windows
         (id, tenant_id, store_id, condition_key, window_seq, failure_count, opened_at, last_seen_at)
       SELECT $1, $2, $3, $4, COALESCE(max(window_seq), 0) + 1, $5, $6, $6
         FROM sync_failure_alert_windows
        WHERE tenant_id = $2 AND store_id = $3 AND condition_key = $4
       RETURNING window_seq`,
      [windowId, tenantId, o.storeId, o.condition, o.failureCount, now],
    );
    const windowSeq = seq.rows[0]!.window_seq;
    await this.audit(client, {
      id: auditFactId("fired", windowId),
      tenantId,
      storeId: o.storeId,
      action: SYNC_FAILURE_ALERT_AUDIT_ACTIONS.fired,
      targetType: "sync_failure_alert_window",
      targetId: windowId,
      metadata: { condition_key: o.condition, window_seq: windowSeq, failure_count: o.failureCount },
    });
    return { ...o, windowId, windowSeq, justOpened: true };
  }

  /**
   * Close the open windows whose condition is gone. The observation that picked the candidates was
   * taken in an earlier transaction, so a concurrent sweep may have opened or refreshed the window
   * since: each close takes the same advisory lock as `openOrRefresh` and re-reads the condition under
   * it, and closes only when it is still clear.
   */
  private async closeCleared(
    client: PoolClient,
    tenantId: string,
    live: ReadonlySet<string>,
    now: Date,
  ): Promise<number> {
    const open = await client.query<{ id: string; store_id: string; condition_key: SyncFailureCondition }>(
      `SELECT id, store_id, condition_key FROM sync_failure_alert_windows
        WHERE tenant_id = $1 AND cleared_at IS NULL`,
      [tenantId],
    );
    const candidates = open.rows.filter((w) => !live.has(keyOf(w.store_id, w.condition_key)));
    let closed = 0;
    for (const w of candidates) {
      await this.lockCondition(client, tenantId, w.store_id, w.condition_key);
      if (await this.conditionPresent(client, tenantId, w.store_id, w.condition_key)) continue; // back: keep it open
      const r = await client.query(
        `UPDATE sync_failure_alert_windows SET cleared_at = $3
          WHERE tenant_id = $1 AND id = $2 AND cleared_at IS NULL`,
        [tenantId, w.id, now],
      );
      closed += r.rowCount ?? 0;
    }
    return closed;
  }

  /** The condition still holds for a live store (catalog's failure rows, stores' liveness). */
  private async conditionPresent(
    client: PoolClient,
    tenantId: string,
    storeId: string,
    condition: SyncFailureCondition,
  ): Promise<boolean> {
    if (!(await syncFailurePresent(client, tenantId, storeId, condition))) return false;
    return (await liveStoreNames(client, tenantId, [storeId])).has(storeId);
  }

  /** Serialise concurrent sweeps of one (store, condition): the check and the write are atomic. */
  private async lockCondition(
    client: PoolClient,
    tenantId: string,
    storeId: string,
    condition: string,
  ): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('sync-failure-alert:' || $1::text, 0))`, [
      `${tenantId}|${keyOf(storeId, condition)}`,
    ]);
  }

  listRecipients(tenantId: string, storeId: string): Promise<AlertRecipient[]> {
    return this.inTenant(tenantId, async (client) => {
      // RT-1525: the role rule is memberships'; whether the user is live, and the address, are auth's.
      return await liveUserEmails(client, await storeAlertRecipientUserIds(client, tenantId, storeId));
    });
  }

  authorizedEmail(tenantId: string, storeId: string, userId: string): Promise<string | null> {
    return this.inTenant(tenantId, async (client) => {
      const admitted = await storeAlertRecipientUserIds(client, tenantId, storeId, userId);
      return (await liveUserEmails(client, admitted))[0]?.email ?? null;
    });
  }

  claimDelivery(input: ClaimInput): Promise<ClaimOutcome> {
    return this.inTenant(input.tenantId, async (client): Promise<ClaimOutcome> => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO sync_failure_alert_deliveries
           (id, tenant_id, window_id, recipient_user_id, status, attempts, claimed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'claimed', 1, $5, $5)
         ON CONFLICT (window_id, recipient_user_id) DO NOTHING
         RETURNING id`,
        [newId(), input.tenantId, input.windowId, input.userId, input.now],
      );
      if (inserted.rows[0]) return { kind: "claimed", deliveryId: inserted.rows[0].id, retry: false };
      // Only a `failed` row (the provider threw: nothing was sent) may be claimed again.
      const retried = await client.query<{ id: string }>(
        `UPDATE sync_failure_alert_deliveries
            SET status = 'claimed', attempts = attempts + 1, updated_at = $4
          WHERE tenant_id = $1 AND window_id = $2 AND recipient_user_id = $3 AND status = 'failed'
          RETURNING id`,
        [input.tenantId, input.windowId, input.userId, input.now],
      );
      if (retried.rows[0]) return { kind: "claimed", deliveryId: retried.rows[0].id, retry: true };
      return { kind: "exists" };
    });
  }

  markDelivered(input: OutcomeInput & { readonly at: Date }): Promise<void> {
    return this.inTenant(input.tenantId, async (client) => {
      await client.query(
        `UPDATE sync_failure_alert_deliveries
            SET status = 'delivered', delivered_at = $3, updated_at = $3, last_error_class = NULL
          WHERE tenant_id = $1 AND id = $2 AND status = 'claimed'`,
        [input.tenantId, input.deliveryId, input.at],
      );
      await this.audit(client, {
        id: auditFactId("delivered", input.deliveryId),
        tenantId: input.tenantId,
        storeId: input.window.storeId,
        action: SYNC_FAILURE_ALERT_AUDIT_ACTIONS.delivered,
        targetType: "sync_failure_alert_delivery",
        targetId: input.deliveryId,
        metadata: this.windowMetadata(input.window),
      });
    });
  }

  markFailed(input: OutcomeInput & { readonly errorClass: string; readonly at: Date }): Promise<void> {
    return this.inTenant(input.tenantId, async (client) => {
      const r = await client.query<{ attempts: number }>(
        `UPDATE sync_failure_alert_deliveries
            SET status = 'failed', last_error_class = $3, updated_at = $4
          WHERE tenant_id = $1 AND id = $2 AND status = 'claimed'
          RETURNING attempts`,
        [input.tenantId, input.deliveryId, input.errorClass, input.at],
      );
      const row = r.rows[0];
      if (row === undefined) return; // not `claimed` any more: nothing changed, so nothing to audit
      // A provider that stays down fails the same delivery every sweep: audit the first few attempts only.
      if (row.attempts > FAILED_AUDIT_MAX_ATTEMPTS) return;
      await this.audit(client, {
        id: auditFactId("failed", input.deliveryId, String(row.attempts)),
        tenantId: input.tenantId,
        storeId: input.window.storeId,
        action: SYNC_FAILURE_ALERT_AUDIT_ACTIONS.failed,
        targetType: "sync_failure_alert_delivery",
        targetId: input.deliveryId,
        metadata: { ...this.windowMetadata(input.window), attempt: row.attempts, error_class: input.errorClass },
      });
    });
  }

  recordSuppressed(tenantId: string, window: OpenWindow): Promise<void> {
    return this.inTenant(tenantId, (client) =>
      this.audit(client, {
        id: auditFactId("suppressed", window.windowId),
        tenantId,
        storeId: window.storeId,
        action: SYNC_FAILURE_ALERT_AUDIT_ACTIONS.suppressed,
        targetType: "sync_failure_alert_window",
        targetId: window.windowId,
        metadata: this.windowMetadata(window),
      }).then(() => undefined),
    );
  }

  recordStaleClaims(tenantId: string, now: Date, olderThanMs: number): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanMs);
    return this.inTenant(tenantId, async (client) => {
      const stale = await client.query<{
        id: string;
        store_id: string;
        condition_key: string;
        window_seq: number;
        failure_count: number;
      }>(
        `SELECT d.id, w.store_id, w.condition_key, w.window_seq, w.failure_count
           FROM sync_failure_alert_deliveries d
           JOIN sync_failure_alert_windows w ON w.tenant_id = d.tenant_id AND w.id = d.window_id
          WHERE d.tenant_id = $1 AND d.status = 'claimed' AND d.claimed_at < $2
          ORDER BY d.id`,
        [tenantId, cutoff],
      );
      let recorded = 0;
      for (const d of stale.rows) {
        recorded += await this.audit(client, {
          id: auditFactId("stale_claim", d.id),
          tenantId,
          storeId: d.store_id,
          action: SYNC_FAILURE_ALERT_AUDIT_ACTIONS.staleClaim,
          targetType: "sync_failure_alert_delivery",
          targetId: d.id,
          metadata: { condition_key: d.condition_key, window_seq: d.window_seq, failure_count: d.failure_count },
        });
      }
      return recorded;
    });
  }

  private windowMetadata(w: OpenWindow): Record<string, unknown> {
    return { condition_key: w.condition, window_seq: w.windowSeq, failure_count: w.failureCount };
  }

  private async audit(
    client: PoolClient,
    row: {
      id: string;
      tenantId: string;
      storeId: string;
      action: string;
      targetType: string;
      targetId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<number> {
    // RT-1525: the row is audit's to write (same statement, same deterministic id).
    return await insertSystemAuditEvent(client, { ...row, actorLabel: SYNC_FAILURE_ALERT_ACTOR_LABEL });
  }
}

/** No-DB path (dev / CI without DATABASE_URL): nothing to sweep. */
export class NoOpSyncFailureAlertRepository implements SyncFailureAlertRepository {
  listTenantIds(): Promise<string[]> {
    return Promise.resolve([]);
  }
  observeConditions(): Promise<ObservedCondition[] | null> {
    return this.unavailable("observeConditions");
  }
  reconcileWindows(): Promise<ReconcileResult> {
    return this.unavailable("reconcileWindows");
  }
  listRecipients(): Promise<AlertRecipient[]> {
    return this.unavailable("listRecipients");
  }
  claimDelivery(): Promise<ClaimOutcome> {
    return this.unavailable("claimDelivery");
  }
  authorizedEmail(): Promise<string | null> {
    return this.unavailable("authorizedEmail");
  }
  markDelivered(): Promise<void> {
    return this.unavailable("markDelivered");
  }
  markFailed(): Promise<void> {
    return this.unavailable("markFailed");
  }
  recordSuppressed(): Promise<void> {
    return this.unavailable("recordSuppressed");
  }
  recordStaleClaims(): Promise<number> {
    return this.unavailable("recordStaleClaims");
  }
  private unavailable<T>(method: string): Promise<T> {
    return Promise.reject(new Error(`NoOpSyncFailureAlertRepository.${method}: no database configured`));
  }
}
