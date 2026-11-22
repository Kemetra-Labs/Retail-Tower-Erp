/**
 * RT-1515 (PR 2) shared pieces of the shipment-Transfer write forms: the
 * outcome of a write that was not recorded (copy by `error.code`, with the
 * request id; never the server's own message text) and the submit row.
 *
 * No answer at all says it is unknown whether the request was recorded, and the
 * submit button becomes a retry of the SAME request: it reuses the held
 * Idempotency-Key, so it cannot record twice.
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { useT } from "@/i18n";
import { Machine } from "../parts";
import { type WriteOutcome, refusalOf } from "./transferWriteLogic";

export function WriteNotice({
  outcome,
}: Readonly<{ outcome: WriteOutcome | null }>): React.JSX.Element | null {
  const t = useT();
  if (!outcome || outcome.kind === "recorded") return null;
  if (outcome.kind === "failed") {
    return <Banner variant="danger" message={t("transfers.write.failed")} />;
  }
  const refusal = refusalOf(outcome);
  const message = refusal.wait
    ? t("transfers.write.error.rateLimitedFor", { count: refusal.wait })
    : t(refusal.key);
  return (
    <div data-testid="transfer-write-refusal">
      <Banner variant="danger" message={message} requestId={outcome.requestId} />
      {refusal.unknownCode ? (
        <p className="inventory__note">
          {t.rich("transfers.write.error.code", { code: <Machine value={refusal.unknownCode} /> })}
        </p>
      ) : null}
    </div>
  );
}

/** Submit, and a quiet Close: the label reads Retry after a no-answer outcome. */
export function SubmitRow({
  label,
  className = "btn-primary",
  pending,
  outcome,
  onClose,
  onSubmit,
  sameRequest,
}: Readonly<{
  label: string;
  className?: string;
  pending: boolean;
  outcome: WriteOutcome | null;
  onClose: () => void;
  /** For a form that cannot be a `<form>` (it holds a search form): a click submits. */
  onSubmit?: () => void;
  /** The input on screen is the unanswered request: only then is the button a resend of it. */
  sameRequest: boolean;
}>): React.JSX.Element {
  const t = useT();
  // After an edit the button sends a new request, so it must not read as a resend.
  const retry = outcome?.kind === "failed" && sameRequest;
  return (
    <div className="transfers__actions">
      <GatedButton
        type={onSubmit ? "button" : "submit"}
        className={className}
        disabled={pending}
        onClick={onSubmit}
      >
        {pending ? t("common.loading") : retry ? t("transfers.write.retry") : label}
      </GatedButton>
      <button type="button" className="btn-ghost" onClick={onClose} disabled={pending}>
        {t("common.close")}
      </button>
    </div>
  );
}
