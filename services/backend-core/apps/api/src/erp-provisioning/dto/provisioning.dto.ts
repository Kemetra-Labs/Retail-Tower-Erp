/**
 * RT-1358 — strict zod boundaries and response projections of
 * `provisioning-feed.yaml`. Unknown keys are refused; tenant, actor and lease are
 * never body fields. Response bodies are explicit projections, never rows.
 */
import { z } from "zod";

import { STEP_NAMES, STEP_OUTCOMES } from "../provisioning-state";

const ERROR_CLASSES = ["failed_transient", "permanently_rejected", "conflict", "capacity", "compatibility", "dependency"] as const;

export const StepAckBodySchema = z
  .object({
    step: z.enum(STEP_NAMES),
    outcome: z.enum(STEP_OUTCOMES),
    attempt: z.number().int().min(1).max(1_000_000),
    errorClass: z.enum(ERROR_CLASSES).optional(),
    reason: z.string().min(1).max(200).optional(),
    detail: z.string().max(1000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.outcome === "done") {
      if (v.errorClass !== undefined || v.reason !== undefined) {
        ctx.addIssue({ code: "custom", message: "done carries no errorClass or reason" });
      }
      return;
    }
    if (v.errorClass !== v.outcome) ctx.addIssue({ code: "custom", message: "errorClass must equal the outcome" });
    if (v.outcome === "permanently_rejected" && v.reason === undefined) {
      ctx.addIssue({ code: "custom", message: "permanently_rejected needs a reason" });
    }
  });
export type StepAckBody = z.infer<typeof StepAckBodySchema>;

const ResultStoreSchema = z
  .object({ storeId: z.string().uuid(), warehouseRef: z.string().min(1).max(140), customerRef: z.string().min(1).max(140) })
  .strict();

export const OutcomeBodySchema = z
  .object({
    outcome: z.enum(["succeeded", "permanently_rejected", "conflict"]),
    reason: z.string().min(1).max(200).optional(),
    result: z
      .object({
        siteName: z.string().min(1).max(128),
        companyRef: z.string().min(1).max(140),
        templateVersion: z.number().int().min(1),
        erpnextVersion: z.string().max(32).optional(),
        frappeVersion: z.string().max(32).optional(),
        connectorVersion: z.string().max(32).optional(),
        fiscalReadiness: z.literal("not_assessed"),
        stores: z.array(ResultStoreSchema).max(500),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.outcome === "succeeded") {
      if (v.result === undefined) ctx.addIssue({ code: "custom", message: "succeeded needs a result" });
      if (v.reason !== undefined) ctx.addIssue({ code: "custom", message: "succeeded carries no reason" });
    } else {
      if (v.reason === undefined) ctx.addIssue({ code: "custom", message: "a failed outcome needs a reason" });
      if (v.result !== undefined) ctx.addIssue({ code: "custom", message: "a failed outcome carries no result" });
    }
  });
export type OutcomeBody = z.infer<typeof OutcomeBodySchema>;

export const PullQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type PullQuery = z.infer<typeof PullQuerySchema>;

export const HostLabelSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
export const IssueProvisionerCredentialBodySchema = z.object({ hostLabel: HostLabelSchema }).strict();

export interface ProvisioningRequestItem {
  readonly provisioningRequestId: string;
  readonly kind: string;
  readonly tenantId: string;
  readonly generation: number;
  readonly siteName: string;
  readonly template: { readonly templateId: string; readonly templateVersion: number };
  readonly locale: { readonly country: string; readonly currency: string; readonly timezone: string; readonly language: string };
  readonly legalName?: string;
  readonly connectorRegistrationId: string;
  readonly environment: string;
  readonly attemptFloor: number;
  readonly notBefore?: string;
  readonly stores: ReadonlyArray<{ readonly storeId: string; readonly displayName: string }>;
}
