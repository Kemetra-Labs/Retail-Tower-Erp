/**
 * RT-993 the part-to-whole chart (DESIGN.md §12.4, D-V7): today's received
 * sales by ERPNext posting state. The board draws sales by category; no
 * category read exists, so the Overview shows the one whole the contract
 * defines: the four `SalesKpis.erpPosting` buckets add up to
 * `receivedSales.count` for the same business day.
 *
 * - It answers one stated question: of today's received sales, how many has
 *   ERPNext posted?
 * - Four parts at most (≤ 5, UX-13.20), in `--color-viz-cat-1..4`, never the
 *   status colours (UX-13.12). The ring is a picture (`role="img"`); the legend
 *   beside it is a real `<table>` (state, count, share), so identity never rests
 *   on colour (UX-13.14/16).
 * - A share names its whole, today's received count. With no sale received
 *   there is no whole: the panel says so instead of drawing 0/0.
 * - Unknown is its own bucket and never "not posted" (RT-956); the panel says so.
 */
import { SectionIndex } from "@/components/SectionIndex";
import { type MessageKey, intlTag, useLocale, useT } from "@/i18n";
import type { SalesSummary } from "@/lib/sales-summary-queries";
import { metricDefinition } from "@/metrics/metricRegistry";
import { useId } from "react";
import { PanelError, PanelSkeleton, Unavailable } from "./PanelParts";
import { type PostingSplit, glanceDay, postingSplit, shareOf } from "./glanceLogic";
import type { PanelState } from "./usePanelQuery";

type Part = Exclude<keyof PostingSplit, "received">;

const PARTS: readonly { key: Part; label: MessageKey }[] = [
  { key: "posted", label: "metrics.part.posted" },
  { key: "pending", label: "metrics.part.pending" },
  { key: "failed", label: "metrics.part.failed" },
  { key: "unknown", label: "metrics.part.unknown" },
];

const RADIUS = 52;
const STROKE = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** The surface gap between two arcs, in user units along the circle. */
const GAP = 2;

function Ring({ split, label }: Readonly<{ split: PostingSplit; label: string }>) {
  const t = useT();
  const shown = PARTS.filter((p) => split[p.key] > 0);
  let offset = 0;
  return (
    <div className="posting-ring__figure">
      <svg
        className="posting-ring__svg"
        role="img"
        aria-label={label}
        viewBox="0 0 132 132"
        focusable="false"
      >
        <circle className="posting-ring__track" cx={66} cy={66} r={RADIUS} strokeWidth={STROKE} />
        {shown.map((p) => {
          const length = (split[p.key] / split.received) * CIRCUMFERENCE;
          const gap = shown.length > 1 ? Math.min(GAP, length / 2) : 0;
          const arc = (
            <circle
              key={p.key}
              className={`posting-ring__arc posting-ring__arc--${p.key}`}
              cx={66}
              cy={66}
              r={RADIUS}
              strokeWidth={STROKE}
              strokeDasharray={`${length - gap} ${CIRCUMFERENCE - length + gap}`}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return arc;
        })}
      </svg>
      <span className="posting-ring__center" aria-hidden="true">
        <bdi dir="ltr" className="posting-ring__total">
          {split.received}
        </bdi>
        <span className="posting-ring__total-label">{t("overview.posting.center")}</span>
      </span>
    </div>
  );
}

function Legend({ split }: Readonly<{ split: PostingSplit }>) {
  const t = useT();
  const percent = new Intl.NumberFormat(intlTag(useLocale()), {
    style: "percent",
    maximumFractionDigits: 1,
  });
  return (
    <table className="glance-table posting-ring__table">
      <caption className="sr-only">
        {t("overview.posting.caption", { received: split.received })}
      </caption>
      <thead>
        <tr>
          <th scope="col">{t("overview.posting.colState")}</th>
          <th scope="col">{t("overview.posting.colCount")}</th>
          <th scope="col">{t("overview.posting.colShare")}</th>
        </tr>
      </thead>
      <tbody>
        {PARTS.map((p) => (
          <tr key={p.key}>
            <th scope="row">
              <span
                className={`posting-ring__swatch posting-ring__swatch--${p.key}`}
                aria-hidden="true"
              />
              {t(p.label)}
            </th>
            <td className="glance-table__num">
              <bdi dir="ltr">{split[p.key]}</bdi>
            </td>
            <td className="glance-table__num">
              <bdi dir="ltr">{percent.format(shareOf(split[p.key], split.received) ?? 0)}</bdi>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Body({ summary }: Readonly<{ summary: SalesSummary }>): React.JSX.Element {
  const t = useT();
  const day = glanceDay(summary);
  if (day.state !== "ready" || !day.today) {
    return (
      <p className="glance-quiet">
        <Unavailable />
      </p>
    );
  }
  const split = postingSplit(day.today);
  if (split.received === 0) return <p className="glance-quiet">{t("overview.posting.none")}</p>;
  return (
    <>
      <div className="posting-ring">
        <Ring split={split} label={t("overview.posting.summary", { received: split.received })} />
        <Legend split={split} />
      </div>
      <p className="posting-ring__note">{t(metricDefinition("erpPosting").unknown.meaningKey)}</p>
    </>
  );
}

export function PostingPanel({
  state,
}: Readonly<{ state: PanelState<SalesSummary> }>): React.JSX.Element | null {
  const t = useT();
  const titleId = useId();
  if (state.status === "hidden") return null;
  return (
    <section className="section-panel glance-posting" aria-labelledby={titleId}>
      <div className="section-panel__head">
        <div className="panel-title">
          <SectionIndex position={2} />
          <h2 id={titleId} className="section-panel__title">
            {t("overview.posting.title")}
          </h2>
        </div>
      </div>
      <div className="section-panel__body">
        <p className="section-panel__question">{t("overview.posting.question")}</p>
        {state.status === "loading" ? <PanelSkeleton lines={3} /> : null}
        {state.status === "error" ? (
          // The receipt row reads the same summary and announces its failure.
          <PanelError requestId={state.requestId} retry={state.retry} announce={false} />
        ) : null}
        {state.status === "ready" ? <Body summary={state.data} /> : null}
      </div>
    </section>
  );
}
