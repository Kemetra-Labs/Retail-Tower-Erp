/**
 * RT-1425 — the session's commands: take the Count Cut, submit for review, cancel.
 *
 * Count Cut readiness is the server's answer: a cut that is not ready yet is the
 * typed refusal `count_cut_barrier_not_met` (a POS device still draining, or the ERP
 * import behind), shown as persistent text with its request id, and nothing was
 * recorded. The refusal carries no device or warehouse list in this contract, so
 * none is shown. Submit and cut take one Idempotency-Key per intended action; a
 * lost answer or a 429 keeps the key, a terminal answer takes a new one. Cancel
 * names its consequence and asks for a reason before it commits.
 */
import { DetailPanel } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { useT } from "@/i18n";
import {
  type CountSession,
  cancelCountSession,
  submitCountSession,
  takeCountCut,
} from "@/lib/count-session-queries";
import { KeyedAttempt } from "@/lib/write-outcome";
import { useRef, useState } from "react";
import { OutcomeBanner } from "./CountParts";
import { type CountOutcome, REASON_MAX, canCancel, settlesAttempt } from "./countLogic";
import { useCountCommand } from "./useCounts";

type Send = (key: string) => Promise<{ status: number; error?: unknown; retryAfter?: number }>;

function useKeyedRun() {
  const command = useCountCommand();
  const attempt = useRef(new KeyedAttempt());
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);
  const go = async (fingerprint: string, send: Send): Promise<CountOutcome> => {
    const result = await command.run(() => send(attempt.current.keyFor(fingerprint)));
    setOutcome(result);
    if (settlesAttempt(result)) attempt.current.settle();
    return result;
  };
  return { go, outcome, isPending: command.isPending };
}

function CutAndSubmit({
  session,
  captureBusy,
}: Readonly<{ session: CountSession; captureBusy: boolean }>) {
  const t = useT();
  const cut = useKeyedRun();
  const submit = useKeyedRun();
  const storeId = session.storeId;
  return (
    <>
      {session.state === "open" ? (
        <div className="counts__action">
          <h3 className="counts__subtitle">{t("counts.cut.title")}</h3>
          <p className="counts__note">{t("counts.cut.sub")}</p>
          <OutcomeBanner outcome={cut.outcome} title={t("counts.cut.failed")} />
          <GatedButton
            type="button"
            className="btn-primary"
            busy={cut.isPending}
            disabled={captureBusy}
            onClick={() => cut.go("cut", (key) => takeCountCut(storeId, session.id, key))}
          >
            {cut.isPending ? t("common.loading") : t("counts.cut.action")}
          </GatedButton>
        </div>
      ) : null}
      {session.state === "cut_taken" ? (
        <div className="counts__action">
          <h3 className="counts__subtitle">{t("counts.submit.title")}</h3>
          <p className="counts__note">{t("counts.submit.sub")}</p>
          <OutcomeBanner outcome={submit.outcome} title={t("counts.submit.failed")} />
          <GatedButton
            type="button"
            className="btn-primary"
            busy={submit.isPending}
            disabled={captureBusy}
            onClick={() =>
              submit.go("submit", (key) => submitCountSession(storeId, session.id, key))
            }
          >
            {submit.isPending ? t("common.loading") : t("counts.submit.action")}
          </GatedButton>
        </div>
      ) : null}
    </>
  );
}

function CancelCount({ session }: Readonly<{ session: CountSession }>) {
  const t = useT();
  const run = useKeyedRun();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);

  if (!asking) {
    return (
      <div className="counts__action">
        <button type="button" className="btn-danger-quiet" onClick={() => setAsking(true)}>
          {t("counts.cancel.start")}
        </button>
      </div>
    );
  }
  const confirm = async () => {
    const trimmed = reason.trim();
    if (!trimmed) return setMissing(true);
    setMissing(false);
    await run.go(trimmed, (key) => cancelCountSession(session.storeId, session.id, trimmed, key));
  };
  return (
    <fieldset className="counts__action" aria-labelledby="count-cancel-title">
      <h3 id="count-cancel-title" className="counts__subtitle">
        {t("counts.cancel.title")}
      </h3>
      <p className="counts__note">{t("counts.cancel.consequence")}</p>
      <div className="field">
        <label htmlFor="count-cancel-reason">{t("counts.cancel.reason")}</label>
        <textarea
          id="count-cancel-reason"
          className="input"
          rows={2}
          maxLength={REASON_MAX}
          value={reason}
          aria-invalid={missing ? true : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
        <InlineError message={missing ? t("counts.cancel.error.reason") : undefined} />
      </div>
      <OutcomeBanner outcome={run.outcome} title={t("counts.cancel.failed")} />
      <div className="counts__buttons">
        <GatedButton
          type="button"
          className="btn-destructive"
          busy={run.isPending}
          onClick={confirm}
        >
          {t("counts.cancel.confirm")}
        </GatedButton>
        <button type="button" className="btn-ghost" onClick={() => setAsking(false)}>
          {t("counts.cancel.keep")}
        </button>
      </div>
    </fieldset>
  );
}

export function CountActions({
  session,
  captureBusy,
  index,
}: Readonly<{
  session: CountSession;
  captureBusy: boolean;
  index: number;
}>): React.JSX.Element | null {
  const t = useT();
  if (!canCancel(session.state)) return null;
  return (
    <DetailPanel id="count-actions" index={index} title={t("counts.actions.title")}>
      <div className="counts__body">
        <CutAndSubmit session={session} captureBusy={captureBusy} />
        {canCancel(session.state) ? <CancelCount session={session} /> : null}
      </div>
    </DetailPanel>
  );
}
