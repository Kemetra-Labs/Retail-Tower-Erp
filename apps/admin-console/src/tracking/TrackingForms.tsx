/**
 * RT-455 forms for the governed tracking commands (owner approval, RT-455
 * comment 15245): the shared reason and note fields (`SafetyReasonCodeInput`,
 * «أخرى» needs a note), the outcome line, placing a quality hold, releasing a
 * hold (owner only; a tenant_admin sees the action recessed with the reason)
 * and correcting an expiry date.
 *
 * The outcome is the server's: success only on a 200 / 201 with a body; a
 * refusal shows the server's message and code as sent, plus one console line
 * for the known cases (the 404 every command answers until RT-453, the two 409
 * codes); no answer at all says the result is unknown and a retry is safe.
 */
import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { type MessageKey, useT } from "@/i18n";
import type { ReleaseTrackingHoldCommand, SafetyReasonCodeInput } from "@/lib/tracking-queries";
import { useState } from "react";
import { Machine } from "../inventory/parts";
import { REASON_CODES, reasonKey } from "./trackingLogic";
import { type GovernedWrite, useCorrectExpiry, usePlaceHold } from "./useTrackingWrites";
import {
  NOTE_MAX_LENGTH,
  type WriteErrors,
  type WriteOutcome,
  buildExpiryCommand,
  buildHoldCommand,
  buildReleaseCommand,
  noteRequired,
  refusalHint,
  validateExpiry,
  validateReason,
  validateRelease,
} from "./writeLogic";

// --- Shared fields ----------------------------------------------------------------

