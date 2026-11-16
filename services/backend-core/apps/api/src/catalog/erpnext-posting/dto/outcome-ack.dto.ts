/**
 * outcome-ack.dto.ts — Zod body schema for `connectorAckOutcome`.
 *
 * Mirrors the 012 `OutcomeAckRequest` (strict, O-2):
 *   - `outcome`: posted | failed_transient | permanently_rejected |
 *     reconciliation_required (required; RT-332);
 *   - `documentRef` ({doctype,name}) — REQUIRED iff outcome is posted or
 *     reconciliation_required (the EXISTING document), else absent;
 *   - `reason` ({category,message}) — REQUIRED iff outcome is
 *     permanently_rejected or reconciliation_required;
 *   - `resolutionVersion` — optional echo of the work item's frozen resolution
 *     version (RT-332); a positive integer;
 *   - `etaStatus` accepted + ignored in the interim mode (016 owns it).
 *
 * `.strict()` rejects unknown keys AND any body-supplied tenant/store/actor or
 * server-owned field (§XII mass-assignment ban) → 400 validation_error.
 * Tenant/scope come from the connectorBearer principal, never the body.
 *
 * The conditional-required coupling is enforced via `superRefine`: a `posted`
 * without `documentRef`, or a `permanently_rejected` without `reason`, is a 400
 * (the 012 ValidationFailure: "a missing conditional field").
 */
import { z } from "zod";

const DocumentRefSchema = z
  .object({
    doctype: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
  })
  .strict();

const RejectionReasonSchema = z
  .object({
    category: z.enum([
      "validation",
      "closed_period",
      "unmapped_item",
      "unmapped_account",
      "other",
    ]),
    message: z.string().min(1).max(1000),
  })
  .strict();

const EtaStatusSchema = z
  .object({
    state: z.enum(["submitted", "accepted", "rejected", "pending"]),
    uuid: z.string().min(1).nullish(),
  })
  .strict();

/** RT-1423 (posting-feed.yaml 1.15.0-draft): what the Connector verified for one counted line. */
const CountRefusalSchema = z
  .object({
    code: z.enum([
      "wrong_kind",
      "invalid_shape",
      "chunk_too_large",
      "frozen_datetime_mismatch",
      "unmapped_item",
      "unmapped_bucket",
      "uom_mismatch",
      "tracked_item_unsupported",
      "no_valuation_history",
      "valuation_rate_forbidden",
      "closed_period",
      "back_dated_permission",
      "provenance_conflict",
    ]),
    ackCategory: z.enum(["validation", "closed_period", "unmapped_item", "unmapped_account", "other"]),
    lineSeq: z.number().int().positive().optional(),
    message: z.string().min(1).max(1000),
  })
  .strict();

const QuantityTextSchema = z.string().regex(/^[0-9]{1,13}(\.[0-9]{1,6})?$/);

const CountLineOutcomeSchema = z
  .object({
    lineSeq: z.number().int().positive(),
    result: z.enum(["adjusted", "verified_noop", "rejected"]),
    verifiedQtyAfter: QuantityTextSchema.nullish(),
    refusal: CountRefusalSchema.nullish(),
  })
  .strict()
  .superRefine((line, ctx) => {
    if (line.result === "rejected" && !line.refusal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refusal"], message: "a rejected line carries its refusal" });
    }
    const noQuantity = line.verifiedQtyAfter === undefined || line.verifiedQtyAfter === null;
    if (line.result !== "rejected" && (line.refusal || noQuantity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifiedQtyAfter"],
        message: "an adjusted or no-op line carries verifiedQtyAfter and no refusal",
      });
    }
    if (line.result === "rejected" && !noQuantity) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verifiedQtyAfter"], message: "a rejected line has no verifiedQtyAfter" });
    }
  });

export const OutcomeAckBodySchema = z
  .object({
    outcome: z.enum([
      "posted",
      "failed_transient",
      "permanently_rejected",
      "reconciliation_required",
      "verified_noop",
    ]),
    documentRef: DocumentRefSchema.nullish(),
    reason: RejectionReasonSchema.nullish(),
    etaStatus: EtaStatusSchema.nullish(),
    resolutionVersion: z.number().int().positive().optional(),
    /** RT-1423, `inventory_count` only: per-line evidence (1..100). Required with `verified_noop`. */
    lines: z.array(CountLineOutcomeSchema).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.outcome === "verified_noop") {
      if (!val.lines) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "lines is required when outcome is 'verified_noop'" });
      } else if (val.lines.some((l) => l.result === "adjusted")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "a verified_noop ack carries no adjusted line" });
      }
    }
    const needsDocument =
      val.outcome === "posted" || val.outcome === "reconciliation_required";
    const needsReason =
      val.outcome === "permanently_rejected" ||
      val.outcome === "reconciliation_required";
    if (needsDocument && !val.documentRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentRef"],
        message: `documentRef is required when outcome is '${val.outcome}'`,
      });
    }
    if (needsReason && !val.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `reason is required when outcome is '${val.outcome}'`,
      });
    }
    if (!needsDocument && val.documentRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentRef"],
        message: "documentRef is only valid when outcome is 'posted' or 'reconciliation_required'",
      });
    }
    if (!needsReason && val.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message:
          "reason is only valid when outcome is 'permanently_rejected' or 'reconciliation_required'",
      });
    }
  });

export type OutcomeAckBody = z.infer<typeof OutcomeAckBodySchema>;
