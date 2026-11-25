/**
 * Modern concept 1/6 — the Overview's smart insight (rule 4): one note at the
 * top of the page saying what matters today, with a link to what needs doing.
 * Computed only from reads the Overview already makes, nothing invented:
 *
 * - Failed ERPNext postings and sales needing repair come from the shared
 *   `consoleGetSalesSummary` read (`glanceDay` of the same `summary` the
 *   receipt row, rail, trend and posting ring use).
 * - Critically low items come from the low-stock read (`useLowStock`, the
 *   same query key the side column's `LowStockPanel` reads, so no second
 *   request).
 *
 * Priority is the most urgent thing first: failed postings, then sales
 * needing repair, then critically low stock. The call to action goes to
 * `/sales-needing-repair` only where the role may open it
 * (`canUseSaleSyncOps`, the same gate as the side column's repair action);
 * critically low stock has no owning screen to link to (the low-stock panel
 * itself links nowhere), so it states the count with no link. The quiet line
 * claims only what the summary proves (no failed postings, nothing needing
 * repair) — never anything about stock while that read is still pending.
 * While the summary is not ready, or it has no single today, the note renders
 * nothing: the receipt row already carries the loading and error states.
 */
import { type MessageKey, useT } from "@/i18n";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import { canUseSaleSyncOps } from "@/sale-sync/saleSyncLogic";
import { useId } from "react";
import { Link } from "react-router";
import { useLowStock } from "./LowStockPanel";
import { glanceDay, postingSplit } from "./glanceLogic";
import type { OverviewSession } from "./useOverviewPanels";
import type { PanelState } from "./usePanelQuery";

type InsightKind = "failedPosting" | "needsRepair" | "criticalStock" | "clear";

const INSIGHT_TEXT = {
  failedPosting: "overview.insight.failedPosting",
  needsRepair: "overview.insight.needsRepair",
  criticalStock: "overview.insight.criticalStock",
  clear: "overview.insight.clear",
} as const satisfies Record<InsightKind, MessageKey>;

/** The one thing that matters today, or null while its reads are not ready. */
function insightOf(
  summary: PanelState<SalesSummary>,
  critical: number | null,
): { kind: InsightKind; count?: number } | null {
  if (summary.status !== "ready") return null;
  const day = glanceDay(summary.data);
  if (day.state !== "ready" || !day.today) return null;
  const failed = postingSplit(day.today).failed;
  if (failed > 0) return { kind: "failedPosting", count: failed };
  const repair = day.today.syncStatus.failedNeedsRepair;
  if (repair > 0) return { kind: "needsRepair", count: repair };
  if (critical !== null && critical > 0) return { kind: "criticalStock", count: critical };
  return { kind: "clear" };
}

export function SmartInsight({
  session,
  summary,
}: Readonly<{
  session: OverviewSession;
  summary: PanelState<SalesSummary>;
}>): React.JSX.Element | null {
  const t = useT();
  const titleId = useId();
  const lowStock = useLowStock(session);
  const critical = lowStock.status === "ready" ? lowStock.data.criticalCount : null;
  const insight = insightOf(summary, critical);
  if (!insight) return null;
  const cta =
    (insight.kind === "failedPosting" || insight.kind === "needsRepair") &&
    canUseSaleSyncOps(session.role);
  return (
    <section className="overview-insight" aria-labelledby={titleId}>
      <div className="overview-insight__body">
        <h2 id={titleId} className="overview-insight__title">
          {t("overview.insight.title")}
        </h2>
        <p className="overview-insight__text">
          {insight.count === undefined
            ? t(INSIGHT_TEXT[insight.kind])
            : t(INSIGHT_TEXT[insight.kind], { count: insight.count })}
        </p>
      </div>
      {cta ? (
        <Link className="ledger__link overview-insight__cta" to="/sales-needing-repair">
          {t("overview.pipeline.openRepair")}
        </Link>
      ) : null}
    </section>
  );
}
