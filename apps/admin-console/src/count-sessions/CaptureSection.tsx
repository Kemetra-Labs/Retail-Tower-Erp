/**
 * RT-1425 — blind capture by position (G6-1, decision 830). The counter picks a
 * product of the session, a stock location and a status, and types what is on the
 * shelf; no expected or on-hand quantity is read or shown anywhere on this view.
 * The contract has no read of captured observations before submit, so the list
 * below is only what this visit recorded (the server's echo of each write); the
 * server enforces coverage when the session is submitted.
 *
 * The unit is what the counter counted in: a unit that differs from the product's
 * stocking unit is accepted and flagged `uom_mismatch` at review (no coercion).
 */
import { DetailPanel } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import { inventoryStatusKey, locationKindKey } from "@/inventory/inventoryLogic";
import { Machine, Quantity } from "@/inventory/parts";
import { type CountSession, recordCountObservations } from "@/lib/count-session-queries";
import type { StockLocation } from "@/lib/inventory-queries";
import { KeyedAttempt } from "@/lib/write-outcome";
import { useRef, useState } from "react";
import { OutcomeBanner, ProductLabel } from "./CountParts";
import {
  COUNT_STATUSES,
  type CountOutcome,
  type ObservationDraft,
  type ObservationErrors,
  buildObservation,
  settlesAttempt,
  validateObservation,
} from "./countLogic";
import { useCountCommand } from "./useCounts";

type Recorded = Readonly<{
  productId: string;
  locationId: string;
  inventoryStatus: string;
  countedQuantity: string;
  stockingUnit: string;
}>;

function RecordedList({
  recorded,
  session,
  names,
  locationNames,
}: Readonly<{
  recorded: readonly Recorded[];
  session: CountSession;
  names: ReadonlyMap<string, string>;
  locationNames: ReadonlyMap<string, string>;
}>) {
  const t = useT();
  const covered = new Set(recorded.map((r) => r.productId));
  return (
    <div className="counts__recorded">
      <h3 className="counts__subtitle">{t("counts.capture.recorded")}</h3>
      {recorded.length === 0 ? (
        <ListState state="empty" emptyMessage={t("counts.capture.recordedEmpty")} />
      ) : (
        <ul className="counts__list" data-testid="count-recorded">
          {recorded.map((r, i) => (
            <li key={`${r.productId}-${r.locationId}-${r.inventoryStatus}-${i}`}>
              <ProductLabel id={r.productId} names={names} />
              {" · "}
              <bdi dir="auto">{locationNames.get(r.locationId) ?? r.locationId}</bdi>
              {" · "}
              {t(inventoryStatusKey(r.inventoryStatus))}
              {" · "}
              <Quantity value={r.countedQuantity} /> <Machine value={r.stockingUnit} />
            </li>
          ))}
        </ul>
      )}
      <h3 className="counts__subtitle">{t("counts.capture.coverage")}</h3>
      <ul className="counts__list" data-testid="count-coverage">
        {session.scope.productIds.map((id) => (
          <li key={id}>
            <ProductLabel id={id} names={names} />{" "}
            <span className={covered.has(id) ? "badge badge--success" : "badge badge--warning"}>
              {t(covered.has(id) ? "counts.capture.covered" : "counts.capture.notCovered")}
            </span>
          </li>
        ))}
      </ul>
      <p className="counts__note">{t("counts.capture.coverageNote")}</p>
    </div>
  );
}

