/**
 * RT-436 — the status-disposition action on one product's on-hand page
 * (Sellable -> Damaged, Return inspection -> Sellable / Damaged, and so on),
 * against RT-435 `createStatusMove`. The console owns no inventory rules: it
 * offers the choices the contract allows, sends one strict command with an
 * Idempotency-Key, and shows every backend refusal exactly as sent (message,
 * code and request id), never reworded. Physical on-hand is unchanged by a
 * status move; after a recorded move the on-hand is re-read, not edited.
 *
 * Locations stay hidden in the simple-retailer UX (decision 967): the
 * location field appears only when the store has more than one active
 * location, and an untouched field sends no location (the primary one).
 *
 * Permission: the page mounts this only for the roles the operation accepts
 * (`canMoveStock`); the API remains the authority (a store_manager outside its
 * store scope is refused by it, and the refusal is shown verbatim).
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { useT } from "@/i18n";
import type { InventoryReasonCode, OnHand, StockLocation } from "@/lib/inventory-queries";
import { useRef, useState } from "react";
import { inventoryStatusKey, locationKindKey } from "./inventoryLogic";
import { Machine, Unknown } from "./parts";
import {
  type DispositionStatus,
  type KeyedCommand,
  type MoveErrors,
  type MoveOutcome,
  NOTE_MAX_LENGTH,
  buildCommand,
  fromStatusesFor,
  isKeyConflict,
  keyFor,
  noteRequired,
  reasonKey,
  reasonsFor,
  toStatusesFor,
  validateMove,
} from "./statusMoveLogic";
import { type ReadState, useStockLocations } from "./useInventory";
import type { InventoryScope } from "./useInventory";
import { useStatusMove } from "./useStatusMove";

interface Props {
  scope: InventoryScope;
  storeId: string;
  productId: string;
  onHand: ReadState<OnHand>;
}

function activeLocations(locations: readonly StockLocation[] | undefined): StockLocation[] {
  return (locations ?? []).filter((l) => l.isActive);
}

function Rejection({ outcome }: Readonly<{ outcome: Extract<MoveOutcome, { kind: "rejected" }> }>) {
  const t = useT();
  // The server's words are shown verbatim; only a body-less failure gets console copy.
  const message =
    outcome.message ?? t("inventory.move.rejected.noBody", { status: outcome.status });
  return (
    <div data-testid="move-rejection">
      <Banner
        variant="danger"
        title={t("inventory.move.rejected.title")}
        message={message}
        requestId={outcome.requestId}
      />
      {outcome.code ? (
        <p className="inventory__note">
          {t.rich("inventory.move.rejected.code", { code: <Machine value={outcome.code} /> })}
        </p>
      ) : null}
    </div>
  );
}

export function StatusMoveSection({ scope, storeId, productId, onHand }: Readonly<Props>) {
  const t = useT();
  const locations = useStockLocations({ scope, storeId });
  const move = useStatusMove(storeId);
  const held = useRef<KeyedCommand | null>(null);

  const fromChoices = fromStatusesFor(scope.role);
  const [from, setFrom] = useState<DispositionStatus>(fromChoices[0] ?? "sellable");
  const [to, setTo] = useState<DispositionStatus>("damaged");
  const [reason, setReason] = useState<InventoryReasonCode | "">("damage");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [locationId, setLocationId] = useState("");
  const [errors, setErrors] = useState<MoveErrors>({});
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);

  const stockingUnit = onHand.data?.stockingUnit;
  const reasons = reasonsFor(from, to);
  const locationChoices = activeLocations(locations.data?.items);
  const showLocation = locationChoices.length > 1;

  const changeFrom = (next: DispositionStatus) => {
    const nextTo = next === to ? (toStatusesFor(next)[0] ?? to) : to;
    setFrom(next);
    setTo(nextTo);
    setReason(reasonsFor(next, nextTo)[0] ?? "");
  };
  const changeTo = (next: DispositionStatus) => {
    setTo(next);
    setReason(reasonsFor(from, next)[0] ?? "");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setOutcome(null);
    const draft = { productId, from, to, reason, quantity, note, locationId, stockingUnit };
    const found = validateMove(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const command = buildCommand(draft);
    held.current = keyFor(held.current, command);
    let result: MoveOutcome;
    try {
      result = await move.mutateAsync({
        command,
        idempotencyKey: held.current.key,
      });
    } catch {
      // No response at all (offline, aborted): the result is unknown. Keep the
      // held key so a retry of the same command cannot record it twice.
      setOutcome({ kind: "failed" });
      return;
    }
    setOutcome(result);
    if (result.kind === "recorded") {
      held.current = null;
      setQuantity("");
      setNote("");
    } else if (isKeyConflict(result)) {
      held.current = null;
    }
  };

  return (
    <section className="inventory__section" aria-labelledby="inventory-move">
      <h2 id="inventory-move" className="inventory__section-title">
        {t("inventory.move.title")}
      </h2>
      <p className="inventory__note">{t("inventory.move.sub")}</p>
      {stockingUnit ? null : onHand.data ? (
        <Banner variant="warning" message={t("inventory.move.error.unit")} />
      ) : (
        <p className="inventory__note">
          {t("inventory.move.unitUnknown")} <Unknown />
        </p>
      )}
      <form className="surface__form" onSubmit={submit} noValidate>
        <div className="surface__form-grid">
          <div className="field">
            <label htmlFor="move-from">{t("inventory.move.from")}</label>
            <select
              id="move-from"
              className="input"
              value={from}
              onChange={(e) => changeFrom(e.target.value as DispositionStatus)}
            >
              {fromChoices.map((s) => (
                <option key={s} value={s}>
                  {t(inventoryStatusKey(s))}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="move-to">{t("inventory.move.to")}</label>
            <select
              id="move-to"
              className="input"
              value={to}
              onChange={(e) => changeTo(e.target.value as DispositionStatus)}
            >
              {toStatusesFor(from).map((s) => (
                <option key={s} value={s}>
                  {t(inventoryStatusKey(s))}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="move-reason">{t("inventory.move.reason")}</label>
            <select
              id="move-reason"
              className="input"
              value={reason}
              aria-invalid={errors.reason ? true : undefined}
              onChange={(e) => setReason(e.target.value as InventoryReasonCode)}
            >
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {t(reasonKey(r))}
                </option>
              ))}
            </select>
            <InlineError message={errors.reason ? t(errors.reason) : undefined} />
          </div>
          <div className="field">
            <label htmlFor="move-quantity">
              {t("inventory.move.quantity")}
              {stockingUnit ? (
                <>
                  {" "}
                  (<Machine value={stockingUnit} />)
                </>
              ) : null}
            </label>
            <input
              id="move-quantity"
              className="input input--mono"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              value={quantity}
              aria-invalid={errors.quantity ? true : undefined}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <InlineError message={errors.quantity ? t(errors.quantity) : undefined} />
          </div>
          {showLocation ? (
            <div className="field">
              <label htmlFor="move-location">{t("inventory.move.location")}</label>
              <select
                id="move-location"
                className="input"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">{t("inventory.move.location.primary")}</option>
                {locationChoices
                  .filter((l) => l.kind !== "primary")
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name || l.code} ({t(locationKindKey(l.kind))})
                    </option>
                  ))}
              </select>
            </div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="move-note">
            {t("inventory.move.note")}
            {noteRequired(reason) ? null : (
              <span className="field__required"> {t("inventory.move.optional")}</span>
            )}
          </label>
          <textarea
            id="move-note"
            className="input"
            rows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            aria-invalid={errors.note ? true : undefined}
            onChange={(e) => setNote(e.target.value)}
          />
          <InlineError message={errors.note ? t(errors.note) : undefined} />
        </div>
        <div>
          <GatedButton type="submit" className="btn-primary" disabled={move.isPending}>
            {move.isPending ? t("common.loading") : t("inventory.move.submit")}
          </GatedButton>
        </div>
      </form>
      {outcome?.kind === "recorded" ? (
        <Banner variant="success" message={t("inventory.move.recorded")} />
      ) : null}
      {outcome?.kind === "rejected" ? <Rejection outcome={outcome} /> : null}
      {outcome?.kind === "failed" ? (
        <Banner variant="danger" message={t("inventory.move.failed")} />
      ) : null}
      <p className="inventory__note">{t("inventory.move.note.physical")}</p>
    </section>
  );
}
