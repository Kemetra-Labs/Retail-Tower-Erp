/**
 * RT-1011 the sync screen's full pipeline (DESIGN.md §12.2: the sync screen keeps
 * the full pipeline): POS → server → ERPNext on the shared `PipelineRail`, each
 * node's fact in words.
 *
 * Only served facts state a state. The POS node and the server node have no
 * read behind them on this screen (no device-connectivity read, no synced-sale
 * count), so each says so instead of showing a number or a default; the server
 * node links to the sales needing repair. The ERPNext node reads the posting
 * domain of the C3 summary, and a connector that reports ERPNext unreachable
 * (A-3) turns it to failed and shows the "sales are saved" reassurance. No
 * combined "ERP OK" exists (A-4).
 */
import { type PipelineRailNode, PipelineRail } from "@/components/PipelineRail";
import { formatNumber, useT } from "@/i18n";
import { Link } from "react-router";
import { erpNodeView, isLinkDown } from "./erpStatusLogic";
import type { ConnectionsState, SummaryState } from "./useErpStatus";

export function SalePipeline({
  connections,
  summary,
}: Readonly<{ connections: ConnectionsState; summary: SummaryState }>): React.JSX.Element {
  const t = useT();
  const linkDown = isLinkDown(connections.rows);
  const erp = erpNodeView(
    {
      isLoading: summary.isLoading,
      failed: Boolean(summary.error),
      domains: summary.summary?.domains ?? [],
    },
    linkDown,
  );
  const nodes: PipelineRailNode[] = [
    { id: "pos", status: "unknown", fact: t("erp.pipeline.pos.notRead") },
    {
      id: "server",
      status: "unknown",
      fact: t.rich("erp.pipeline.server.noCount", {
        link: <Link to="/sales-needing-repair">{t("erp.pipeline.server.repairLink")}</Link>,
      }),
    },
    {
      id: "erp",
      status: erp.status,
      fact:
        erp.count === undefined
          ? t(erp.factKey)
          : `${t(erp.factKey)} · ${t("erp.summary.count", { count: formatNumber(erp.count) })}`,
    },
  ];
  return (
    <section className="erp-pipeline">
      <PipelineRail nodes={nodes} />
      {linkDown ? <p className="erp-linkdown">{t("erp.linkDown.note")}</p> : null}
    </section>
  );
}
