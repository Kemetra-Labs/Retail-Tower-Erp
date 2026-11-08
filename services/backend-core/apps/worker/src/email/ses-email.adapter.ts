/**
 * SesEmailAdapter — RT-1280. The first real `EmailAdapter` (PQ-1: Amazon SES,
 * owner decision on RT-1280, 2026-11-08).
 *
 * Posture:
 *   - one `SendEmail` call per message (SES API v2, simple content, UTF-8);
 *   - no retry here: the SDK is built with `maxAttempts: 1` and BullMQ owns
 *     retry/backoff (see `email.adapter.ts`);
 *   - bounded: each send is aborted after `timeoutMs` (AbortSignal) and the
 *     HTTP handler throws on its own request timeout, so a stalled SES call
 *     fails the job instead of holding it active forever;
 *   - a failure is re-thrown as `EmailDeliveryError` carrying only the SDK
 *     error name and HTTP status. SES messages can quote the recipient
 *     ("identities failed the check ... <address>"), and BullMQ stores the
 *     thrown message as the job's `failedReason`, so the original message
 *     and `cause` are dropped;
 *   - tags are sanitized to SES's allowed characters (letters, digits, `_`,
 *     `-`). They are PII-free by contract (`EmailMessage.tags`).
 *
 * Credentials: see `createSesEmailAdapter`. This class never reads or logs them.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { EmailAdapter, EmailMessage } from "./email.adapter";

/** The single SDK capability this adapter needs, so tests can supply a fake. */
export interface SesSendClient {
  send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export class EmailDeliveryError extends Error {
  constructor(errorName: string, httpStatus: number | null) {
    super(`SES SendEmail failed: ${errorName}${httpStatus === null ? "" : ` (HTTP ${httpStatus})`}`);
    this.name = "EmailDeliveryError";
  }
}

const SES_TAG_MAX = 256;
const DEFAULT_TIMEOUT_MS = 10_000;

function sesTagPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, SES_TAG_MAX);
  return cleaned === "" ? "-" : cleaned;
}

/**
 * The error's name if it is a plain identifier, else `UnknownError`. Read from
 * any object (an abort reason is a DOMException, which is not always
 * `instanceof Error` across realms); the pattern keeps free text out.
 */
function safeErrorName(err: unknown): string {
  const raw = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  const name = typeof raw === "string" ? raw : "";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "UnknownError";
}

function httpStatusOf(err: unknown): number | null {
  const status = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  return typeof status === "number" ? status : null;
}

export class SesEmailAdapter implements EmailAdapter {
  constructor(
    private readonly client: SesSendClient,
    private readonly from: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const command = new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: message.textBody, Charset: "UTF-8" },
            ...(message.htmlBody === undefined
              ? {}
              : { Html: { Data: message.htmlBody, Charset: "UTF-8" } }),
          },
        },
      },
      EmailTags: Object.entries(message.tags ?? {}).map(([name, value]) => ({
        Name: sesTagPart(name),
        Value: sesTagPart(value),
      })),
    });
    try {
      // A stalled call must settle so BullMQ can retry it (never hang a job).
      await this.client.send(command, { abortSignal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err: unknown) {
      throw new EmailDeliveryError(safeErrorName(err), httpStatusOf(err));
    }
  }
}

/**
 * Production factory: a real SES v2 client for the configured region.
 *
 * When `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are both set (the lab
 * and production: the SES-send-only IAM user), they are passed explicitly so
 * the SDK never falls back to another credential source (a shared profile or
 * an instance role with wider permissions). `resolveEmailConfig` requires
 * both in production. The values are read here only and never logged.
 */
export function createSesEmailAdapter(options: {
  readonly region: string;
  readonly from: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}): SesEmailAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const accessKeyId = (env["AWS_ACCESS_KEY_ID"] ?? "").trim();
  const secretAccessKey = (env["AWS_SECRET_ACCESS_KEY"] ?? "").trim();
  const client = new SESv2Client({
    region: options.region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: Math.min(3_000, timeoutMs),
      requestTimeout: timeoutMs,
      // Without this, smithy only logs a warning when requestTimeout fires.
      throwOnRequestTimeout: true,
    },
    ...(accessKeyId !== "" && secretAccessKey !== ""
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
  return new SesEmailAdapter(client, options.from, timeoutMs);
}
