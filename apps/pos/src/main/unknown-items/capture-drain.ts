/**
 * RT-1490 — one drain of the unknown-item capture queue.
 *
 * Reads the operator envelope once per drain: with no envelope (no operator
 * signed in) or no pairing, nothing is sent and every row stays queued. Then
 * each due row of the current pairing goes, in order:
 *
 *   accepted (2xx)    → sent
 *   refused (final)   → refused; never resent
 *   retry             → stays pending; attempts + 1, next attempt after the
 *                       audit-sync backoff (5 s doubling, capped at 5 min); the
 *                       drain stops, so a failing server gets one request per tick
 *   unauthorized      → the drain stops and no row is touched: the envelope is
 *                       at fault, not the row (it goes with the next good one)
 *   unreachable       → the drain stops at once and the row is untouched:
 *                       offline costs one attempt, and the scheduler backs off
 *
 * A resend always carries the row's own key, so Backend-Core replays the first
 * answer (`Idempotent-Replayed`). A stop latched while a send is in flight
 * writes nothing more (the DB handle may be closing), as the audit sync.
 *
 * The outcome kinds are the audit-sync scheduler's (`scheduleAuditSync`
 * backs off on `undelivered` and `retry`).
 */
import { backoffDelay, type AuditSyncBackoffPolicy } from '../audit/schedule-audit-sync.js';
import type { UnknownItemCaptureClient } from './capture-client.js';
import type { CaptureScope, UnknownItemCaptureStore } from './capture-store.js';

/** Rows sent per drain; the rest wait for the next tick. */
const CAPTURE_DRAIN_BATCH_LIMIT = 20;

export type CaptureDrainOutcome = { readonly kind: 'idle' | 'progress' | 'retry' | 'undelivered' };

export interface CaptureDrainDeps {
  readonly store: UnknownItemCaptureStore;
  readonly client: UnknownItemCaptureClient;
  /** The current pairing's scope, or null when unpaired. */
  readonly scope: () => CaptureScope | null;
  /** The current operator envelope, or null with no operator session. */
  readonly getEnvelope: () => string | null;
  readonly now: () => Date;
  readonly isStopped: () => boolean;
  readonly backoff: AuditSyncBackoffPolicy;
  readonly batchLimit?: number;
  /** Diagnostics for a row refused for good (key and status only). */
  readonly onRefused?: (captureId: string, status: number) => void;
}

export async function drainUnknownItemCaptures(
  deps: CaptureDrainDeps,
): Promise<CaptureDrainOutcome> {
  const scope = deps.scope();
  const envelope = deps.getEnvelope();
  if (scope === null || envelope === null || envelope.length === 0) return { kind: 'idle' };

  const rows = deps.store.listDue(
    scope,
    deps.now().toISOString(),
    deps.batchLimit ?? CAPTURE_DRAIN_BATCH_LIMIT,
  );
  if (rows.length === 0) return { kind: 'idle' };

  for (const row of rows) {
    if (deps.isStopped()) break;
    const outcome = await deps.client.send({
      captureId: row.capture_id,
      barcode: row.barcode,
      envelope,
    });
    if (deps.isStopped()) break;
    const at = deps.now();
    switch (outcome.kind) {
      case 'unreachable':
        return { kind: 'undelivered' };
      case 'unauthorized':
        return { kind: 'retry' };
      case 'accepted':
        deps.store.markSent(row.capture_id, outcome.status, at.toISOString());
        break;
      case 'refused':
        deps.store.markRefused(row.capture_id, outcome.status, at.toISOString());
        deps.onRefused?.(row.capture_id, outcome.status);
        break;
      case 'retry': {
        const delay = backoffDelay(deps.backoff, row.attempts + 1);
        deps.store.markRetry(
          row.capture_id,
          outcome.status,
          new Date(at.getTime() + delay).toISOString(),
        );
        return { kind: 'retry' };
      }
    }
  }
  return { kind: 'progress' };
}
