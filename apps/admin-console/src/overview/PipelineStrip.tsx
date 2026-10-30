/**
 * RT-970 the pipeline strip (canvas direction C): a sale's path from the till
 * to ERPNext in three numbered steps, each from an existing read and linked to
 * the screen that owns it, when the role may open it.
 *
 * ① Points of sale: the active-trust device count (`consoleListDevices`). The
 *   contract records no last activity, so the step never claims "online".
 * ② Received by the server: today's received count (`SalesKpis.receivedSales`).
 * ③ ERPNext: today's four posting buckets (`SalesKpis.erpPosting`), as
 *   returned; Unknown is its own bucket and never "not posted" (RT-956).
 *
 * A step with no source shows «غير متاح»; the strip keeps its shape.
 */
import { canReadDevices } from "@/devices/deviceLogic";
import { canReadErpStatus } from "@/erp-status/erpStatusLogic";
import { DateTime, type MessageKey, useT } from "@/i18n";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import { canUseSaleSyncOps } from "@/sale-sync/saleSyncLogic";
import { Link } from "react-router";
import { PanelError, Unavailable } from "./PanelParts";
import { type GlanceDay, type PostingSplit, glanceDay, postingSplit } from "./glanceLogic";
import type { PageCount } from "./overviewLogic";
import { salesDrillDown } from "./salesTodayLogic";
import type { OverviewSession } from "./useOverviewPanels";
import type { PanelState } from "./usePanelQuery";

function Step({
  index,
  title,
  link,
  children,
}: Readonly<{
  index: number;
  title: string;
  link: { to: string; text: string } | null;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <li className="pipeline__step">
      <span className="pipeline__title">
        <span className="pipeline__index" aria-hidden="true">
          {index}
        </span>
        {title}
      </span>
      {children}
      {link ? (
        <Link className="ledger__link pipeline__link" to={link.to}>
          {link.text}
        </Link>
      ) : null}
    </li>
  );
}

/** A step's figure while its read is not ready: a placeholder, an error, or no source. */
function NotReady({ state }: Readonly<{ state: PanelState<unknown> }>): React.JSX.Element {
  const t = useT();
  if (state.status === "loading") {
    return (
      <span className="pipeline__value glance-skeleton__bar" aria-busy="true">
        <span className="sr-only">{t("overview.row.loading")}</span>
      </span>
    );
  }
  if (state.status === "error")
    return <PanelError requestId={state.requestId} retry={state.retry} />;
  return (
    <span className="pipeline__value">
      <Unavailable />
    </span>
  );
}

function DeviceFigure({ count }: Readonly<{ count: PageCount }>): React.JSX.Element {
  const t = useT();
  const text =
    count.kind === "exact"
      ? t("overview.pipeline.devices", { count: count.count })
      : count.kind === "atLeast"
        ? t("overview.pipeline.devicesAtLeast", { count: count.count })
        : count.kind === "none"
          ? t("overview.pipeline.devices", { count: 0 })
          : t("overview.count.unproven");
  return <span className="pipeline__value">{text}</span>;
}

const PARTS: readonly { key: keyof PostingSplit; label: MessageKey; tone: string }[] = [
  { key: "pending", label: "metrics.part.pending", tone: "info" },
  { key: "failed", label: "metrics.part.failed", tone: "danger" },
  { key: "unknown", label: "metrics.part.unknown", tone: "danger" },
];

function PostingFigure({ split }: Readonly<{ split: PostingSplit }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <span className="pipeline__value">
        {t("overview.pipeline.posted", { posted: split.posted, received: split.received })}
      </span>
      <span className="pipeline__parts">
        {PARTS.map((part) => (
          <span
            key={part.key}
            className={`pipeline__part${split[part.key] > 0 ? ` pipeline__part--${part.tone}` : ""}`}
          >
            {t("metrics.claim.part", { label: t(part.label), count: split[part.key] })}
          </span>
        ))}
      </span>
    </>
  );
}

type Ready = Extract<GlanceDay, { state: "ready" }>;

/** Today's bucket, when the read has one: steps ② and ③ need it. */
function todayOf(state: PanelState<SalesSummary>): { day: Ready; summary: SalesSummary } | null {
  if (state.status !== "ready") return null;
  const day = glanceDay(state.data);
  return day.state === "ready" && day.today ? { day, summary: state.data } : null;
}

function erpLink(role: string | null, t: ReturnType<typeof useT>) {
  if (canUseSaleSyncOps(role)) {
    return { to: "/sales-needing-repair", text: t("overview.pipeline.openRepair") };
  }
  if (canReadErpStatus(role)) {
    return { to: "/erp-connection", text: t("overview.pipeline.openConnection") };
  }
  return null;
}

export function PipelineStrip({
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
  // A ready read with no single today (mixed days, no stores) has no step
  // figure; a failed one is the KPI strip's error (one alert, one retry).
  const summaryState: PanelState<unknown> =
    summary.status === "loading" ? summary : { status: "hidden" };
  const salesLink = today
    ? today.summary.scope === "store" && today.summary.storeRef
      ? salesDrillDown(today.summary.storeRef, today.day.date)
      : "/sales"
    : "/sales";
  return (
    <section className="section-panel" aria-label={t("overview.pipeline.label")}>
      <ol className="pipeline">
        <Step
          index={1}
          title={t("overview.pipeline.pos")}
          link={
            canReadDevices(session.role)
              ? { to: "/devices", text: t("overview.pipeline.openDevices") }
              : null
          }
        >
          {devices.status === "ready" ? (
            <DeviceFigure count={devices.data} />
          ) : (
            <NotReady state={devices} />
          )}
          <span className="pipeline__note">{t("overview.pipeline.posNote")}</span>
        </Step>
        <Step
          index={2}
          title={t("overview.pipeline.server")}
          link={today ? { to: salesLink, text: t("overview.pipeline.openSales") } : null}
        >
          {today?.day.today ? (
            <>
              <span className="pipeline__value">
                {t("overview.pipeline.received", {
                  count: today.day.today.receivedSales.count,
                })}
              </span>
              <span className="pipeline__note">
                {t.rich("overview.pipeline.asOf", {
                  asOf: <DateTime value={today.summary.asOf} />,
                })}
              </span>
            </>
          ) : (
            <NotReady state={summaryState} />
          )}
        </Step>
        <Step index={3} title={t("overview.pipeline.erp")} link={erpLink(session.role, t)}>
          {today?.day.today ? (
            <PostingFigure split={postingSplit(today.day.today)} />
          ) : (
            <NotReady state={summaryState} />
          )}
        </Step>
      </ol>
    </section>
  );
}
