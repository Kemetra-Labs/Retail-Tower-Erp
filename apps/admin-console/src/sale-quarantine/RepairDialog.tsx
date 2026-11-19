/**
 * RT-1312 (slice C) — "Record the sale": the dialog of the repair of one quarantined sale
 * (`consoleRepairQuarantinedSale`, decision C2). The same real modal as the write-off (UX-11.9):
 * Tab is trapped, Escape cancels, focus starts on the safe choice «Cancel» (UX-05.11). It names the
 * item and says what the repair does and does not do. Only the commit sends the one POST. It is
 * never sent on its own, never retried by the client, and there is no bulk repair.
 *
 * The outcome shown is the server's, read from the item it returns: a sale is "recorded" only for
 * `captured`, "already recorded" for `already-captured`; a `refused` repair says nothing was
 * recorded and the item stays open; a 5xx or a lost response is "not confirmed" and the next
 * confirmation replays the same Idempotency-Key. The commit button is the modal's shared one.
 */
import { Banner, type BannerVariant } from "@/components/Banner";
import { type T, useT } from "@/i18n";
import type { SaleScope } from "@/sales/useSales";
import { WriteConfirm, type WriteDialogWords } from "./parts";
import { type RepairOutcome, isFinishedRepair } from "./repairLogic";
import { useRepair } from "./useQuarantine";

const DANGER = new Set<RepairOutcome["kind"]>(["not-found", "forbidden", "session", "rejected"]);
const SUCCESS = new Set<RepairOutcome["kind"]>(["captured", "already-captured"]);

/** Recorded is success, an answer that fixes nothing is danger, everything else asks for attention. */
function variantOf(kind: RepairOutcome["kind"]): BannerVariant {
  if (SUCCESS.has(kind)) return "success";
  return DANGER.has(kind) ? "danger" : "warning";
}

const WORDS: WriteDialogWords = {
  title: "saleQuarantine.repair.dialogTitle",
  consequence: "saleQuarantine.repair.consequence",
  commit: "saleQuarantine.repair.commit",
  committing: "saleQuarantine.repair.committing",
  cancel: "saleQuarantine.repair.cancel",
  done: "saleQuarantine.repair.done",
};

function outcomeMessage(t: T, outcome: RepairOutcome): string {
  if (outcome.kind === "captured") return t("saleQuarantine.repair.success.captured");
  if (!("messageKey" in outcome)) return t("saleQuarantine.repair.success.alreadyCaptured");
  if (outcome.kind === "rate-limited" && outcome.retryAfter) {
    return t(outcome.messageKey, { count: outcome.retryAfter });
  }
  return t(outcome.messageKey);
}

function requestIdOf(outcome: RepairOutcome): string | undefined {
  return "requestId" in outcome ? outcome.requestId : undefined;
}

export function RepairDialog({
  scope,
  quarantineRef,
  reference,
  onClose,
}: Readonly<{
  scope: SaleScope;
  quarantineRef: string;
  /** The source reference the operator knows the sale by. */
  reference: string;
  onClose: (finished: boolean) => void;
}>): React.JSX.Element {
  const t = useT();
  const flow = useRepair({ scope, quarantineRef });
  return (
    <WriteConfirm
      words={WORDS}
      reference={reference}
      flow={flow}
      finished={isFinishedRepair(flow.outcome)}
      canCommit={!flow.pending}
      onClose={onClose}
    >
      {flow.outcome ? (
        <Banner
          variant={variantOf(flow.outcome.kind)}
          message={outcomeMessage(t, flow.outcome)}
          requestId={requestIdOf(flow.outcome)}
        />
      ) : null}
    </WriteConfirm>
  );
}
