/**
 * RT-993 the greeting's pipeline rail (DESIGN.md §12.2, §12.4): POS → server →
 * ERPNext on the shared `PipelineRail` (RT-992), under the greeting. It
 * replaces RT-970's pipeline strip; each node's fact is the same existing read,
 * in words, so the rail reads without colour.
 *
 * - POS: the active-trust device count (`consoleListDevices`). The contract
 *   records no last activity, so the node never claims "online": its status
 *   is `unknown` and a note says why.
 * - Server: today's received count, plus the sales the server failed on
 *   (`SalesKpis.syncStatus`): needing repair is a fault, retrying a caution.
 * - ERPNext: today's four posting buckets as returned
 *   (`SalesKpis.erpPosting`); unknown is its own bucket, never "not posted"
 *   (RT-956). Failed is a fault; pending or unknown a caution.
 *
 * A node with no source says «غير متاح»; the rail keeps its shape. The screens
 * behind the nodes are linked beside the rail, only where the role may go.
 */
import {
  PipelineRail,
  type PipelineRailNode,
  type PipelineRailStatus,
} from "@/components/PipelineRail";
import { canReadDevices } from "@/devices/deviceLogic";
import { canReadErpStatus } from "@/erp-status/erpStatusLogic";
import { type MessageKey, useT } from "@/i18n";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import type { SalesKpis } from "@/metrics/metricRegistry";
import { canUseSaleSyncOps } from "@/sale-sync/saleSyncLogic";
import { Link } from "react-router";
import { PanelError, Unavailable } from "./PanelParts";
import { type GlanceDay, glanceDay } from "./glanceLogic";
import type { PageCount } from "./overviewLogic";
import { salesDrillDown } from "./salesTodayLogic";
import type { OverviewSession } from "./useOverviewPanels";
import type { PanelState } from "./usePanelQuery";

type Ready = Extract<GlanceDay, { state: "ready" }>;
type T = ReturnType<typeof useT>;

/** Today's bucket, when the read has one: the server and ERPNext nodes need it. */
function todayOf(state: PanelState<SalesSummary>): { day: Ready; summary: SalesSummary } | null {
  if (state.status !== "ready") return null;
  const day = glanceDay(state.data);
  return day.state === "ready" && day.today ? { day, summary: state.data } : null;
}

/** A fact while its read is not ready: loading words, or «غير متاح». */
function pendingFact(state: PanelState<unknown>, t: T): React.ReactNode {
  return state.status === "loading" ? t("overview.row.loading") : <Unavailable />;
}

function deviceFact(count: PageCount, t: T): string {
  if (count.kind === "exact") return t("overview.pipeline.devices", { count: count.count });
  if (count.kind === "atLeast")
    return t("overview.pipeline.devicesAtLeast", { count: count.count });
  if (count.kind === "none") return t("overview.pipeline.devices", { count: 0 });
  return t("overview.count.unproven");
}

function parts(t: T, entries: readonly [MessageKey, number][]): string[] {
  return entries
    .filter(([, n]) => n > 0)
    .map(([label, count]) => t("metrics.claim.part", { label: t(label), count }));
}

function serverNode(kpis: SalesKpis, t: T): Omit<PipelineRailNode, "id"> {
  const { failedNeedsRepair, failedRetryable } = kpis.syncStatus;
  const status: PipelineRailStatus =
    failedNeedsRepair > 0 ? "failed" : failedRetryable > 0 ? "attention" : "ok";
  const fact = [
    t("overview.pipeline.received", { count: kpis.receivedSales.count }),
    ...parts(t, [
      ["metrics.part.failedNeedsRepair", failedNeedsRepair],
      ["metrics.part.failedRetryable", failedRetryable],
    ]),
  ].join(" · ");
  return { status, fact };
}

function erpNode(kpis: SalesKpis, t: T): Omit<PipelineRailNode, "id"> {
  const { posted, pending, failed, unknown } = kpis.erpPosting;
  const status: PipelineRailStatus =
    failed > 0 ? "failed" : pending > 0 || unknown > 0 ? "attention" : "ok";
  const fact = [
    t("overview.pipeline.posted", { posted, received: kpis.receivedSales.count }),
    ...parts(t, [
      ["metrics.part.pending", pending],
      ["metrics.part.failed", failed],
      ["metrics.part.unknown", unknown],
    ]),
  ].join(" · ");
  return { status, fact };
}

function erpLink(role: string | null, t: T): { to: string; text: string } | null {
  if (canUseSaleSyncOps(role)) {
    return { to: "/sales-needing-repair", text: t("overview.pipeline.openRepair") };
  }
  if (canReadErpStatus(role)) {
    return { to: "/erp-connection", text: t("overview.pipeline.openConnection") };
  }
  return null;
}

export function SaleRail({
  session,
  summary,
  devices,
}: Readonly<{
  session: OverviewSession;
  summary: PanelState<SalesSummary>;
  devices: PanelState<PageCount>;
}>): React.JSX.Element {
  const t = useT();
  const today = todayOf(summary);
  // A ready read with no single today (mixed days, no stores) has no node fact;
  // a failed one is the receipt row's error (one alert, one retry).
  const summaryState: PanelState<unknown> =
    summary.status === "loading" ? summary : { status: "hidden" };
  const kpis = today?.day.today ?? null;
  const nodes: PipelineRailNode[] = [
    {
      id: "pos",
      status: "unknown",
      fact: devices.status === "ready" ? deviceFact(devices.data, t) : pendingFact(devices, t),
    },
    kpis
      ? { id: "server", ...serverNode(kpis, t) }
      : { id: "server", status: "unknown", fact: pendingFact(summaryState, t) },
    kpis
      ? { id: "erp", ...erpNode(kpis, t) }
      : { id: "erp", status: "unknown", fact: pendingFact(summaryState, t) },
  ];
  const links = [
    canReadDevices(session.role)
      ? { to: "/devices", text: t("overview.pipeline.openDevices") }
      : null,
    today
      ? {
          to:
            today.summary.scope === "store" && today.summary.storeRef
              ? salesDrillDown(today.summary.storeRef, today.day.date)
              : "/sales",
          text: t("overview.pipeline.openSales"),
        }
      : null,
    erpLink(session.role, t),
  ].filter((link): link is { to: string; text: string } => link !== null);
  return (
    <div className="overview-rail">
      <PipelineRail nodes={nodes} />
      {links.length > 0 ? (
        <nav aria-label={t("overview.pipeline.links")}>
          <ul className="overview-rail__links">
            {links.map((link) => (
              <li key={link.to}>
                <Link className="ledger__link" to={link.to}>
                  {link.text}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <p className="overview-rail__note">{t("overview.pipeline.posNote")}</p>
      {devices.status === "error" ? (
        <PanelError requestId={devices.requestId} retry={devices.retry} />
      ) : null}
    </div>
  );
}
