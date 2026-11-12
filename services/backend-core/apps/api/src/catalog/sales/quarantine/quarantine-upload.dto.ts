/**
 * RT-1312 Phase 3(b): the `posQuarantineSale` request body
 * (`pos-sales/sale-quarantine.yaml` 1.0.0-draft, `QuarantineSaleUpload`).
 *
 * Closed: an unknown key, or any identity or server-owned key (tenant, store,
 * device, received time), is 400 `validation_error` and nothing is stored. The
 * rules between `reason.kind`, `httpStatus` and `previousTerminalId` are the
 * contract's. `saleBody` must be a JSON object, and its own `sourceSystem` and
 * `externalId`, when present as strings, must equal the upload's; nothing else
 * in it is validated (capture rules apply only at a Console repair).
 */
import { z } from "zod";

const QUARANTINE_REASON_KINDS = [
  "refused",
  "payload_divergence",
  "cashier_claim_refused",
  "held_previous_pairing",
] as const;

/** Retried by the till, never a refusal (contract `QuarantineReason.httpStatus`). */
const NOT_A_REFUSAL = new Set([401, 425, 429]);

const ErrorCodeLabel = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .nullable();

const QuarantineReasonSchema = z
  .object({
    kind: z.enum(QUARANTINE_REASON_KINDS),
    httpStatus: z
      .number()
      .int()
      .min(400)
      .max(499)
      .refine((s) => !NOT_A_REFUSAL.has(s), { message: "not a refusal status" })
      .nullable(),
    errorCode: ErrorCodeLabel,
  })
  .strict()
  .superRefine((reason, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (reason.kind === "held_previous_pairing" && (reason.httpStatus !== null || reason.errorCode !== null)) {
      issue("a held sale carries no status or code");
    }
    if (reason.kind === "payload_divergence" && reason.httpStatus !== null && reason.httpStatus !== 409) {
      issue("a payload divergence is a 409");
    }
    if (reason.kind === "cashier_claim_refused" && reason.httpStatus !== null && reason.httpStatus !== 403) {
      issue("a cashier claim refusal is a 403");
    }
  });

/** A JSON object (not an array, not null). */
const JsonObject = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  { message: "saleBody must be a JSON object" },
);

export const QuarantineSaleUploadSchema = z
  .object({
    sourceSystem: z.string().min(1).max(100),
    externalId: z.string().min(1).max(200),
    idempotencyKey: z.string().regex(/^[\x21-\x7E]{16,128}$/),
    reason: QuarantineReasonSchema,
    tillRecordedAt: z.string().datetime({ offset: true }),
    previousTerminalId: z.string().uuid().nullable().optional(),
    saleBody: JsonObject,
  })
  .strict()
  .superRefine((upload, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (upload.reason.kind === "held_previous_pairing" && (upload.previousTerminalId ?? null) === null) {
      issue("a held sale names its earlier pairing");
    }
    const { sourceSystem, externalId } = upload.saleBody;
    if (typeof sourceSystem === "string" && sourceSystem !== upload.sourceSystem) {
      issue("saleBody.sourceSystem differs from the upload's");
    }
    if (typeof externalId === "string" && externalId !== upload.externalId) {
      issue("saleBody.externalId differs from the upload's");
    }
  });

export type QuarantineSaleUpload = z.infer<typeof QuarantineSaleUploadSchema>;

/** `QuarantineReceipt`: what the till learns from an upload. */
export interface QuarantineReceipt {
  readonly quarantineRef: string;
  readonly state: "open" | "captured" | "already-captured" | "written-off";
  readonly receivedAt: string;
}
