/**
 * RT-1034 — `SyncFailureAlertProcessor`: the per-tenant scheduled sweep behind the sync-failure
 * email alert (Automation V1 PoC, RT-1033 D2).
 *
 * Per tick, for every tenant:
 *   1. read the existing failure state (`erpnext_posting_status = permanently_rejected`,
 *      `sales.sync_status = failed-needs-repair`), read-only, grouped by store and condition;
 *   2. reconcile alert windows: a new condition opens a window (`fired`), a present one is
 *      refreshed, a cleared one is closed so it re-arms;
 *   3. for each open window, resolve recipients (owner / tenant_admin, plus a store_manager with a
 *      `store_access` row for the store), claim one delivery per (window, recipient) BEFORE the
 *      provider call, re-check the recipient's authorization at send time, then send through the
 *      `EmailAdapter` seam and record `delivered` or `failed`.
 *
 * An already-claimed delivery is `suppressed`: 100 redeliveries of one open condition send one
 * email per recipient. A provider failure marks the delivery `failed` and the job fails with
 * `SyncFailureAlertIncompleteError`, so BullMQ retries with backoff (shared DEFAULT_JOB_OPTIONS),
 * the failed set is the DLQ and the worker's `failed` listener reports the final failure to Sentry.
 * A retry re-claims only `failed` deliveries, so a recovery never duplicates a delivered one.
 *
 * Nothing here retries, repairs or changes posting or reconciliation: the sweep only reads them.
 * The alert is OFF unless `SYNC_FAILURE_ALERT_ENABLED=true`. Logs carry ids and error classes,
 * never an address, a body or an error message.
 */
import { z } from "zod";

import { errorClassName, errorFields } from "../common/error-class-name";
import type {
  AlertRecipient,
  OpenWindow,
  SyncFailureAlertRepository,
} from "./sync-failure-alert.repository";
import { type AlertEmail, renderSyncFailureAlertEmail } from "./sync-failure-alert.template";

/**
 * The seam to the worker's `EmailAdapter` (`apps/worker/src/email/`), declared structurally so this
 * module does not import `email/` or `observability/` (import-cycle ratchet, RT-1454). The module
 * wiring passes the real adapter and the real metric recorder.
 */
export interface AlertEmailSender {
  send(message: AlertEmail): Promise<void>;
}

type SyncFailureAlertOutcome = "fired" | "suppressed" | "delivered" | "failed";
export type SyncFailureAlertRecorder = (outcome: SyncFailureAlertOutcome) => void;

/** A provider error's class name when it is identifier-like, else a fixed label. Never the message. */
function safeErrorClass(err: unknown): string {
  const name = errorClassName(err);
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "UnknownError";
}

/** BullMQ job (and job-scheduler) name; the queue name itself. Pinned by the scheduler spec. */
export const SYNC_FAILURE_ALERT_JOB_NAME = "sync-failure-alert-sweep";

const SweepJobSchema = z.object({}).passthrough();

export type SyncFailureAlertLogLine = Readonly<Record<string, string | number>>;
export type SyncFailureAlertLog = (line: SyncFailureAlertLogLine) => void;

const COMPONENT = "sync-failure-alert.sweep";

function writeStderr(line: SyncFailureAlertLogLine): void {
  process.stderr.write(JSON.stringify(line) + "\n");
}

export interface SyncFailureAlertResult {
  readonly enabled: boolean;
  readonly tenants: number;
  readonly fired: number;
  readonly suppressed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly cleared: number;
  readonly failedTenants: number;
}

export class UnknownSyncFailureAlertJobError extends Error {
  constructor(name: string) {
    super(`Unknown sync-failure-alert job name: '${name}'`);
    this.name = "UnknownSyncFailureAlertJobError";
  }
}

export class MalformedSyncFailureAlertJobError extends Error {
  constructor() {
    super("Malformed sync-failure-alert job: payload must be an object");
    this.name = "MalformedSyncFailureAlertJobError";
  }
}

export class SyncFailureAlertIncompleteError extends Error {
  constructor(result: SyncFailureAlertResult) {
    super(
      `sync failure alert sweep incomplete: ${result.failed} delivery(ies) failed, ` +
        `${result.failedTenants} tenant(s) failed`,
    );
    this.name = "SyncFailureAlertIncompleteError";
  }
}

class Tally {
  constructor(private readonly record: SyncFailureAlertRecorder) {}

  fired = 0;
  suppressed = 0;
  delivered = 0;
  failed = 0;
  cleared = 0;
  tenants = 0;
  failedTenants = 0;
  /** Provider failures: a retry could still send, so they fail the job. */
  retryable = 0;

  note(outcome: SyncFailureAlertOutcome): void {
    this[outcome] += 1;
    this.record(outcome);
  }

