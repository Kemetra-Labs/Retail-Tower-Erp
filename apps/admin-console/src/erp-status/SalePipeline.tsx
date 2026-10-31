/**
 * RT-1011 the sync screen's full pipeline (DESIGN.md §12.2: the sync screen keeps
 * the full pipeline): POS → server → ERPNext on the shared `PipelineRail`, each
 * node's fact in words.
 *
 * Only served facts state a state. The POS node and the server node have no
 * read behind them on this screen (no device-connectivity read, no synced-sale
 * count), so each says so instead of showing a number or a default; the server
 * node links to the sales needing repair. The ERPNext node reads the posting
 * domain of the C3 summary (no count: the tile below states it with its scope).
 * A connector that is live and reports ERPNext unreachable (A-3) turns it to a
 * fault, labelled with the environment of the registrations that report it and dated, and shows the "sales are saved" reassurance the
 * Sync-states board draws for that state. No combined "ERP OK" exists (A-4).
 */
import { PipelineRail, type PipelineRailNode } from "@/components/PipelineRail";
import { DateTime, useT } from "@/i18n";
import { Link } from "react-router";
import { envKey } from "./ConnectionPanel";
import { erpNodeView, oldestRead, unreachableRows } from "./erpStatusLogic";
import type { ConnectionsState, SummaryState } from "./useErpStatus";

export function SalePipeline({
  connections,
  summary,
  filtered,
}: Readonly<{
  connections: ConnectionsState;
  summary: SummaryState;
  /** A store filter narrows the C3 summary. */
  filtered: boolean;
}>): React.JSX.Element {
  const t = useT();
  const down = unreachableRows(connections.rows);
  const linkDown = down.length > 0;
  const erp = erpNodeView(
    {
      isLoading: summary.isLoading,
      failed: Boolean(summary.error),
      filtered,
      noConnector: !connections.isLoading && !connections.error && connections.rows.length === 0,
      domains: summary.summary?.domains ?? [],
    },
    linkDown,
  );
  // The report's time is the oldest of the faulting registrations': never fresher than the data.
  const reportedAt = oldestRead(
    down.map((row) =>
      row.health?.reportedFieldsAt ? Date.parse(row.health.reportedFieldsAt) : undefined,
    ),
  );
  const erpFact = linkDown ? (
    <>
      {[...new Set(down.map((row) => envKey(row.instance.environment)))].map((key, i) => (
        <span key={key}>
          {i > 0 ? t("erp.pipeline.listSeparator") : null}
          {t(key)}
        </span>
      ))}
      {" · "}
      {t(erp.factKey)}
      {reportedAt === undefined ? null : (
        <>
          {" · "}
          {t.rich("erp.conn.reportedAt", {
            time: <DateTime value={new Date(reportedAt).toISOString()} />,
          })}
        </>
      )}
    </>
  ) : (
    t(erp.factKey)
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
    { id: "erp", status: erp.status, fact: erpFact },
  ];
  return (
    <div className="erp-pipeline">
      <PipelineRail nodes={nodes} />
      {linkDown ? <p className="erp-linkdown">{t("erp.linkDown.note")}</p> : null}
    </div>
  );
}
