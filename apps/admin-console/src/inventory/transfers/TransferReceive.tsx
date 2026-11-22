/**
 * RT-1515 (PR 3) the receive form of a Transfer in transit or partially
 * received, in its drawer. One row per line that still has a quantity In
 * transit: the quantity received in this receipt (blank means "not in this
 * receipt"), a disposition (sellable or damaged) and, only when the destination
 * store has more than one active location (decision 967), the location it goes
 * to; otherwise the destination's primary location is sent as null.
 *
 * A line cannot receive more than it has In transit: that is refused here with
 * an exact decimal comparison, and by the server (409
 * `over_receipt_requires_approval`, nothing written). An excess is recorded
 * separately as an approved stock adjustment, never on the Transfer; this
 * console has no adjustment flow and never claims one was recorded.
 *
 * A short receipt leaves the rest In transit. After a recorded receipt the
 * Transfer and its receipts are read again (nothing is edited locally).
 */
import { InlineError } from "@/components/InlineError";
import { type MessageKey, useT } from "@/i18n";
import type { ShipmentTransfer, StockLocation } from "@/lib/inventory-queries";
import { useState } from "react";
import { inventoryStatusKey, locationKindKey } from "../inventoryLogic";
import { Machine, Quantity } from "../parts";
import { type InventoryScope, useStockLocations } from "../useInventory";
import { NoteField } from "./TransferNoteField";
import { SubmitRow, WriteNotice } from "./TransferWriteParts";
import {
  DISPOSITIONS,
  type Disposition,
  type ReceiveDraft,
  type ReceiveErrors,
  type ReceiveLineDraft,
  buildReceiveCommand,
  hasReceiveErrors,
  inTransitLines,
  validateReceive,
} from "./transferReceiveLogic";
import type { TransferWrite } from "./useTransferWrites";

type ReceiveWrite = TransferWrite<ReturnType<typeof buildReceiveCommand>>;

function activeLocations(locations: readonly StockLocation[] | undefined): StockLocation[] {
  return (locations ?? []).filter((l) => l.isActive);
}

function LocationSelect({
  id,
  value,
  choices,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  value: string;
  choices: readonly StockLocation[];
  disabled: boolean;
  onChange: (value: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className="field">
      <label htmlFor={id}>{t("transfers.receive.location")}</label>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t("inventory.move.location.primary")}</option>
        {choices
          .filter((l) => l.kind !== "primary")
          .map((l) => (
            <option key={l.id} value={l.id}>
              {l.name || l.code} ({t(locationKindKey(l.kind))})
            </option>
          ))}
      </select>
    </div>
  );
}

interface RowProps {
  line: ShipmentTransfer["lines"][number];
  draft: ReceiveLineDraft;
  error: MessageKey | undefined;
  locations: readonly StockLocation[] | null;
  disabled: boolean;
  onChange: (patch: Partial<ReceiveLineDraft>) => void;
}

function ReceiveRow({
  line,
  draft,
  error,
  locations,
  disabled,
  onChange,
}: Readonly<RowProps>): React.JSX.Element {
  const t = useT();
  const base = `transfer-receive-${line.id}`;
  return (
    <li className="transfers__line" data-testid="transfer-receive-line">
      <fieldset className="transfers__plain" disabled={disabled}>
        <div className="transfers__line-head">
          <span className="transfers__name">
            {t.rich("transfers.receive.lineHead", {
              seq: <bdi dir="ltr">{line.lineSeq}</bdi>,
              product: <Machine value={line.tenantProductRef} />,
            })}
          </span>
        </div>
        <dl className="transfers__figures">
          <div>
            <dt>{t("transfers.lines.col.inTransit")}</dt>
            <dd>
              <Quantity value={line.inTransitQuantity} /> <Machine value={line.stockingUnit} />
            </dd>
          </div>
        </dl>
        <div className="field">
          <label htmlFor={`${base}-quantity`}>
            {t("transfers.receive.quantity", { seq: line.lineSeq })}
          </label>
          <input
            id={`${base}-quantity`}
            className="input input--mono"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={draft.quantity}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${base}-error` : undefined}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
          <div id={`${base}-error`}>
            <InlineError message={error ? t(error) : undefined} />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${base}-disposition`}>
            {t("transfers.receive.disposition", { seq: line.lineSeq })}
          </label>
          <select
            id={`${base}-disposition`}
            className="input"
            value={draft.disposition}
            onChange={(e) => onChange({ disposition: e.target.value as Disposition })}
          >
            {DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {t(inventoryStatusKey(d))}
              </option>
            ))}
          </select>
        </div>
        {locations ? (
          <LocationSelect
            id={`${base}-location`}
            value={draft.locationId}
            choices={locations}
            disabled={disabled}
            onChange={(locationId) => onChange({ locationId })}
          />
        ) : null}
      </fieldset>
    </li>
  );
}

