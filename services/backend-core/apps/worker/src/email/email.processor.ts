/**
 * EmailProcessor — slice 5 (T115).
 *
 * Pure logic. Given `(jobName, data)`, validates the payload, picks a
 * template, and hands the rendered message to the injected
 * `EmailAdapter`. Knows NOTHING about BullMQ runtime, Redis, retry, or
 * provider SDKs.
 *
 * Layered architecture
 * --------------------
 *   Layer A (this file): pure `(jobName, data) -> adapter.send(...)`.
 *   Layer B (deferred):  BullMQ `Worker` bootstrap, Redis connection,
 *                        retry/backoff/DLQ — Phase 2 task T090 and
 *                        Phase 10 task T301.
 *
 * A future `apps/worker/src/main.ts` will wire Layer B by instantiating
 * a BullMQ `Worker` over the `email` queue whose handler calls
 * `emailProcessor.process(job.name, job.data)`. That glue is
 * intentionally NOT in this slice.
 *
 * Job-name contract with `EmailQueueProducer`
 * -------------------------------------------
 * The producer in `apps/api/src/auth/email-queue.producer.ts` writes
 * these exact strings. We re-declare the constants here (rather than
 * cross-importing across apps) and a unit test pins the string
 * literals so any drift fails loudly. A later refactor can move the
 * shared constant to `packages/shared` once a second consumer needs it.
 *
 * Error contracts
 * ---------------
 *   - `MalformedEmailJobError` — payload doesn't match the schema.
 *     Throwing before `adapter.send` means BullMQ retries are wasted
 *     on a poison message; in practice these should land in the DLQ
 *     (T301 will configure that). This processor's job is just to
 *     refuse to act on malformed input.
 *   - `UnknownEmailJobError` — job name we don't recognise. Same DLQ
 *     fate.
 *   - Any other error from `adapter.send` propagates as-is so BullMQ
 *     can retry transport-level failures.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import {
  extractTraceContext,
  context,
  type TraceCarrier,
} from "@data-pulse-2/shared/observability/otel";
import {
  EMAIL_ADAPTER,
  type EmailAdapter,
} from "./email.adapter";
import {
  renderEmailVerificationEmail,
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderSignupLinkEmail,
} from "./templates";
import {
  recordWorkerJobDuration,
  recordWorkerProcessingFailure,
  sanitizeErrorClass,
} from "../observability/metrics/worker.metrics";

// T596: queue-level job_name per signals.md §3 — every email job (password-reset,
// email-verify, invitation) emits with the same bounded queue-level label.
// Sub-job-name granularity is deferred per the approved D1 decision.
const JOB_NAME_EMAIL = "email" as const;

/**
 * BullMQ job names this processor handles. Mirrors `EMAIL_JOB_NAMES`
 * in `apps/api/src/auth/email-queue.producer.ts`. The values MUST
 * match the producer literally — see the unit test.
 */
export const EMAIL_JOB_NAMES = {
  passwordReset: "auth.password-reset",
  emailVerification: "auth.email-verify",
  invitation: "memberships.invitation",
  signupLink: "auth.signup-link",
} as const;

/**
 * Payload schema for auth jobs (password-reset, email-verify). The producer
 * guarantees this shape, but the processor revalidates at the boundary.
 */
const emailJobSchema = z.object({
  email: z.string().email().min(1),
  rawToken: z.string().min(1),
  userId: z.string().min(1),
});

export type EmailJobData = z.infer<typeof emailJobSchema>;

/**
 * Payload schema for invitation jobs. Differs from auth jobs: no userId
 * (invitees may not yet be users), has tenantId for audit.
 */
const invitationJobSchema = z.object({
  email: z.string().email().min(1),
  rawToken: z.string().min(1),
  tenantId: z.string().min(1),
});

export type InvitationJobData = z.infer<typeof invitationJobSchema>;

/**
 * Payload schema for self-signup link jobs (RT-1350 slice 3). The recipient has no
 * account yet, so there is no userId or tenantId; `locale` is the signup form's language.
 */
