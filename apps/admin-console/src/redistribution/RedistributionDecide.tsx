/**
 * RT-1601 the two decisions that cross a consequence boundary, each in the shared `ConfirmModal`
 * (focus on «Cancel», Tab trapped, Escape cancels):
 *  - accept (live phase): the selected lines become W3 shipment transfers in `draft`. Backend-Core
 *    re-checks every line and may reduce or drop it; nothing is approved, shipped or reserved here.
 *  - reject: the proposal ends with a reason; lines already accepted keep their draft transfers.
 * A send after an unclear answer reuses the held Idempotency-Key (`useRedistributionWrites`).
 */
import { ConfirmModal } from "@/components/ConfirmModal";
import { useT } from "@/i18n";
import type { RedistributionAcceptResult } from "@/lib/redistribution-queries";
import { useId, useState } from "react";
import {
  NoticeBanner,
  type RedistributionNotice,
  TransferLink,
  noticeOf,
} from "./RedistributionParts";
import type { RedistributionWrites } from "./useRedistribution";

const REASON_MAX = 500;

function countOutcomes(result: RedistributionAcceptResult) {
  const counts = { created: 0, reduced: 0, dropped: 0 };
  for (const line of result.lines) counts[line.outcome.outcome] += 1;
  return counts;
}

/** What an accept did: per-outcome counts and each created draft transfer. */
export function AcceptResultSummary({
  result,
}: Readonly<{ result: RedistributionAcceptResult }>): React.JSX.Element {
  const t = useT();
  const counts = countOutcomes(result);
  return (
    <div className="redistribution__result">
      <p>{t("redistribution.accept.resultCounts", counts)}</p>
      <p>{t("redistribution.accept.resultTransfers")}</p>
      <ul>
        {result.transferIds.map((id) => (
          <li key={id}>
            <TransferLink id={id} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AcceptDialog({
  proposalId,
  lineIds,
  writes,
  onClose,
}: Readonly<{
  proposalId: string;
  lineIds: string[];
  writes: RedistributionWrites;
  onClose: (result: RedistributionAcceptResult | null) => void;
}>): React.JSX.Element {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RedistributionAcceptResult | null>(null);
  const [notice, setNotice] = useState<RedistributionNotice | null>(null);
  const commit = async (): Promise<void> => {
    setPending(true);
    const outcome = await writes.accept(proposalId, lineIds);
    setPending(false);
    if (outcome.kind === "ok") setResult(outcome.data);
    else setNotice(noticeOf(outcome, "redistribution.accept.done"));
  };
  return (
    <ConfirmModal
      title={t("redistribution.accept.title")}
      finished={result !== null}
      pending={pending}
      cancelLabel={t("redistribution.dialog.cancel")}
      doneLabel={t("redistribution.dialog.done")}
      commitVariant="primary"
      commit={
        result
          ? null
          : {
              label: t("redistribution.accept.commit", { count: lineIds.length }),
              disabled: lineIds.length === 0,
              busy: pending,
              onClick: () => void commit(),
            }
      }
      onClose={() => onClose(result)}
    >
      {result ? (
        <AcceptResultSummary result={result} />
      ) : (
        <>
          <p className="confirm-modal__consequence">
            {t("redistribution.accept.consequence", { count: lineIds.length })}
          </p>
          <p>{t("redistribution.accept.recheck")}</p>
        </>
      )}
      <NoticeBanner notice={notice} />
    </ConfirmModal>
  );
}

export function RejectDialog({
  proposalId,
  writes,
  onClose,
}: Readonly<{
  proposalId: string;
  writes: RedistributionWrites;
  onClose: (rejected: boolean) => void;
}>): React.JSX.Element {
  const t = useT();
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState<RedistributionNotice | null>(null);
  const trimmed = reason.trim();
  const commit = async (): Promise<void> => {
    setPending(true);
    const outcome = await writes.reject(proposalId, trimmed);
    setPending(false);
    setNotice(noticeOf(outcome, "redistribution.reject.done"));
    if (outcome.kind === "ok") setDone(true);
  };
  return (
    <ConfirmModal
      title={t("redistribution.reject.title")}
      finished={done}
      pending={pending}
      cancelLabel={t("redistribution.dialog.cancel")}
      doneLabel={t("redistribution.dialog.done")}
      commit={
        done
          ? null
          : {
              label: t("redistribution.reject.commit"),
              disabled: trimmed.length === 0,
              busy: pending,
              onClick: () => void commit(),
            }
      }
      onClose={(finished) => onClose(finished)}
    >
      <p className="confirm-modal__consequence">{t("redistribution.reject.consequence")}</p>
      {done ? null : (
        <div className="field">
          <label htmlFor={fieldId} className="field__label">
            {t("redistribution.reject.reason")}
          </label>
          <textarea
            id={fieldId}
            className="field__input"
            value={reason}
            maxLength={REASON_MAX}
            rows={3}
            required
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="field__hint">
            {t("redistribution.reject.reasonHint", { max: REASON_MAX })}
          </p>
        </div>
      )}
      <NoticeBanner notice={notice} />
    </ConfirmModal>
  );
}
