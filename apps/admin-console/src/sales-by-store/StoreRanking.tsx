/**
 * RT-1054 section 01 «ترتيب المتاجر»: the stores in the server's order, ranked
 * stores first, then the unranked ones under their own heading (D-5). A row is
 * a toggle that picks the store shown in the side panel.
 *
 * A bar is the store's served `share` (a decimal moved in its string); the rank
 * change is the served `baselineRank` in words. Nothing is divided or
 * subtracted (AI-13). The leader's row is the one Ink row (D-V2: Mint is a
 * highlight on Ink only).
 */
import { DetailPanel, PanelBody } from "@/components/DetailPanel";
import { Money, formatMoney, formatNumber, useT } from "@/i18n";
import type { SalesByStore } from "@/lib/sales-by-store-queries";
import { DeltaPill, SharePercent, StatusMark } from "./StoreCells";
import { type StoreRow, barWidth } from "./storeLogic";

interface RowProps {
  row: StoreRow;
  report: SalesByStore;
  comparing: boolean;
  picked: boolean;
  onPick: (ref: string) => void;
}

function Move({ row, comparing }: Readonly<{ row: StoreRow; comparing: boolean }>) {
  const t = useT();
  const { store } = row;
  if (!row.ranked) return <span className="sbs-row__sub">{t("salesByStore.noSales")}</span>;
  if (!comparing) return null;
  if (store.baselineRank === null) {
    return <span className="sbs-row__sub">{t("salesByStore.move.notRankedBefore")}</span>;
  }
  return (
    <span className="sbs-row__sub">
      {t("salesByStore.move.was", { rank: formatNumber(store.baselineRank, t.locale) })}
    </span>
  );
}

function StoreRowButton({ row, report, comparing, picked, onPick }: Readonly<RowProps>) {
  const t = useT();
  const { store } = row;
  const classes = ["sbs-row", row.leader ? "sbs-row--leader" : "", picked ? "sbs-row--on" : ""]
    .filter(Boolean)
    .join(" ");
  const amount = <Money value={store.ranking.total} currency={report.currency} />;
  const label =
    store.rank === null
      ? t("salesByStore.rank.unrankedAria", { name: store.storeName })
      : t("salesByStore.rank.aria", {
          rank: formatNumber(store.rank, t.locale),
          name: store.storeName,
          amount: formatMoney(store.ranking.total, report.currency),
        });
  return (
    <button
      type="button"
      className={classes}
      aria-pressed={picked}
      aria-label={label}
      onClick={() => onPick(store.storeRef)}
    >
      <span className="sbs-row__pos" aria-hidden="true">
        {store.rank === null ? "—" : formatNumber(store.rank, t.locale)}
      </span>
      <span className="sbs-row__name">
        <b>
          <bdi>{store.storeName}</bdi> <StatusMark status={store.storeStatus} />
        </b>
        <Move row={row} comparing={comparing} />
      </span>
      <span className="sbs-track" aria-hidden="true">
        <i style={{ inlineSize: barWidth(row.ranked ? store.ranking.share : null) }} />
        <span className="sbs-track__share">
          {row.ranked ? <SharePercent ratio={store.ranking.share} /> : null}
        </span>
      </span>
      <span className="sbs-row__amount">
        {row.ranked ? amount : <span className="sbs-row__sub">—</span>}
        {row.ranked ? (
          <small>
            {t("salesByStore.sales.count", { count: formatNumber(store.ranking.count, t.locale) })}
          </small>
        ) : null}
      </span>
      {comparing && row.ranked ? <DeltaPill ratio={store.ranking.deltaRatio} /> : <span />}
    </button>
  );
}

export function StoreRanking({
  report,
  rows,
  comparing,
  pickedRef,
  onPick,
}: Readonly<{
  report: SalesByStore;
  rows: readonly StoreRow[];
  comparing: boolean;
  pickedRef: string | undefined;
  onPick: (ref: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const ranked = rows.filter((r) => r.ranked);
  const unranked = rows.filter((r) => !r.ranked);
  const list = (items: readonly StoreRow[]) => (
    <ul className="sbs-rank">
      {items.map((row) => (
        <li key={row.store.storeRef}>
          <StoreRowButton
            row={row}
            report={report}
            comparing={comparing}
            picked={row.store.storeRef === pickedRef}
            onPick={onPick}
          />
        </li>
      ))}
    </ul>
  );
  return (
    <DetailPanel id="sbs-rank-h" title={t("salesByStore.rank.title")} index={1}>
      <PanelBody>
        <p className="sbs-hint">
          {t(comparing ? "salesByStore.rank.hintCompare" : "salesByStore.rank.hint")}
        </p>
        {ranked.length > 0 ? list(ranked) : null}
        {unranked.length > 0 ? (
          <>
            {ranked.length > 0 ? (
              <>
                <h3 className="sbs-subhead">{t("salesByStore.rank.unrankedHeading")}</h3>
                <p className="sbs-hint">{t("salesByStore.rank.unrankedNote")}</p>
              </>
            ) : null}
            {list(unranked)}
          </>
        ) : null}
      </PanelBody>
    </DetailPanel>
  );
}
