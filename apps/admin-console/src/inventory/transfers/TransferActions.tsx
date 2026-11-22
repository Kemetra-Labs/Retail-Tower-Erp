/**
 * RT-1515 (PR 2) the write actions on one Transfer, in its drawer: approve (a
 * draft; the reservation window is 1, 3 or 7 days from submit, with the
 * resulting date shown first), dispatch (an approved Transfer; the WHOLE
 * approved quantity leaves) and cancel (a draft or approved Transfer; a reason
 * is required). Offered only to the roles the API accepts and only in the
 * states that allow them (a navigation convenience; the API decides).
 *
 * After a recorded write the drawer's reads are invalidated and the Transfer is
 * read again: nothing is edited locally. There is no Undo (no contract).
 */
import { InlineError } from "@/components/InlineError";
import { DateTime, type MessageKey, useT } from "@/i18n";
import type { ShipmentTransfer } from "@/lib/inventory-queries";
import { useState } from "react";
import { SubmitRow, WriteNotice } from "./TransferWriteParts";
import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_DAYS,
  type ExpiryDays,
  REASON_MAX_LENGTH,
  type TransferAction,
  actionsFor,
  buildApproveCommand,
  buildCancelCommand,
  buildDispatchCommand,
  cancelReasonError,
  expiryAt,
  noteError,
} from "./transferWriteLogic";
import type { TransferActionWrites, TransferWrite } from "./useTransferWrites";

interface FormProps<C> {
  write: TransferWrite<C>;
  onRecorded: () => void;
  onClose: () => void;
}

function NoteField({
  id,
  label,
  optional = false,
  value,
  disabled,
  error,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  optional?: boolean;
  value: string;
  disabled: boolean;
  error: MessageKey | undefined;
  onChange: (value: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optional ? (
          <>
            {" "}
            <span className="field__required">{t("transfers.write.optional")}</span>
          </>
        ) : null}
      </label>
      <textarea
        id={id}
        className="input"
        rows={2}
        dir="auto"
        maxLength={REASON_MAX_LENGTH}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div id={`${id}-error`}>
        <InlineError message={error ? t(error) : undefined} />
      </div>
    </div>
  );
}

function ApproveForm({
  write,
  onRecorded,
  onClose,
}: Readonly<FormProps<ReturnType<typeof buildApproveCommand>>>): React.JSX.Element {
  const t = useT();
  const [days, setDays] = useState<ExpiryDays>(DEFAULT_EXPIRY_DAYS);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const { outcome } = await write.submit({ days }, () => buildApproveCommand(days, new Date()));
    if (outcome.kind === "recorded") onRecorded();
  };
  return (
    <form className="surface__form transfers__action-form" onSubmit={submit} noValidate>
      <p className="inventory__note">{t("transfers.approve.intro")}</p>
      <div className="field">
        <label htmlFor="transfer-expiry">{t("transfers.approve.window")}</label>
        <select
          id="transfer-expiry"
          className="input"
          value={days}
          disabled={write.pending}
          onChange={(e) => setDays(Number(e.target.value) as ExpiryDays)}
        >
          {EXPIRY_DAYS.map((d) => (
            <option key={d} value={d}>
              {t(`transfers.approve.days.${d}`)}
            </option>
          ))}
        </select>
      </div>
      <p>
        {t.rich("transfers.approve.until", { at: <DateTime value={expiryAt(days, new Date())} /> })}
      </p>
      <WriteNotice outcome={write.outcome} />
      <SubmitRow
        label={t("transfers.approve.submit")}
        pending={write.pending}
        outcome={write.outcome}
        onClose={onClose}
      />
    </form>
  );
}