export function ReasonFields({
  idPrefix,
  reason,
  note,
  errors,
  onReason,
  onNote,
  noteAlwaysRequired = false,
}: Readonly<{
  noteAlwaysRequired?: boolean;
  idPrefix: string;
  reason: SafetyReasonCodeInput | "";
  note: string;
  errors: WriteErrors;
  onReason: (reason: SafetyReasonCodeInput | "") => void;
  onNote: (note: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-reason`}>{t("tracking.write.reason")}</label>
        <select
          id={`${idPrefix}-reason`}
          className="input"
          value={reason}
          aria-invalid={errors.reason ? true : undefined}
          onChange={(e) => onReason(e.target.value as SafetyReasonCodeInput | "")}
        >
          <option value="">{t("tracking.write.reasonChoose")}</option>
          {REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {t(reasonKey(code) ?? "tracking.reason.other")}
            </option>
          ))}
        </select>
        <InlineError message={errors.reason ? t(errors.reason) : undefined} />
      </div>
      <NoteField
        id={`${idPrefix}-note`}
        note={note}
        required={noteAlwaysRequired || noteRequired(reason)}
        error={errors.note}
        onNote={onNote}
      />
    </>
  );
}

function NoteField({
  id,
  note,
  required,
  error,
  onNote,
}: Readonly<{
  id: string;
  note: string;
  required: boolean;
  error: WriteErrors["note"];
  onNote: (note: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className="field">
      <label htmlFor={id}>
        {t("tracking.write.note")}
        <span className="field__required">
          {" "}
          {required ? t("tracking.write.noteRequired") : t("tracking.write.noteOptional")}
        </span>
      </label>
      <textarea
        id={id}
        className="input"
        rows={2}
        maxLength={NOTE_MAX_LENGTH}
        value={note}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onNote(e.target.value)}
      />
      <InlineError message={error ? t(error) : undefined} />
    </div>
  );
}

/** The command's outcome, as the server answered it. */
export function WriteResult({
  outcome,
  recorded,
  notFoundHint,
}: Readonly<{
  outcome: WriteOutcome | null;
  recorded: string;
  /** The line for a 404 when it does not mean «batches not imported yet» (the bind). */
  notFoundHint?: MessageKey;
}>): React.JSX.Element | null {
  const t = useT();
  if (!outcome) return null;
  if (outcome.kind === "recorded") return <Banner variant="success" message={recorded} />;
  if (outcome.kind === "failed") {
    return <Banner variant="danger" message={t("tracking.write.failed")} />;
  }
  const hint = refusalHint(outcome, notFoundHint);
  const waited =
    outcome.status === 429 && outcome.retryAfter
      ? t("inventory.error.rateLimitedFor", { count: outcome.retryAfter })
      : undefined;
  return (
    <div className="tracking__refusal" data-testid="tracking-write-refusal">
      <Banner
        variant="danger"
        title={t("tracking.write.rejected")}
        message={
          waited ?? outcome.message ?? t("tracking.write.noBody", { status: outcome.status })
        }
        requestId={outcome.requestId}
      />
      {hint ? <p className="tracking__muted">{t(hint)}</p> : null}
      {outcome.code ? (
        <p className="tracking__muted">
          {t.rich("tracking.write.code", { code: <Machine value={outcome.code} /> })}
        </p>
      ) : null}
    </div>
  );
}

/** A command drawer's buttons: submit and cancel, or only Close once it is recorded. */
export function DrawerActions({
  recorded,
  pending,
  submitLabel,
  onClose,
}: Readonly<{
  recorded: boolean;
  pending: boolean;
  submitLabel: string;
  onClose: () => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className="tracking__actions">
      {recorded ? (
        <button type="button" className="btn-secondary" onClick={onClose}>
          {t("tracking.write.close")}
        </button>
      ) : (
        <>
          <GatedButton type="submit" className="btn-primary" disabled={pending}>
            {pending ? t("common.loading") : submitLabel}
          </GatedButton>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={pending}>
            {t("tracking.write.cancel")}
          </button>
        </>
      )}
    </div>
  );
}

// --- Place a quality hold -------------------------------------------------------------

export function PlaceHoldDrawer({
  identityId,
  code,
  onClose,
}: Readonly<{ identityId: string; code: string; onClose: () => void }>): React.JSX.Element {
  const t = useT();
  const write = usePlaceHold();
  const [reason, setReason] = useState<SafetyReasonCodeInput | "">("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<WriteErrors>({});
  const recorded = write.outcome?.kind === "recorded";

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const draft = { reason, note };
    const found = validateReason(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    await write.submit(buildHoldCommand(identityId, draft));
  }

  return (
    <Drawer
      title={t("tracking.placeHold.title")}
      scope={t.rich("tracking.placeHold.scope", { code: <Machine value={code} /> })}
      onClose={onClose}
      dismissible={!write.pending}
    >
      <form
        className="surface__form"
        onSubmit={submit}
        noValidate
        data-testid="tracking-place-hold"
      >
        <ReasonFields
          idPrefix="place-hold"
          reason={reason}
          note={note}
          errors={errors}
          onReason={setReason}
          onNote={setNote}
        />
        <p className="tracking__muted">{t("tracking.placeHold.effect")}</p>
        <WriteResult
          outcome={write.outcome}
          recorded={t("tracking.placeHold.recorded", { code })}
        />
        <DrawerActions
          recorded={recorded}
          pending={write.pending}
          submitLabel={t("tracking.placeHold.submit")}
          onClose={onClose}
        />
      </form>
    </Drawer>
  );
}

// --- Release ----------------------------------------------------------------------

/**
 * Owner only (965). A tenant_admin sees the action recessed, with the reason.
 * The drawer owns the write (`useReleaseHold`), so it stays open while the
 * release is in flight and keeps the outcome after the hold re-reads released.
 */
export function ReleaseSection({
  write,
  code,
  canRelease,
}: Readonly<{
  write: GovernedWrite<ReleaseTrackingHoldCommand>;
  code: string;
  canRelease: boolean;
}>): React.JSX.Element {
  const t = useT();
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<WriteErrors>({});
  const [confirming, setConfirming] = useState(false);

  if (!canRelease) {
    return (
      <div className="tracking__release" data-testid="tracking-release">
        <button
          type="button"
          className="btn-danger-quiet"
          aria-disabled="true"
          aria-describedby="release-why"
        >
          {t("tracking.release.submit")}
        </button>
        <p id="release-why" className="tracking__muted" data-testid="tracking-release-notice">
          {t("tracking.release.ownerOnly")}
        </p>
      </div>
    );
  }

  function ask(): void {
    const found = validateRelease(note);
    setErrors(found);
    if (Object.keys(found).length === 0) setConfirming(true);
  }

  async function release(): Promise<void> {
    setConfirming(false);
    await write.submit(buildReleaseCommand(note));
  }

  const recorded = write.outcome?.kind === "recorded";
  return (
    <div className="tracking__release" data-testid="tracking-release">
      <p className="tracking__muted" data-testid="tracking-release-notice">
        {t("tracking.release.ownerNote")}
      </p>
      {recorded ? null : (
        <NoteField
          id="release-note"
          note={note}
          required={false}
          error={errors.note}
          onNote={setNote}
        />
      )}
      {confirming ? (
        <fieldset className="tracking__confirm">
          <legend>{t("tracking.release.confirm", { code })}</legend>
          <div className="tracking__actions">
            <button type="button" className="btn-destructive" onClick={release}>
              {t("tracking.release.yes")}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              {t("tracking.write.cancel")}
            </button>
          </div>
        </fieldset>
      ) : recorded ? null : (
        <GatedButton
          type="button"
          className="btn-danger-quiet"
          onClick={ask}
          disabled={write.pending}
        >
          {write.pending ? t("common.loading") : t("tracking.release.submit")}
        </GatedButton>
      )}
    </div>
  );
}

// --- Expiry correction ------------------------------------------------------------

export function ExpiryForm({
  identityId,
  current,
}: Readonly<{ identityId: string; current: string | null }>): React.JSX.Element {
  const t = useT();
  const write = useCorrectExpiry(identityId);
  const [date, setDate] = useState("");
  const [clearChecked, setClear] = useState(false);
  // Once the expiry re-reads as empty there is nothing to clear: the choice lapses.
  const clear = clearChecked && current !== null;
  const [reason, setReason] = useState<SafetyReasonCodeInput | "">("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<WriteErrors>({});
  // The value the outcome is about, fixed at submit: editing the field later
  // never rewrites what the banner says was recorded.
  const [submitted, setSubmitted] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const draft = { date, clear, reason, note };
    const found = validateExpiry(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const command = buildExpiryCommand(draft);
    setSubmitted(command.expiryDate);
    const outcome = await write.submit(command);
    if (outcome.kind === "recorded") {
      setNote("");
      setReason("");
    }
  }

  return (
    <form className="surface__form" onSubmit={submit} noValidate data-testid="tracking-expiry-form">
      <div className="surface__form-grid">
        <div className="field">
          <label htmlFor="expiry-date">{t("tracking.expiry.newDate")}</label>
          <input
            id="expiry-date"
            type="date"
            className="input"
            dir="ltr"
            value={date}
            disabled={clear}
            aria-invalid={errors.date ? true : undefined}
            aria-describedby="expiry-date-help"
            onChange={(e) => setDate(e.target.value)}
          />
          <p id="expiry-date-help" className="tracking__muted">
            {current
              ? t.rich("tracking.expiry.current", { date: <Machine value={current} /> })
              : t("tracking.expiry.currentNone")}
          </p>
          <InlineError message={errors.date ? t(errors.date) : undefined} />
        </div>
      </div>
      {current ? (
        <label className="tracking__choice">
          <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} />
          {t("tracking.expiry.clear")}
        </label>
      ) : null}
      <ReasonFields
        idPrefix="expiry"
        reason={reason}
        note={note}
        errors={errors}
        onReason={setReason}
        onNote={setNote}
      />
      <WriteResult
        outcome={write.outcome}
        recorded={
          submitted
            ? t("tracking.expiry.recorded", { date: submitted })
            : t("tracking.expiry.cleared")
        }
      />
      <div className="tracking__actions">
        <GatedButton type="submit" className="btn-primary" disabled={write.pending}>
          {write.pending ? t("common.loading") : t("tracking.expiry.submit")}
        </GatedButton>
      </div>
    </form>
  );
}
