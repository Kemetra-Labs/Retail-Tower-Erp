/**
 * RT-1312 (Phase 3(b) slice C) pure helpers for the repair of a quarantined sale
 * (`consoleRepairQuarantinedSale`). No React, no fetch. RT-399: helpers return catalog message
 * keys, never copy.
 *
 * Truth rules: the repair answers 200 for every capture outcome, so the outcome is read from the
 * item (`lastRepair.outcome`), never inferred from the status. Only `captured` and
 * `already-captured` say a sale exists. `refused` says nothing was recorded and the item is still
 * open. A 5xx, a lost response or a 200 this build cannot read may have been applied, so it reads
 * as "not confirmed", never as failed or recorded. Nothing here retries.
 */
import type { MessageKey } from "@/i18n";
import type { QuarantinedSale } from "@/lib/sale-quarantine-queries";
import {
  type WriteOffOutcome,
  type WriteResult,
  classifyRefusal,
  refusalTable,
} from "./quarantineLogic";

export interface RepairResult extends WriteResult {
  data?: QuarantinedSale;
}

export type RepairOutcome =
  | { kind: "captured" | "already-captured"; item: QuarantinedSale }
  | { kind: "refused"; item: QuarantinedSale; messageKey: MessageKey }
  | Exclude<WriteOffOutcome, { kind: "written-off" }>;

const REPAIR_TABLE = refusalTable({
  rejected: "saleQuarantine.repair.error.rejected",
  forbidden: "saleQuarantine.repair.error.forbidden",
  originRejected: "saleQuarantine.repair.error.originRejected",
  notFound: "saleQuarantine.repair.error.notFound",
  conflict: "saleQuarantine.repair.error.conflict",
  keyConflict: "saleQuarantine.repair.error.keyConflict",
  unconfirmed: "saleQuarantine.repair.error.unconfirmed",
  rateLimited: "saleQuarantine.repair.error.rateLimited",
  rateLimitedFor: "saleQuarantine.repair.error.rateLimitedFor",
});

/**
 * Why the capture rules refused the stored sale again, from the item's `lastRepair`: the cashier
 * could not be confirmed, the reference holds a sale with other details (409), the reference is
 * recorded in another store (404), or anything else. Each of the first three can only be closed
 * without recording.
 */
export function refusedReasonKey(item: QuarantinedSale): MessageKey {
  const last = item.lastRepair;
  if (last?.errorCode === "repair_operator_unproven")
    return "saleQuarantine.repair.refused.operator";
  if (last?.httpStatus === 409) return "saleQuarantine.repair.refused.diverged";
  if (last?.httpStatus === 404) return "saleQuarantine.repair.refused.otherStore";
  return "saleQuarantine.repair.refused.generic";
}

/**
 * Maps the server's answer to what the operator sees. A 200 is read through the item's
 * `lastRepair.outcome`; an outcome this build does not know is "not confirmed".
 */
export function classifyRepair(result: RepairResult): RepairOutcome {
  const item = result.status === 200 ? result.data : undefined;
  if (item) {
    const outcome = item.lastRepair?.outcome;
    if (outcome === "captured" || outcome === "already-captured") return { kind: outcome, item };
    if (outcome === "refused") {
      return { kind: "refused", item, messageKey: refusedReasonKey(item) };
    }
  }
  return classifyRefusal(result, REPAIR_TABLE);
}

/** After an unconfirmed or rate-limited attempt the same key replays the stored answer. */
export function keepsRepairKey(outcome: RepairOutcome): boolean {
  return outcome.kind === "unconfirmed" || outcome.kind === "rate-limited";
}

/** An outcome after which nothing more can be sent from the dialog. */
export function isFinishedRepair(outcome: RepairOutcome | undefined): boolean {
  return (
    outcome?.kind === "captured" ||
    outcome?.kind === "already-captured" ||
    outcome?.kind === "refused" ||
    outcome?.kind === "conflict" ||
    outcome?.kind === "not-found"
  );
}