const signupLinkJobSchema = z.object({
  email: z.string().email().min(1),
  rawToken: z.string().min(1),
  locale: z.enum(["ar", "en"]).nullable(),
});

type SignupLinkJobData = z.infer<typeof signupLinkJobSchema>;

export class MalformedEmailJobError extends Error {
  constructor(jobName: string, issue: string) {
    super(`Malformed email job '${jobName}': ${issue}`);
    this.name = "MalformedEmailJobError";
  }
}

export class UnknownEmailJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown email job name: '${jobName}'`);
    this.name = "UnknownEmailJobError";
  }
}

/**
 * DI token for the Admin Console origin used in invitation links (RT-1280).
 * Bound to `EmailConfig.consoleBaseUrl` (null only outside production).
 */
export const EMAIL_CONSOLE_BASE_URL = "EMAIL_CONSOLE_BASE_URL";

@Injectable()
export class EmailProcessor {
  constructor(
    @Optional()
    @Inject(EMAIL_ADAPTER)
    private readonly adapter: EmailAdapter,
    @Optional()
    @Inject(EMAIL_CONSOLE_BASE_URL)
    private readonly consoleBaseUrl: string | null = null,
  ) {}

  async process(jobName: string, data: unknown): Promise<void> {
    // T596: instrument the processor boundary. Wall-clock duration on every
    // exit (success and failure) feeds worker_job_duration_seconds; the
    // catch branch additionally increments worker_processing_failure_total
    // with the sanitized error class. Behavior is unchanged: thrown errors
    // are rethrown verbatim so BullMQ's existing retry / DLQ semantics
    // continue to apply.
    const startNs = process.hrtime.bigint();
    try {
      const carrier =
        typeof data === "object" && data !== null && "traceContext" in data
          ? ((data as { traceContext?: TraceCarrier }).traceContext ?? {})
          : {};
      const restoredCtx = extractTraceContext(carrier);

      return await context.with(restoredCtx, async () => {
        switch (jobName) {
          case EMAIL_JOB_NAMES.passwordReset: {
            const parsed = parseAuthJobData(jobName, data);
            await this.adapter.send(renderPasswordResetEmail(parsed));
            return;
          }
          case EMAIL_JOB_NAMES.emailVerification: {
            const parsed = parseAuthJobData(jobName, data);
            await this.adapter.send(renderEmailVerificationEmail(parsed));
            return;
          }
          case EMAIL_JOB_NAMES.invitation: {
            const parsed = parseInvitationJobData(jobName, data);
            await this.adapter.send(renderInvitationEmail(parsed, this.consoleBaseUrl ?? null));
            return;
          }
          case EMAIL_JOB_NAMES.signupLink: {
            const parsed = parseSignupLinkJobData(jobName, data);
            await this.adapter.send(renderSignupLinkEmail(parsed, this.consoleBaseUrl ?? null));
            return;
          }
          default:
            throw new UnknownEmailJobError(jobName);
        }
      });
    } catch (err: unknown) {
      const errorClass = sanitizeErrorClass(
        err instanceof Error ? err.constructor.name : null,
      );
      recordWorkerProcessingFailure({
        job_name: JOB_NAME_EMAIL,
        error_class: errorClass,
      });
      throw err;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1_000_000_000;
      recordWorkerJobDuration({ job_name: JOB_NAME_EMAIL }, durationSeconds);
    }
  }
}

function parseAuthJobData(jobName: string, data: unknown): EmailJobData {
  return parseWith(emailJobSchema, jobName, data);
}

function parseInvitationJobData(jobName: string, data: unknown): InvitationJobData {
  return parseWith(invitationJobSchema, jobName, data);
}

function parseSignupLinkJobData(jobName: string, data: unknown): SignupLinkJobData {
  return parseWith(signupLinkJobSchema, jobName, data);
}

/** Validate a payload against `schema`; a failure is a `MalformedEmailJobError` naming only the first issue. */
function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, jobName: string, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const firstIssue = result.error.issues[0];
  throw new MalformedEmailJobError(
    jobName,
    firstIssue ? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}` : "validation failed",
  );
}
