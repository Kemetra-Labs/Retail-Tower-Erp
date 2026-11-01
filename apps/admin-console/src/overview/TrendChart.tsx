/**
 * RT-993 the trend chart (DESIGN.md §12.4, UX-13): received sales of the
 * period (solid, `--color-viz-cat-1`) against the same days of the period
 * before (dashed, muted), on one zero-based axis. A date the read lacks breaks
 * the line (UX-13.24). The SVG is a picture (`role="img"`) summarised by its
 * label; the panel's table holds every figure.
 *
 * Hover adds a crosshair and a tooltip with both figures and their exact
 * difference. It is a convenience only (UX-13.29): the table shows the same.
 * Nothing animates (UX-13.35).
 */
import { DIRECTION, type Locale, Money, intlTag, useLocale, useT } from "@/i18n";
import { BusinessDate } from "@/sales/SaleParts";
import { useState } from "react";
import { type ComparisonPoint, type LineRun, lineGeometry } from "./trendLogic";

function dayFormat(locale: Locale): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(intlTag(locale), {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
}

function tickFormat(locale: Locale): Intl.NumberFormat {
  return new Intl.NumberFormat(intlTag(locale), { notation: "compact", maximumFractionDigits: 1 });
}

function Runs({ runs, kind }: Readonly<{ runs: LineRun[]; kind: "current" | "previous" }>) {
  return (
    <>
      {runs.map((run) =>
        run.length === 1 ? (
          <circle
            key={run[0].index}
            className={`trend-chart__line trend-chart__line--${kind} trend-chart__line--point`}
            cx={run[0].x}
            cy={run[0].y}
            r={1.5}
          />
        ) : (
          <polyline
            key={run[0].index}
            className={`trend-chart__line trend-chart__line--${kind}`}
            points={run.map((p) => `${p.x},${p.y}`).join(" ")}
          />
        ),
      )}
    </>
  );
}

/** First, middle and last day labels: enough to read time without crowding. */
function labelled(count: number): Set<number> {
  return new Set([0, Math.floor((count - 1) / 2), count - 1]);
}

function Tip({
  point,
  currency,
  side,
}: Readonly<{ point: ComparisonPoint; currency: string; side: "start" | "end" }>) {
  const t = useT();
  const money = (value: string | null) =>
    value === null ? t("salesDaily.chart.unknown") : <Money value={value} currency={currency} />;
  return (
    <div
      className="trend-chart__tip"
      style={side === "start" ? { insetInlineStart: 0 } : { insetInlineEnd: 0 }}
    >
      <span>
        <BusinessDate value={point.date} /> · {money(point.current)}
      </span>
      <span className="trend-chart__tip-muted">
        <BusinessDate value={point.previousDate} /> · {money(point.previous)}
      </span>
      {point.difference === null ? null : (
        <span>
          {t.rich("overview.trend.difference", {
            value: <Money value={point.difference} currency={currency} signed />,
          })}
        </span>
      )}
    </div>
  );
}

export function TrendChart({
  points,
  currency,
  label,
}: Readonly<{ points: ComparisonPoint[]; currency: string; label: string }>): React.JSX.Element {
  const locale = useLocale();
  const direction = DIRECTION[locale];
  const rtl = direction === "rtl";
  const g = lineGeometry(points, direction);
  const [hover, setHover] = useState<number | null>(null);
  const days = labelled(points.length);
  const far = rtl ? 8 : g.width - 8;
  const last = points.length - 1;

  /** The nearest day to the pointer, in viewBox units. */
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const x = ((e.clientX - box.left) / box.width) * g.width;
    let best = 0;
    for (let i = 1; i < g.xs.length; i++) {
      if (Math.abs(g.xs[i] - x) < Math.abs(g.xs[best] - x)) best = i;
    }
    setHover(best);
  };

  const today = points[last];
  const todayPoint =
    today?.current !== null ? g.current.flat().find((p) => p.index === last) : undefined;
  return (
    <div className="trend-chart">
      <svg
        className="trend-chart__svg"
        role="img"
        aria-label={label}
        viewBox={`0 0 ${g.width} ${g.height}`}
        focusable="false"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {g.ticks.map((tick) => (
          <g key={tick.value}>
            <line
              className={`trend-chart__grid${tick.value === 0 ? " trend-chart__grid--base" : ""}`}
              x1={g.axisX}
              x2={far}
              y1={tick.y}
              y2={tick.y}
            />
            <text
              className="trend-chart__tick"
              x={rtl ? g.axisX + 8 : g.axisX - 8}
              y={tick.y + 4}
              textAnchor={rtl ? "start" : "end"}
            >
              {tickFormat(locale).format(tick.value)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          days.has(i) ? (
            <text
              key={p.date}
              className="trend-chart__day"
              x={g.xs[i]}
              y={g.baselineY + 18}
              textAnchor="middle"
            >
              {dayFormat(locale).format(new Date(`${p.date}T12:00:00Z`))}
            </text>
          ) : null,
        )}
        <Runs runs={g.previous} kind="previous" />
        <Runs runs={g.current} kind="current" />
        {todayPoint && today.state === "so-far" ? (
          <circle
            className="trend-chart__dot trend-chart__dot--so-far"
            cx={todayPoint.x}
            cy={todayPoint.y}
            r={4}
          />
        ) : null}
        {hover === null ? null : (
          <line
            className="trend-chart__cross"
            x1={g.xs[hover]}
            x2={g.xs[hover]}
            y1={g.ticks.at(-1)?.y ?? 0}
            y2={g.baselineY}
          />
        )}
      </svg>
      {hover === null ? null : (
        <Tip
          point={points[hover]}
          currency={currency}
          side={g.xs[hover] > g.width / 2 !== rtl ? "start" : "end"}
        />
      )}
    </div>
  );
}
