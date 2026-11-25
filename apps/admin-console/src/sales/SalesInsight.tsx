/**
 * Modern concept 2/6 — the Sales list's smart insight (rule 4): one note at
 * the top of the page saying what matters in the list, with a link to what
 * needs doing. Computed only from the rows the list already loaded — the
 * same `consoleListSales` pages `SaleList` reads — nothing invented, no new
 * read, and no total over a walk that may still be going: the counts say
 * "shown", so they stay true after every Load more.
 *
 * Priority is the most urgent thing first: failed ERPNext postings, then
 * sales needing repair. The call to action goes to `/sales-needing-repair`
 * only where the role may open it (`canUseSaleSyncOps`, the same gate as the
 * Overview's insight). It renders nothing while nothing is loaded, while
 * the list is loading or failed, or when no loaded row needs attention: the
 * empty, error and loading states already speak, and a quiet list claims
 * nothing — never an "all clear" over a partial walk.
 */
import { type MessageKey, useT } from "@/i18n";
import { canUseSaleSyncOps } from "@/sale-sync/saleSyncLogic";
import { useId } from "react";
import { Link } from "react-router";
import type { SaleListState } from "./useSales";

type InsightKind = "failedPosting" | "needsRepair";

const INSIGHT_TEXT = {
  failedPosting: "sales.insight.failedPosting",
  needsRepair: "sales.insight.needsRepair",
} as const satisfies Record<InsightKind, MessageKey>;

/**
 * What the loaded rows say needs attention, or null when nothing does. Only
 * the two states the insight names are read; a voided or returned row is not
 * attention on its own. A row that both failed to post and needs repair
 * counts in both, but only the failed-posting line shows (priority above).
 */
export function salesInsightOf(
  rows: readonly { syncStatus: string; erpPostingState: string }[],
): { kind: InsightKind; count: number } | null {
  const failed = rows.filter((s) => s.erpPostingState === "failed").length;
  if (failed > 0) return { kind: "failedPosting", count: failed };
  const repair = rows.filter((s) => s.syncStatus === "failed-needs-repair").length;
  if (repair > 0) return { kind: "needsRepair", count: repair };
  return null;
}

export function SalesInsight({
  list,
  role,
}: Readonly<{
  list: SaleListState;
  role: string | null;
}>): React.JSX.Element | null {
  const t = useT();
  const titleId = useId();
  if (list.isLoading || list.error || list.rows.length === 0) return null;
  const insight = salesInsightOf(list.rows);
  if (!insight) return null;
  const cta = canUseSaleSyncOps(role);
  return (
    <section className="sales-insight" aria-labelledby={titleId}>
      <div className="sales-insight__body">
        <h2 id={titleId} className="sales-insight__title">
          {t("sales.insight.title")}
        </h2>
        <p className="sales-insight__text">
          {t(INSIGHT_TEXT[insight.kind], { count: insight.count })}
        </p>
      </div>
      {cta ? (
        <Link className="ledger__link sales-insight__cta" to="/sales-needing-repair">
          {t("overview.pipeline.openRepair")}
        </Link>
      ) : null}
    </section>
  );
}
