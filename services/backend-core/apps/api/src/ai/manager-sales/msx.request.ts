/**
 * RT-1539 — the strict request of `POST /api/v1/ai/manager-sales/explain` (contract
 * `ManagerSalesExplainRequest`). Unknown keys (a smuggled `tenant_id` included) are a 400, as on the
 * sales reads; the tenant comes only from the session. The span rule the JSON Schema cannot express
 * (`to >= from`, `to - from <= 30`) is the sales reads' own `refineBusinessRange`, never truncated.
 */
import { z } from "zod";

import { BusinessDateSchema, refineBusinessRange } from "../../console-sales";
import { MSX_CURRENCY_TEMPLATES, MSX_TEMPLATE_IDS } from "./msx.constants";

const QUESTION_MAX = 500;
const STORE_IDS_MAX = 500;

export const ManagerSalesExplainRequestSchema = z
  .object({
    templateId: z.enum(MSX_TEMPLATE_IDS).optional(),
    question: z.string().min(1).max(QUESTION_MAX).optional(),
    storeIds: z
      .array(z.string().uuid().transform((id) => id.toLowerCase()))
      .max(STORE_IDS_MAX)
      .refine((ids) => new Set(ids).size === ids.length, "storeIds must be unique"),
    from: BusinessDateSchema,
    to: BusinessDateSchema,
    currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO-4217 code in upper case").optional(),
    compare: z.enum(["previous_period", "none"]).optional(),
    locale: z.enum(["ar", "en"]),
  })
  .strict()
  .superRefine(refineBusinessRange)
  .superRefine((request, ctx) => {
    if (request.templateId === undefined && request.question === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["templateId"], message: "templateId or question is required" });
    }
    if (
      request.templateId !== undefined &&
      MSX_CURRENCY_TEMPLATES.includes(request.templateId) &&
      request.currency === undefined
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currency"], message: `currency is required for ${request.templateId}` });
    }
  });

export type ManagerSalesExplainRequest = z.infer<typeof ManagerSalesExplainRequestSchema>;
