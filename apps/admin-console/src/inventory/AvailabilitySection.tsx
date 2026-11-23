/**
 * RT-1579 (RT-1511 slice S4): the stock quantities of one product at one store,
 * each as its own labelled figure (decision 745: never one generic "Stock").
 * Everything comes from `getOnHand` (`OnHand` and its `availability` object,
 * RT-1576): Backend-Core computes Available To Sell at the store's primary
 * location; this view only shows it. Read-only.
 *
 *   - Quantities are the API's exact-decimal strings, rendered verbatim and
 *     LTR-isolated: never parsed, rounded or clamped. A negative Available To
 *     Sell is shown negative (743) with a warning; the figure never changes
 *     colour.
 *   - The terms that make Available To Sell are listed above it, so the figures
 *     add up: primary sellable, less expired tracked lots, less active
 *     reservations, less safety protection.
 *   - In Transit (inbound, outbound) and On Order are not part of it and sit in
 *     their own group. On Order is `null` until a purchasing source exists: that
 *     reads "not available yet", which is not Unknown (a failed read).
 *   - A read with no answer, or an answer without `availability`, is Unknown,
 *     never zero. The as-of time is the API's, in the store's time zone.
 */
import { Banner } from "@/components/Banner";
import { DetailPanel, LedgerField, PanelBody } from "@/components/DetailPanel";
import { ListState } from "@/components/ListState";
import { DateTime, type MessageKey, useT } from "@/i18n";
import type { OnHand } from "@/lib/inventory-queries";
import { Quantity, Unit, Unknown } from "./parts";
import type { ReadState } from "./useInventory";

type Availability = OnHand["availability"];
type StockUnit = string | null | undefined;

/** A quantity with its stocking unit, as one testable figure. */
function Figure({
  id,
  value,
  unit,
}: Readonly<{ id: string; value: string; unit: StockUnit }>): React.JSX.Element {
  return (
    <span data-testid={`availability-${id}`}>
      <Quantity value={value} /> <Unit unit={unit} />
    </span>
  );
}

/** The one-line meaning under a label; a hidden stop keeps it out of the term's name. */
function Hint({ text }: Readonly<{ text: string }>): React.JSX.Element {
  return (
    <>
      <span className="sr-only">. </span>
      <span className="inventory__hint">{text}</span>
    </>
  );
}

/** One ledger row: a label with the one-line meaning of the figure under it. */
function Row({
  label,
  hint,
  total,
  id,
  value,
  unit,
}: Readonly<{
  label: MessageKey;
  hint?: MessageKey;
  total?: boolean;
  id: string;
  value: string;
  unit: StockUnit;
}>): React.JSX.Element {
  const t = useT();
  return (
    <LedgerField
      total={total}
      label={
        <>
          {t(label)}
          {hint ? <Hint text={t(hint)} /> : null}
        </>
      }
    >
      <Figure id={id} value={value} unit={unit} />
    </LedgerField>
  );
}

function Group({
  title,
  children,
}: Readonly<{ title: MessageKey; children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="inventory__group">
      <h3 className="inventory__group-title">{t(title)}</h3>
      <dl className="surface__detail">{children}</dl>
    </div>
  );
}

function WholeStore({ onHand }: Readonly<{ onHand: OnHand }>): React.JSX.Element {
  const unit = onHand.stockingUnit;
  return (
    <Group title="inventory.availability.group.store">
      <Row
        id="physical"
        label="inventory.onHand.physical"
        hint="inventory.availability.hint.physical"
        value={onHand.quantity}
        unit={unit}
      />
      <Row
        id="sellable"
        label="inventory.availability.sellableAll"
        hint="inventory.availability.hint.sellableAll"
        value={onHand.sellableQuantity}
        unit={unit}
      />
    </Group>
  );
}

