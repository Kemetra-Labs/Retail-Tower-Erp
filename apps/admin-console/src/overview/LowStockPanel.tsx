/**
 * RT-1073 the Overview low-stock widget (DESIGN.md §12.4): items in server
 * order, a level bar per item from the contract ratio, red only for `critical`.
 * Loading, empty, unconfigured and error are distinct; a refusal hides the block.
 */
import { useT } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { consoleListLowStock } from "@/lib/low-stock-queries";
import type { LowStockItem, LowStockList } from "@/lib/low-stock-queries";
import { useId } from "react";
import { PanelError, PanelSkeleton } from "./PanelParts";
import {
  asLowStock,
  canReadLowStock,
  fillPercent,
  toneOf,
  trimQuantity,
  viewOf,
} from "./lowStockLogic";
import type { OverviewSession } from "./useOverviewPanels";
import { type PanelState, overviewKey, readResult, usePanelQuery } from "./usePanelQuery";

export function useLowStock(session: OverviewSession): PanelState<LowStockList> {
  return usePanelQuery({
    key: overviewKey("low-stock", session),
    gate: canReadLowStock(session.role) ? "run" : "skip",
    read: async () =>
      readResult(
        await consoleListLowStock(session.activeStoreId ? { store_id: session.activeStoreId } : {}),
        asLowStock,
      ),
  });
}

function Item({ item }: Readonly<{ item: LowStockItem }>) {
  const t = useT();
  const tone = toneOf(item);
  const unit = item.stockingUnit ?? "";
  const onHand = trimQuantity(item.sellableOnHand);
  const level = trimQuantity(item.reorderLevel);
  const text = t("overview.lowStock.levelText", {
    onHand: `${onHand} ${unit}`.trim(),
    level: `${level} ${unit}`.trim(),
    band: t(tone === "critical" ? "overview.lowStock.band.critical" : "overview.lowStock.band.low"),
  });
  return (
    <li className={`low-stock__item low-stock__item--${tone}`}>
      <div className="low-stock__name">
        <span className="low-stock__product">{item.productName}</span>
        <span className="low-stock__store">
          {item.storeName}
          {item.storeStatus === "inactive" ? ` · ${t("overview.lowStock.storeInactive")}` : ""}
        </span>
      </div>
      {/* The bar is decorative: its text equivalent is the line below. */}
      <span className="low-stock__bar" aria-hidden="true">
        <span className="low-stock__fill" style={{ width: `${fillPercent(item.levelRatio)}%` }} />
      </span>
      <span className="low-stock__text">{text}</span>
    </li>
  );
}

function Body({ list }: Readonly<{ list: LowStockList }>) {
  const t = useT();
  const view = viewOf(list);
  if (view.kind === "unconfigured") {
    return <p className="soon-panel__note">{t("overview.lowStock.unconfigured")}</p>;
  }
  if (view.kind === "none") {
    return <p className="soon-panel__note">{t("overview.lowStock.none")}</p>;
  }
  return (
    <>
      <p className="low-stock__summary">
        {t("overview.lowStock.summary", {
          below: formatNumber(list.belowReorderCount),
          critical: formatNumber(list.criticalCount),
        })}
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: the explicit list role is the Safari workaround. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics from a marker-free list. */}
      <ul className="low-stock" role="list">
        {list.items.map((item) => (
          <Item key={`${item.storeId}:${item.productId}`} item={item} />
        ))}
      </ul>
      {list.truncated ? (
        <p className="low-stock__more">
          {t("overview.lowStock.truncated", {
            shown: formatNumber(list.items.length),
            total: formatNumber(list.belowReorderCount),
          })}
        </p>
      ) : null}
    </>
  );
}

export function LowStockPanel({ session }: Readonly<{ session: OverviewSession }>) {
  const t = useT();
  const titleId = useId();
  const state = useLowStock(session);
  if (state.status === "hidden") return null;
  return (
    <section className="section-panel" aria-labelledby={titleId}>
      <div className="section-panel__head">
        <h2 id={titleId} className="section-panel__title">
          {t("overview.lowStock.title")}
        </h2>
      </div>
      <div className="section-panel__body">
        {state.status === "loading" ? <PanelSkeleton lines={3} /> : null}
        {state.status === "error" ? (
          <PanelError requestId={state.requestId} retry={state.retry} />
        ) : null}
        {state.status === "ready" ? <Body list={state.data} /> : null}
      </div>
    </section>
  );
}
