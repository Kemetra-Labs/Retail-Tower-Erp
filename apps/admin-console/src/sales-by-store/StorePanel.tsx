/**
 * RT-1054 the selected store's side panel: its rank, served total, share, the
 * served average sale, returns, voids and legacy refunds, best day and one line
 * per business day. The board's sparkline needs each day divided by the
 * largest, which the Console may not do (AI-13), so the days are listed with
 * their served amount and a state in words. The board's return rate is gone
 * (D-12: returns and sales are bucketed on different dates).
 */
import { Money, formatNumber, useT } from "@/i18n";
import type { SalesByStore } from "@/lib/sales-by-store-queries";
import { BusinessDate } from "@/sales/SaleParts";
import { Link } from "react-router";
import { DeltaPill, FactsLines, SharePercent, StatusMark } from "./StoreCells";
import { DAY_STATE_MARK, type StoreRow } from "./storeLogic";

function Line({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="sbs-panel__line">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Unavailable(): React.JSX.Element {
  const t = useT();
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t("salesByStore.notAvailable")}</span>
    </>
  );
}

export function StorePanel({
  report,
  row,
  comparing,
}: Readonly<{ report: SalesByStore; row: StoreRow; comparing: boolean }>): React.JSX.Element {
  const t = useT();
  const { store } = row;
  const ranking = store.ranking;
  const heading =
    store.rank === null
      ? t("salesByStore.panel.unranked")
      : t("salesByStore.panel.rank", { rank: formatNumber(store.rank, t.locale) });
  return (
    <aside className="sbs-panel" aria-labelledby="sbs-panel-h" aria-live="polite">
      <div className="sbs-panel__head">
        <span className="sbs-panel__eyebrow">{heading}</span>
        <h2 id="sbs-panel-h" className="sbs-panel__name">
          <bdi>{store.storeName}</bdi> <StatusMark status={store.storeStatus} />
        </h2>
        <span className="sbs-panel__total">
          <Money value={ranking.total} currency={report.currency} />
        </span>
        <span className="sbs-panel__eyebrow">
          {t.rich("salesByStore.panel.shareLine", {
            share: <SharePercent ratio={ranking.share} />,
            count: formatNumber(ranking.count, t.locale),
          })}
        </span>
        <span className="sbs-panel__eyebrow">
          {t.rich("metrics.context.zone", { zone: <bdi dir="ltr">{store.storeTimezone}</bdi> })}
        </span>
      </div>
      <dl className="sbs-panel__lines">
        {comparing ? (
          <>
            <Line label={t("salesByStore.panel.vsPrevious")}>
              <DeltaPill ratio={ranking.deltaRatio} />
            </Line>
            <Line label={t("salesByStore.panel.previousTotal")}>
              {ranking.baselineTotal === null ? (
                <Unavailable />
              ) : (
                <Money value={ranking.baselineTotal} currency={report.currency} />
              )}
            </Line>
          </>
        ) : null}
        <Line label={t("salesByStore.panel.average")}>
          {ranking.averageSale === null ? (
            <Unavailable />
          ) : (
            <>
              <Money value={ranking.averageSale} currency={report.currency} />{" "}
              <small>{t("salesByStore.panel.averageNote")}</small>
            </>
          )}
        </Line>
        <Line label={t("salesByStore.panel.returns")}>
          <FactsLines facts={store.facts.returns} />
        </Line>
        <Line label={t("salesByStore.panel.voids")}>
          <FactsLines facts={store.facts.voids} />
        </Line>
        <Line label={t("salesByStore.panel.legacyRefunds")}>
          <FactsLines facts={store.facts.legacyRefunds} />
        </Line>
        <Line label={t("salesByStore.panel.bestDay")}>
          {ranking.bestDay === null ? (
            <Unavailable />
          ) : (
            <>
              <BusinessDate value={ranking.bestDay.businessDate} />{" "}
              <Money value={ranking.bestDay.total} currency={report.currency} />
            </>
          )}
        </Line>
      </dl>
      <h3 className="sbs-subhead sbs-subhead--panel">{t("salesByStore.panel.days")}</h3>
      <ul className="sbs-days">
        {ranking.days.map((d) => {
          const mark = DAY_STATE_MARK[d.state];
          return (
            <li key={d.businessDate}>
              <span>
                <BusinessDate value={d.businessDate} />
                {mark ? <span className="sbs-days__mark"> {t(mark)}</span> : null}
              </span>
              <Money value={d.total} currency={report.currency} />
            </li>
          );
        })}
      </ul>
      <Link className="sbs-panel__link" to={`/stores/${store.storeRef}`}>
        {t("salesByStore.panel.storeLink")}
      </Link>
    </aside>
  );
}