function PrimaryLocation({
  availability: a,
  unit,
}: Readonly<{ availability: Availability; unit: StockUnit }>): React.JSX.Element {
  return (
    <Group title="inventory.availability.group.ats">
      <Row
        id="primary-sellable"
        label="inventory.availability.primarySellable"
        hint="inventory.availability.hint.primarySellable"
        value={a.primarySellable}
        unit={unit}
      />
      <Row
        id="expired"
        label="inventory.availability.expired"
        hint="inventory.availability.hint.expired"
        value={a.expiredTrackedSellable}
        unit={unit}
      />
      <Row
        id="reserved"
        label="inventory.availability.reserved"
        hint="inventory.availability.hint.reserved"
        value={a.activeReserved}
        unit={unit}
      />
      <Row
        id="safety"
        label="inventory.availability.safety"
        hint="inventory.availability.hint.safety"
        value={a.safetyProtection}
        unit={unit}
      />
      <Row
        total
        id="ats"
        label="inventory.availability.ats"
        value={a.availableToSell}
        unit={unit}
      />
    </Group>
  );
}

function OutsideAts({
  availability: a,
  unit,
}: Readonly<{ availability: Availability; unit: StockUnit }>): React.JSX.Element {
  const t = useT();
  return (
    <Group title="inventory.availability.group.outside">
      <Row
        id="in-transit-inbound"
        label="inventory.availability.inTransitInbound"
        hint="inventory.availability.hint.inTransitInbound"
        value={a.inTransitInbound}
        unit={unit}
      />
      <Row
        id="in-transit-outbound"
        label="inventory.availability.inTransitOutbound"
        hint="inventory.availability.hint.inTransitOutbound"
        value={a.inTransitOutbound}
        unit={unit}
      />
      <LedgerField
        label={
          <>
            {t("inventory.availability.onOrder")}
            <Hint text={t("inventory.availability.hint.onOrder")} />
          </>
        }
      >
        <span data-testid="availability-on-order">
          {typeof a.onOrder === "string" ? (
            <>
              <Quantity value={a.onOrder} /> <Unit unit={unit} />
            </>
          ) : (
            t("inventory.availability.onOrderNone")
          )}
        </span>
      </LedgerField>
    </Group>
  );
}

/**
 * A decimal string below zero: the API's own sign, read, never parsed. A
 * negative zero is not below zero, and a missing value is not negative.
 */
function isNegative(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("-") && /[1-9]/.test(value);
}

/** Available To Sell with no answer: Unknown, never zero. */
function AtsUnknown(): React.JSX.Element {
  const t = useT();
  return (
    <p data-testid="availability-ats">
      {t("inventory.availability.ats")}: <Unknown />
    </p>
  );
}

function Figures({ onHand }: Readonly<{ onHand: OnHand }>): React.JSX.Element {
  const t = useT();
  // The contract requires `availability`; an older server may not send it yet.
  const availability = onHand.availability as Availability | undefined;
  return (
    <PanelBody>
      <p className="inventory__note">{t("inventory.availability.note")}</p>
      <WholeStore onHand={onHand} />
      {availability ? (
        <>
          {isNegative(availability.availableToSell) ? (
            <Banner variant="warning" message={t("inventory.availability.negative")} />
          ) : null}
          <PrimaryLocation availability={availability} unit={onHand.stockingUnit} />
          <OutsideAts availability={availability} unit={onHand.stockingUnit} />
        </>
      ) : (
        <AtsUnknown />
      )}
    </PanelBody>
  );
}

/**
 * The panel. While the read is loading it says so; when it has no answer the
 * on-hand panel above carries the error and its retry, so this one only says
 * the figures are unknown (never zero).
 */
export function AvailabilitySection({
  onHand,
  timeZone,
  index,
}: Readonly<{
  onHand: ReadState<OnHand>;
  timeZone: string | undefined;
  index: number;
}>): React.JSX.Element {
  const t = useT();
  const asOf = (onHand.data?.availability as Availability | undefined)?.asOf;
  let body: React.JSX.Element;
  if (onHand.isLoading) {
    body = (
      <PanelBody>
        <ListState state="loading" label={t("inventory.availability.loadingNoun")} />
      </PanelBody>
    );
  } else if (onHand.data) {
    body = <Figures onHand={onHand.data} />;
  } else {
    body = (
      <PanelBody>
        <AtsUnknown />
      </PanelBody>
    );
  }
  return (
    <DetailPanel
      id="inventory-availability"
      index={index}
      title={t("inventory.availability.title")}
      aside={
        asOf ? (
          <span className="inventory__note" data-testid="availability-as-of">
            {t.rich("inventory.availability.asOf", {
              time: <DateTime value={asOf} timeZone={timeZone} />,
            })}
          </span>
        ) : undefined
      }
    >
      {body}
    </DetailPanel>
  );
}