export function CaptureSection({
  storeId,
  session,
  names,
  locations,
  locationsFailed,
  index,
}: Readonly<{
  storeId: string;
  session: CountSession;
  names: ReadonlyMap<string, string>;
  /** The store's active stock locations. */
  locations: readonly StockLocation[];
  locationsFailed: boolean;
  index: number;
}>) {
  const t = useT();
  const command = useCountCommand();
  const attempt = useRef(new KeyedAttempt());
  const [draft, setDraft] = useState<ObservationDraft>({
    productId: "",
    locationId: "",
    inventoryStatus: "sellable",
    quantity: "",
    unit: "",
  });
  const [units, setUnits] = useState<Readonly<Record<string, string>>>({});
  const [errors, setErrors] = useState<ObservationErrors>({});
  const [recorded, setRecorded] = useState<readonly Recorded[]>([]);
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);

  const locationNames = new Map(locations.map((l) => [l.id, l.name || l.code]));
  const set = (patch: Partial<ObservationDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const pickProduct = (productId: string) =>
    set({ productId, unit: units[productId] ?? draft.unit });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateObservation(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const observation = buildObservation(draft);
    const key = attempt.current.keyFor(JSON.stringify(observation));
    const result = await command.run(() =>
      recordCountObservations(storeId, session.id, [observation], key),
    );
    setOutcome(result);
    if (settlesAttempt(result)) attempt.current.settle();
    if (result.kind !== "ok") return;
    setUnits((u) => ({ ...u, [draft.productId]: observation.stockingUnit }));
    const echoed = result.data?.observations ?? [observation];
    setRecorded((cur) => [...cur, ...echoed]);
    set({ quantity: "" });
  };

  return (
    <DetailPanel id="count-capture" index={index} title={t("counts.capture.title")}>
      <div className="counts__body">
        <p className="counts__note">{t("counts.capture.sub")}</p>
        <form className="surface__form" onSubmit={submit} noValidate>
          <div className="surface__form-grid">
            <div className="field">
              <label htmlFor="count-product">{t("counts.capture.product")}</label>
              <select
                id="count-product"
                className="input"
                value={draft.productId}
                aria-invalid={errors.product ? true : undefined}
                onChange={(e) => pickProduct(e.target.value)}
              >
                <option value="">{t("counts.capture.choose")}</option>
                {session.scope.productIds.map((id) => (
                  <option key={id} value={id}>
                    {names.get(id) ?? id}
                  </option>
                ))}
              </select>
              <InlineError message={errors.product ? t(errors.product) : undefined} />
            </div>
            <div className="field">
              <label htmlFor="count-location">{t("counts.capture.location")}</label>
              <select
                id="count-location"
                className="input"
                value={draft.locationId}
                aria-invalid={errors.location ? true : undefined}
                onChange={(e) => set({ locationId: e.target.value })}
              >
                <option value="">{t("counts.capture.choose")}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name || l.code} ({t(locationKindKey(l.kind))})
                  </option>
                ))}
              </select>
              <InlineError message={errors.location ? t(errors.location) : undefined} />
            </div>
            <div className="field">
              <label htmlFor="count-status">{t("counts.capture.status")}</label>
              <select
                id="count-status"
                className="input"
                value={draft.inventoryStatus}
                onChange={(e) => set({ inventoryStatus: e.target.value })}
              >
                {COUNT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(inventoryStatusKey(s))}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="count-quantity">{t("counts.capture.quantity")}</label>
              <input
                id="count-quantity"
                className="input input--mono"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                value={draft.quantity}
                aria-invalid={errors.quantity ? true : undefined}
                onChange={(e) => set({ quantity: e.target.value })}
              />
              <InlineError message={errors.quantity ? t(errors.quantity) : undefined} />
            </div>
            <div className="field">
              <label htmlFor="count-unit">{t("counts.capture.unit")}</label>
              <input
                id="count-unit"
                className="input input--mono"
                dir="ltr"
                autoComplete="off"
                maxLength={32}
                value={draft.unit}
                aria-invalid={errors.unit ? true : undefined}
                onChange={(e) => set({ unit: e.target.value })}
              />
              <InlineError message={errors.unit ? t(errors.unit) : undefined} />
            </div>
          </div>
          {locationsFailed ? (
            <p role="alert" className="counts__note">
              {t("counts.capture.locationsFailed")}
            </p>
          ) : null}
          {outcome?.kind === "ok" ? (
            <output className="counts__ok">{t("counts.capture.saved")}</output>
          ) : null}
          <OutcomeBanner outcome={outcome} title={t("counts.capture.failed")} />
          <GatedButton type="submit" className="btn-primary" busy={command.isPending}>
            {command.isPending ? t("common.loading") : t("counts.capture.submit")}
          </GatedButton>
        </form>
        <RecordedList
          recorded={recorded}
          session={session}
          names={names}
          locationNames={locationNames}
        />
      </div>
    </DetailPanel>
  );
}