  result(enabled: boolean): SyncFailureAlertResult {
    return {
      enabled,
      tenants: this.tenants,
      fired: this.fired,
      suppressed: this.suppressed,
      delivered: this.delivered,
      failed: this.failed,
      cleared: this.cleared,
      failedTenants: this.failedTenants,
    };
  }
}

type DeliveryResult = "delivered" | "failed" | "suppressed";

export class SyncFailureAlertProcessor {
  constructor(
    private readonly repo: SyncFailureAlertRepository,
    private readonly adapter: AlertEmailSender,
    private readonly enabled: boolean,
    private readonly record: SyncFailureAlertRecorder = () => undefined,
    private readonly clock: () => Date = () => new Date(),
    private readonly log: SyncFailureAlertLog = writeStderr,
  ) {}

  async process(jobName: string, data: unknown): Promise<SyncFailureAlertResult> {
    if (jobName !== SYNC_FAILURE_ALERT_JOB_NAME) throw new UnknownSyncFailureAlertJobError(jobName);
    if (!SweepJobSchema.safeParse(data).success) throw new MalformedSyncFailureAlertJobError();

    const tally = new Tally(this.record);
    if (!this.enabled) return tally.result(false);

    for (const tenantId of await this.repo.listTenantIds()) {
      tally.tenants += 1;
      await this.sweepTenantSafely(tenantId, tally);
    }
    const result = tally.result(true);
    const incomplete = tally.retryable > 0 || tally.failedTenants > 0;
    this.log({
      level: incomplete ? "warn" : "info",
      component: COMPONENT,
      message: "sweep_complete",
      tenants: result.tenants,
      fired: result.fired,
      suppressed: result.suppressed,
      delivered: result.delivered,
      failed: result.failed,
      cleared: result.cleared,
      failed_tenants: result.failedTenants,
    });
    if (incomplete) throw new SyncFailureAlertIncompleteError(result);
    return result;
  }

  private async sweepTenantSafely(tenantId: string, tally: Tally): Promise<void> {
    try {
      await this.sweepTenant(tenantId, tally);
    } catch (err) {
      tally.failedTenants += 1;
      this.log({
        level: "error",
        component: COMPONENT,
        message: "tenant_sweep_failed",
        tenant_id: tenantId,
        ...errorFields(err),
      });
    }
  }

  private async sweepTenant(tenantId: string, tally: Tally): Promise<void> {
    const observed = await this.repo.observeConditions(tenantId);
    if (observed === null) return; // a suspended or deleted tenant is not alerted
    const { windows, cleared } = await this.repo.reconcileWindows(tenantId, observed, this.clock());
    tally.cleared += cleared;
    for (const window of windows) {
      if (window.justOpened) tally.note("fired");
      await this.notifyWindow(tenantId, window, tally);
    }
  }

  private async notifyWindow(tenantId: string, window: OpenWindow, tally: Tally): Promise<void> {
    const recipients = await this.repo.listRecipients(tenantId, window.storeId);
    let suppressedAny = false;
    for (const recipient of recipients) {
      const result = await this.deliverTo(tenantId, window, recipient, tally);
      suppressedAny = suppressedAny || result === "suppressed";
    }
    if (suppressedAny) await this.repo.recordSuppressed(tenantId, window);
  }

  private async deliverTo(
    tenantId: string,
    window: OpenWindow,
    recipient: AlertRecipient,
    tally: Tally,
  ): Promise<DeliveryResult> {
    const claim = await this.repo.claimDelivery({
      tenantId,
      windowId: window.windowId,
      userId: recipient.userId,
      now: this.clock(),
    });
    if (claim.kind === "exists") {
      tally.note("suppressed");
      return "suppressed";
    }
    const outcome = { tenantId, window, deliveryId: claim.deliveryId };

    // Send-time authorization re-check: the role or store access may have changed since listing.
    const email = await this.repo.authorizedEmail(tenantId, window.storeId, recipient.userId);
    if (email === null) {
      await this.repo.markFailed({ ...outcome, errorClass: "RecipientNotAuthorized", at: this.clock() });
      tally.note("failed");
      return "failed";
    }

    try {
      await this.adapter.send(this.render(email, window));
    } catch (err) {
      const errorClass = safeErrorClass(err);
      await this.repo.markFailed({ ...outcome, errorClass, at: this.clock() });
      tally.note("failed");
      tally.retryable += 1;
      this.log({
        level: "warn",
        component: COMPONENT,
        message: "delivery_failed",
        tenant_id: tenantId,
        window_id: window.windowId,
        ...errorFields(err),
      });
      return "failed";
    }
    await this.repo.markDelivered({ ...outcome, at: this.clock() });
    tally.note("delivered");
    return "delivered";
  }

  private render(to: string, window: OpenWindow): AlertEmail {
    return renderSyncFailureAlertEmail({
      to,
      storeName: window.storeName,
      condition: window.condition,
      failureCount: window.failureCount,
    });
  }
}
