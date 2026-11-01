/**
 * RT-1054 small presentational parts shared by the ranking, the panel and the
 * exact table. Nothing here calculates: each part prints a served string, or a
 * served string with its decimal point moved (`percentOf`), in words and signs,
 * never by colour alone (D-11 colours reinforce the sign).
 */
import { type MessageKey, Money, formatNumber, useT } from "@/i18n";
import type { MoneyFacts, StoreSalesByStore } from "@/lib/sales-by-store-queries";
import { percentOf } from "./storeLogic";

/** `+6.40%` / `−25.00%` / `0.00%`; the sign is the only thing besides colour that tells the direction. */
export function DeltaPill({
  ratio,
  className,
}: Readonly<{ ratio: string | null; className?: string }>): React.JSX.Element {
  const t = useT();
  const percent = percentOf(ratio);
  if (!percent) {
    return (
      <span
        className={`sbs-delta sbs-delta--none ${className ?? ""}`.trim()}
        title={t("salesByStore.delta.none")}
      >
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("salesByStore.delta.none")}</span>
      </span>
    );
  }
  const sign = percent.direction === "up" ? "+" : percent.direction === "down" ? "−" : "";
  const text = `${sign}${percent.digits}%`;
  return (
    <span className={`sbs-delta sbs-delta--${percent.direction} ${className ?? ""}`.trim()}>
      <bdi dir="ltr" aria-label={t("salesByStore.delta.aria", { delta: text })}>
        {text}
      </bdi>
    </span>
  );
}

/** A served ratio as a percentage without a sign (a share). */
export function SharePercent({ ratio }: Readonly<{ ratio: string | null }>): React.JSX.Element {
  const t = useT();
  const percent = percentOf(ratio);
  if (!percent) return <span className="sr-only">{t("salesByStore.notAvailable")}</span>;
  return <bdi dir="ltr">{`${percent.digits}%`}</bdi>;
}

/** The count of a served fact, then one line per currency; currencies are never added. */
export function FactsLines({ facts }: Readonly<{ facts: MoneyFacts }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <span className="sbs-count">{formatNumber(facts.count, t.locale)}</span>
      {facts.byCurrency.length > 0 ? (
        <ul className="sbs-lines">
          {facts.byCurrency.map((c) => (
            <li key={c.currencyCode}>
              <Money value={c.total} currency={c.currencyCode} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

const STATUS_KEY = {
  inactive: "salesByStore.status.inactive",
  deleted: "salesByStore.status.deleted",
} as const satisfies Record<string, MessageKey>;

/** A word for a store that is not active; an active store has none. */
export function StatusMark({
  status,
}: Readonly<{ status: StoreSalesByStore["storeStatus"] }>): React.JSX.Element | null {
  const t = useT();
  if (status === "active") return null;
  return <span className="sbs-status">{t(STATUS_KEY[status])}</span>;
}
