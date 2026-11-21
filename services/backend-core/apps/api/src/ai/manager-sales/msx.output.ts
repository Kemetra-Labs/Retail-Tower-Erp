/**
 * RT-1539 — the strict output schema `manager_sales.answer/1`: exactly the contract's
 * `ManagerSalesAnswer`. The Gateway validates every Tier-0 output against it (a non-strict schema is
 * refused at boot) and checks that every cited ref is in the evidence pack.
 */
import { z } from "zod";

import {
  MSX_DECLINES,
  MSX_GAPS,
  MSX_NOTICES,
  MSX_OPERATIONS,
  MSX_OUTPUT_SCHEMA_ID,
  MSX_TEMPLATES_VERSION,
  MSX_TEMPLATE_IDS,
} from "./msx.constants";

const BusinessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Ref = z.string().min(1).max(256);
const Currency = z.string().regex(/^[A-Z]{3}$/);

const Cell = z.object({ ref: Ref, value: z.union([z.string(), z.number().int()]), currency: Currency.optional() }).strict();

const Statement = z
  .object({ type: z.literal("statement"), key: z.string().min(1), slots: z.record(z.string(), z.object({ ref: Ref }).strict()) })
  .strict();

const Table = z
  .object({
    type: z.literal("table"),
    columns: z.array(z.string().min(1)).min(1),
    rows: z.array(z.array(Cell).min(1)),
  })
  .strict();

export const ManagerSalesAnswerSchema = z
  .object({
    kind: z.literal("answer"),
    templateId: z.enum(MSX_TEMPLATE_IDS),
    templateVersion: z.literal(MSX_TEMPLATES_VERSION),
    outputSchemaId: z.literal(MSX_OUTPUT_SCHEMA_ID),
    scope: z
      .object({ mode: z.enum(["store", "stores", "all_in_scope"]), storeRefs: z.array(z.string().uuid()).max(500) })
      .strict(),
    period: z
      .object({
        from: BusinessDate,
        to: BusinessDate,
        baseline: z.object({ from: BusinessDate, to: BusinessDate, dayCount: z.number().int().min(1).max(31) }).strict().optional(),
      })
      .strict(),
    sources: z
      .array(
        z
          .object({
            operationId: z.enum(MSX_OPERATIONS),
            contractVersion: z.string().min(1),
            asOf: z.string().datetime({ offset: true }),
            completeness: z.literal("received_only"),
          })
          .strict(),
      )
      .min(1),
    blocks: z.array(z.discriminatedUnion("type", [Statement, Table])),
    citations: z.array(z.object({ ref: Ref, operationId: z.enum(MSX_OPERATIONS), fieldPath: z.string().min(1) }).strict()),
    notices: z.array(z.enum(MSX_NOTICES)),
    declined: z.array(z.enum(MSX_DECLINES)),
    gaps: z.array(z.enum(MSX_GAPS)),
    ledger: z
      .object({
        routeKey: z.literal("deterministic_no_model"),
        routing_tier: z.literal(0),
        task_class: z.string().min(1),
        classifier_version: z.string().min(1),
        catalogue_version: z.string().min(1),
        latency_ms: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

export type ManagerSalesAnswer = z.infer<typeof ManagerSalesAnswerSchema>;

/** Every ref the answer cites: each cell, each statement slot and each citation. */
export function citedRefsOf(answer: ManagerSalesAnswer): string[] {
  const refs = new Set<string>(answer.citations.map((c) => c.ref));
  for (const block of answer.blocks) {
    if (block.type === "table") for (const row of block.rows) for (const cell of row) refs.add(cell.ref);
    else for (const slot of Object.values(block.slots)) refs.add(slot.ref);
  }
  return [...refs];
}
