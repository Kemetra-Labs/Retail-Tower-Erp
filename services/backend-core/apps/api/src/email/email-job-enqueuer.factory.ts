/**
 * Wiring of the `EMAIL_JOB_ENQUEUER` provider (RT-1466: moved from `auth/auth.module.ts` to the
 * `email` module, which the worker's `apps/worker/src/email` consumer already belongs to).
 */
import { Queue, type JobsOptions } from "bullmq";

import { QUEUE_NAMES, requireRedisUrl } from "@data-pulse-2/shared";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { type EmailJobEnqueuer, NoOpEmailJobEnqueuer } from "./email-job.enqueuer";
import { EmailQueueProducer } from "./email-queue.producer";

/** Name of the BullMQ queue both the producer and the worker bind to. */
export const EMAIL_QUEUE_NAME = QUEUE_NAMES.email;

/**
 * Factory for the `EMAIL_JOB_ENQUEUER` provider. Extracted so a
 * focused unit test can verify the BullMQ `Queue` is constructed with
 * `defaultJobOptions: DEFAULT_JOB_OPTIONS` (T301-partial wiring),
 * mirroring the symmetric extraction `workerFactoryProviderFactory`
 * on the worker side.
 *
 * Lazy-init contract
 * ------------------
 * The factory returns the producer WITHOUT constructing the underlying
 * BullMQ `Queue`. Construction happens on first `enqueuePasswordReset` /
 * `enqueueEmailVerification` / `enqueueInvitation` call (see
 * `EmailQueueProducer`'s lazy-mode constructor + `ensureQueue()`).
 * This means an `overrideProvider(EMAIL_JOB_ENQUEUER).useValue(spy)`
 * orphans the factory-returned producer cleanly -- with eager
 * construction the orphaned producer kept its BullMQ Queue alive and
 * Jest reported "worker process has failed to exit gracefully" at
 * suite teardown (PR #240 db-integration leak). See the full rationale
 * on `auditJobEnqueuerFactory` in `audit-enqueuer.module.ts`.
 *
 * Production wiring policy:
 *   - `NODE_ENV=production` + `REDIS_URL` missing → throw at boot.
 *     Silently dropping password-reset / email-verify jobs is a
 *     safety hazard.
 *   - non-production + `REDIS_URL` missing → fall back to
 *     `NoOpEmailJobEnqueuer` so dev / CI machines without Redis still
 *     boot.
 *   - `REDIS_URL` set → return an `EmailQueueProducer` whose lazy
 *     thunk will build the `Queue` with the shared default job
 *     options on first enqueue.
 *
 * The `component: "AuthModule"` label is kept as it was before RT-1466: specs and operator
 * runbooks pin the `<component>: REDIS_URL is required in production` message prefix.
 */
export function emailJobEnqueuerFactory(): EmailJobEnqueuer {
  const url = requireRedisUrl({
    component: "AuthModule",
    reason: "EmailQueueProducer cannot be wired without it",
  });
  if (url === null) {
    return new NoOpEmailJobEnqueuer();
  }
  // Defer Queue construction to first use. The thunk captures `url`
  // so production wiring is preserved at steady state.
  const provider = () =>
    new Queue(EMAIL_QUEUE_NAME, {
      connection: { url },
      defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
    });
  return new EmailQueueProducer(provider);
}