function CancelForm({
  write,
  onRecorded,
  onClose,
}: Readonly<FormProps<ReturnType<typeof buildCancelCommand>>>): React.JSX.Element {
  const t = useT();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ReturnType<typeof cancelReasonError>>();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = cancelReasonError(reason);
    setError(found);
    if (found) return;
    const { outcome } = await write.submit({ reason: reason.trim() }, () =>
      buildCancelCommand(reason),
    );
    if (outcome.kind === "recorded") onRecorded();
  };
  return (
    <form className="surface__form transfers__action-form" onSubmit={submit} noValidate>
      <p className="inventory__note">{t("transfers.cancel.intro")}</p>
      <NoteField
        id="transfer-cancel-reason"
        label={t("transfers.cancel.reason")}
        value={reason}
        disabled={write.pending}
        error={error}
        onChange={setReason}
      />
      <WriteNotice outcome={write.outcome} />
      <SubmitRow
        label={t("transfers.cancel.submit")}
        className="btn-destructive"
        pending={write.pending}
        outcome={write.outcome}
        onClose={onClose}
      />
    </form>
  );
}

function DispatchForm({
  write,
  onRecorded,
  onClose,
}: Readonly<FormProps<ReturnType<typeof buildDispatchCommand>>>): React.JSX.Element {
  const t = useT();
  const [note, setNote] = useState("");
  const [error, setError] = useState<ReturnType<typeof noteError>>();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = noteError(note);
    setError(found);
    if (found) return;
    const { outcome } = await write.submit({ note: note.trim() }, () => buildDispatchCommand(note));
    if (outcome.kind === "recorded") onRecorded();
  };
  return (
    <form className="surface__form transfers__action-form" onSubmit={submit} noValidate>
      <p>{t("transfers.dispatch.confirm")}</p>
      <NoteField
        id="transfer-dispatch-note"
        label={t("transfers.dispatch.note")}
        optional
        value={note}
        disabled={write.pending}
        error={error}
        onChange={setNote}
      />
      <WriteNotice outcome={write.outcome} />
      <SubmitRow
        label={t("transfers.dispatch.submit")}
        pending={write.pending}
        outcome={write.outcome}
        onClose={onClose}
      />
    </form>
  );
}

const OPENERS: Record<TransferAction, { label: MessageKey; cls: string }> = {
  approve: { label: "transfers.approve.open", cls: "btn-primary" },
  dispatch: { label: "transfers.dispatch.open", cls: "btn-primary" },
  cancel: { label: "transfers.cancel.open", cls: "btn-danger-quiet" },
};

function ActionForm({
  action,
  writes,
  onRecorded,
  onClose,
}: Readonly<{
  action: TransferAction;
  writes: TransferActionWrites;
  onRecorded: () => void;
  onClose: () => void;
}>): React.JSX.Element {
  const props = { onRecorded, onClose };
  if (action === "approve") return <ApproveForm write={writes.approve} {...props} />;
  if (action === "dispatch") return <DispatchForm write={writes.dispatch} {...props} />;
  return <CancelForm write={writes.cancel} {...props} />;
}

export function TransferActions({
  transfer,
  role,
  writes,
  onRecorded,
}: Readonly<{
  transfer: ShipmentTransfer;
  role: string | null;
  writes: TransferActionWrites;
  onRecorded: (action: TransferAction) => void;
}>): React.JSX.Element | null {
  const t = useT();
  const [open, setOpen] = useState<TransferAction | null>(null);
  const actions = actionsFor(transfer.state, role);
  if (actions.length === 0) return null;
  const close = () => setOpen(null);
  return (
    <section className="transfers__section" aria-labelledby="transfer-actions">
      <h3 id="transfer-actions" className="transfers__heading">
        {t("transfers.actions.title")}
      </h3>
      <div className="transfers__actions">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={OPENERS[action].cls}
            aria-expanded={open === action}
            disabled={writes.pending}
            onClick={() => setOpen(open === action ? null : action)}
          >
            {t(OPENERS[action].label)}
          </button>
        ))}
      </div>
      {open && actions.includes(open) ? (
        <ActionForm
          key={open}
          action={open}
          writes={writes}
          onClose={close}
          onRecorded={() => {
            close();
            onRecorded(open);
          }}
        />
      ) : null}
    </section>
  );
}
