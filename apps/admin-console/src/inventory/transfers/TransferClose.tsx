/**
 * RT-1515 (PR 3) closing a Transfer, in its drawer.
 *
 * - Close: a fully received Transfer; no reason.
 * - Short-close: a Transfer still in transit or partially received. Whatever is
 *   still In transit on each line is written off as an approved loss and stays
 *   out of both stores, so the form lists each line's remaining quantity before
 *   anything is sent and a reason (1 to 500 characters) is required. Offered
 *   to owner and tenant_admin only (the discrepancy approval); the API decides.
 *
 * Nothing is edited locally: after a recorded close the Transfer is read again.
 */
import { type MessageKey, useT } from "@/i18n";
import type { ShipmentTransfer } from "@/lib/inventory-queries";
import { useState } from "react";
import { Machine, Quantity } from "../parts";
import { NoteField } from "./TransferNoteField";
import { SubmitRow, WriteNotice } from "./TransferWriteParts";
import { buildCloseCommand, inTransitLines, shortCloseReasonError } from "./transferReceiveLogic";
import type { TransferWrite } from "./useTransferWrites";

type CloseWrite = TransferWrite<ReturnType<typeof buildCloseCommand>>;

interface Props {
  write: CloseWrite;
  onRecorded: () => void;
  onClose: () => void;
}

export function CloseForm({ write, onRecorded, onClose }: Readonly<Props>): React.JSX.Element {
  const t = useT();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const { outcome } = await write.submit({ close: true }, () => buildCloseCommand(null));
    if (outcome.kind === "recorded") onRecorded();
  };
  return (
    <form className="surface__form transfers__action-form" onSubmit={submit} noValidate>
      <p>{t("transfers.close.confirm")}</p>
      <WriteNotice outcome={write.outcome} />
      <SubmitRow
        label={t("transfers.close.submit")}
        sameRequest={write.holds({ close: true })}
        pending={write.pending}
        outcome={write.outcome}
        onClose={onClose}
      />
    </form>
  );
}

export function ShortCloseForm({
  transfer,
  write,
  onRecorded,
  onClose,
}: Readonly<Props & { transfer: ShipmentTransfer }>): React.JSX.Element {
  const t = useT();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<MessageKey | undefined>();
  const remaining = inTransitLines(transfer);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = shortCloseReasonError(reason);
    setError(found);
    if (found) return;
    const { outcome } = await write.submit({ shortClose: reason.trim() }, () =>
      buildCloseCommand(reason),
    );
    if (outcome.kind === "recorded") onRecorded();
  };
  return (
    <form className="surface__form transfers__action-form" onSubmit={submit} noValidate>
      <p>{t("transfers.shortClose.intro")}</p>
      <ul className="transfers__lines" aria-label={t("transfers.shortClose.listLabel")}>
        {remaining.map((line) => (
          <li key={line.id} className="transfers__line" data-testid="transfer-short-close-line">
            {t.rich("transfers.shortClose.line", {
              seq: <bdi dir="ltr">{line.lineSeq}</bdi>,
              product: <Machine value={line.tenantProductRef} />,
              quantity: <Quantity value={line.inTransitQuantity} />,
              unit: <Machine value={line.stockingUnit} />,
            })}
          </li>
        ))}
      </ul>
      <NoteField
        id="transfer-short-close-reason"
        label={t("transfers.shortClose.reason")}
        value={reason}
        disabled={write.pending}
        error={error}
        onChange={(value) => {
          setReason(value);
          write.clearRefusal();
          if (error) setError(shortCloseReasonError(value));
        }}
      />
      <WriteNotice outcome={write.outcome} />
      <SubmitRow
        label={t("transfers.shortClose.submit")}
        className="btn-destructive"
        sameRequest={write.holds({ shortClose: reason.trim() })}
        pending={write.pending}
        outcome={write.outcome}
        onClose={onClose}
      />
    </form>
  );
}
