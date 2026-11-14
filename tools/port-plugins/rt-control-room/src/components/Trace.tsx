import { useState } from "react";
import { useLang } from "../i18n/LangContext";
import type { StringKey } from "../i18n/strings";
import type { TraceView } from "../model/types";

// The approved mockup's geometry: 13 completed days, drawn in a 240 x 58 box plus a 12 high strip for spike marks.
const W = 240;
const H = 58;

const TITLE: Record<TraceView["key"], [title: StringKey, sub: StringKey]> = {
  merged: ["tlMerged", "tlMergedSub"],
  runs: ["tlRuns", "tlRunsSub"],
  fails: ["tlFails", "tlFailsSub"],
  done: ["tlDone", "tlDoneSub"],
};

/** One telemetry column: title, yesterday's value, a hand-drawn SVG trace and its caption. Today is never drawn. */
export function Trace({ trace, paused }: { trace: TraceView; paused: boolean }) {
  const { t } = useLang();
  // The line draws itself once; after that Pause and Resume never replay it.
  const [drawn, setDrawn] = useState(false);
  const { series, cap, band, spikes, yesterday, average } = trace;
  const fails = trace.key === "fails";
  const n = series.length;
  const [titleKey, subKey] = TITLE[trace.key];

  const x = (i: number) => (n > 1 ? (i * W) / (n - 1) : 0);
  const y = (v: number) => H - (Math.min(v, cap) / cap) * (H - 6) - 2;
  const points = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const bandTop = y(band[1]);
  const bandHeight = Math.max(2, y(band[0]) - bandTop);
  const peak = spikes.length > 0 ? Math.max(...spikes.map((i) => series[i])) : null;
  const last = n - 1;

  return (
    <div className="trace-cell" data-paused={paused ? "true" : "false"}>
      <div className="trace-h">
        <span className="k">{t(titleKey)}</span>
        <span className="trace-v" dir="ltr">
          {yesterday}
          <small>{t("yday")}</small>
        </span>
      </div>
      <svg
        className="trace"
        viewBox={`0 0 ${W} ${H + 12}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${t(titleKey)}: ${series.join(", ")}`}
      >
        <rect x={0} y={bandTop} width={W} height={bandHeight} className="band" />
        <line x1={0} y1={H} x2={W} y2={H} className="axis" />
        {n > 0 && (
          <>
            <polygon points={`0,${H} ${points} ${x(last).toFixed(1)},${H}`} className="area" />
            <polyline
              points={points}
              pathLength={1}
              className={`line${fails ? " badline" : ""}${drawn ? " drawn" : ""}`}
              onAnimationEnd={() => setDrawn(true)}
            />
          </>
        )}
        {fails &&
          series.map((v, i) =>
            v > 2 ? <circle key={`f${i}`} cx={x(i)} cy={y(v)} r={3} className="badpt" /> : null,
          )}
        {spikes.map((i) => (
          <circle key={`s${i}`} cx={x(i)} cy={3} r={3} className="spike">
            <title>{`${series[i]}: ${t("spikeNote")}`}</title>
          </circle>
        ))}
        {n > 0 && <circle cx={x(last)} cy={y(series[last])} r={3.4} className="now" />}
      </svg>
      <div className="note">
        {t(subKey)}. {t("avg")} {average.toFixed(1)}
        {peak !== null && (
          <>
            {". "}
            <span className="spike-label">
              {t("spike")} {peak}
            </span>
            <span className="spike-note">{t("spikeNote")}</span>
          </>
        )}
      </div>
    </div>
  );
}