function initialDraft(transfer: ShipmentTransfer): ReceiveDraft {
  return {
    lines: inTransitLines(transfer).map((l) => ({
      lineId: l.id,
      quantity: "",
      disposition: "sellable",
      locationId: "",
    })),
    note: "",
  };
}

export function ReceiveForm({
  scope,
  transfer,
  write,
  onRecorded,
  onClose,
}: Readonly<{
  scope: InventoryScope;
  transfer: ShipmentTransfer;
  write: ReceiveWrite;
  onRecorded: () => void;
  onClose: () => void;
}>): React.JSX.Element {
  const t = useT();
  const locations = useStockLocations({ scope, storeId: transfer.destinationStoreId });
  const choices = activeLocations(locations.data?.items);
  const multiLocation = choices.length > 1;
  const [draft, setDraft] = useState<ReceiveDraft>(() => initialDraft(transfer));
  const [errors, setErrors] = useState<ReceiveErrors>({ perLine: {} });
  const lines = inTransitLines(transfer);
  // Only the rows on screen count: a line that is no longer In transit after a re-read
  // drops out of the form, and its typed quantity must not block or join the receipt.
  const shown = new Set(lines.map((l) => l.id));
  const visible = (d: ReceiveDraft): ReceiveDraft => ({
    ...d,
    lines: d.lines.filter((l) => shown.has(l.lineId)),
  });
  const live = visible(draft);

  /** Apply an edit; once errors are on screen they follow the input, as in the other forms. */
  const edit = (next: ReceiveDraft) => {
    write.clearRefusal();
    setDraft(next);
    if (hasReceiveErrors(errors)) setErrors(validateReceive(visible(next), transfer.lines));
  };
  const change = (lineId: string, patch: Partial<ReceiveLineDraft>) =>
    edit({
      ...draft,
      lines: draft.lines.map((l) => (l.lineId === lineId ? { ...l, ...patch } : l)),
    });

  /**
   * What the operator chose: the Idempotency-Key follows this, never the built command.
   * Whether a location is sent depends on a live read of the destination's locations,
   * so a changed read after an unanswered attempt must not mint a new key.
   */
  const operatorInput = {
    note: live.note.trim(),
    lines: live.lines
      .filter((l) => l.quantity.trim() !== "")
      .map((l) => ({
        lineId: l.lineId,
        quantity: l.quantity.trim(),
        disposition: l.disposition,
        locationId: l.locationId,
      })),
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateReceive(live, transfer.lines);
    setErrors(found);
    if (hasReceiveErrors(found)) return;
    const { outcome } = await write.submit(operatorInput, () =>
      buildReceiveCommand(live, multiLocation),
    );
    if (outcome.kind === "recorded") onRecorded();
  };

  return (
    <form className="surface__form transfers__action-form" onSubmit={submit} noValidate>
      <p className="inventory__note">{t("transfers.receive.intro")}</p>
      <ul className="transfers__lines">
        {lines.map((line) => {
          const row = draft.lines.find((l) => l.lineId === line.id);
          return row ? (
            <ReceiveRow
              key={line.id}
              line={line}
              draft={row}
              error={errors.perLine[line.id]}
              locations={multiLocation ? choices : null}
              disabled={write.pending}
              onChange={(patch) => change(line.id, patch)}
            />
          ) : null;
        })}
      </ul>
      <InlineError message={errors.form ? t(errors.form) : undefined} />
      <NoteField
        id="transfer-receive-note"
        label={t("transfers.receive.note")}
        optional
        value={draft.note}
        disabled={write.pending}
        error={errors.note}
        onChange={(note) => edit({ ...draft, note })}
      />
      <WriteNotice outcome={write.outcome} />
      <SubmitRow
        label={t("transfers.receive.submit")}
        sameRequest={write.holds(operatorInput)}
        pending={write.pending}
        outcome={write.outcome}
        onClose={onClose}
      />
    </form>
  );
}
