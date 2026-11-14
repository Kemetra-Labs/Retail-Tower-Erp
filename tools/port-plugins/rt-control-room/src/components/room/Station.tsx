import type { Ref } from "react";
import { useLang } from "../../i18n/LangContext";
import type { StringKey } from "../../i18n/strings";
import type { StationView } from "../../model/types";
import { Lamps } from "./Lamps";
import { SvgText } from "./SvgText";
import { ICONS } from "./icons";
import type { Selection } from "./selection";
import type { StationBox } from "./geometry";

type Props = {
  view: StationView;
  box: StationBox;
  /** No health check at all behind this station (`board.unknowns`): health is unknown, drawn amber with a "?". */
  unknown: boolean;
  selected: boolean;
  dim: boolean;
  /** Story mode keeps name, role and state only. */
  readings: boolean;
  wrapRef: Ref<SVGGElement>;
  onSelect: (sel: Selection, byKey?: boolean) => void;
};

type Cell = { label: StringKey; text: string; tone: "" | "bad" | "unk" | "nd" };

/** A missing figure reads "no data" (never 0), an unread one "not read", an unwatched one "none". */
function cells(view: StationView, unknown: boolean, t: (k: StringKey, v?: Record<string, string | number>) => string): [Cell[], Cell[]] {
  const r = view.readings;
  const num = (v: number | null, label: StringKey, bad = false): Cell =>
    v === null ? { label, text: t("noData"), tone: "nd" } : { label, text: String(v), tone: bad && v > 0 ? "bad" : "" };
  let checks: Cell;
  if (r.checks === "na") checks = { label: "rdChecks", text: t("na"), tone: "" };
  else if (r.checks === null) checks = { label: "rdChecks", text: unknown ? t("none") : t("noData"), tone: unknown ? "unk" : "nd" };
  else if (r.checks.total === 0) checks = { label: "rdChecks", text: t("none"), tone: "unk" };
  else if (r.checks.ok === r.checks.total) checks = { label: "rdChecks", text: t("okCount", { n: r.checks.ok }), tone: "" };
  else checks = { label: "rdChecks", text: t("okOfCount", { ok: r.checks.ok, total: r.checks.total }), tone: "bad" };
  const alarms: Cell =
    r.alarms === "not-read"
      ? { label: "rdAlarms", text: t("notRead"), tone: "unk" }
      : { label: "rdAlarms", text: String(r.alarms), tone: r.alarms > 0 ? "bad" : "" };
  const ci: Cell = r.ci7d === null ? { label: "rdCi", text: t("noData"), tone: "nd" } : { label: "rdCi", text: `${r.ci7d}%`, tone: "" };
  return [
    [alarms, checks, ci, num(r.tasks, "rdTasks")],
    [num(r.prs, "rdPrs"), num(r.merged7d, "rdMerged"), num(r.deploys, "rdDeploys"), num(r.ciFails7d, "rdCiFails", true)],
  ];
}

function Spark({ series, box, label }: { series: number[]; box: StationBox; label: string }) {
  const x0 = box.x + 14;
  const w = box.w - 28;
  const y0 = box.y + box.h - 8;
  const max = Math.max(...series, 1);
  return (
    <g role="img" aria-label={label} data-spark>
      <line x1={x0} y1={y0} x2={x0 + w} y2={y0} className="rule" />
      {series.map((v, k) =>
        v > 0 ? (
          <rect
            key={k}
            x={x0 + (k * w) / series.length + 1}
            y={y0 - (12 * v) / max}
            width={w / series.length - 3}
            height={(12 * v) / max}
            rx={1}
            className="bar"
            opacity={k === series.length - 1 ? 0.95 : 0.55}
          />
        ) : null,
      )}
    </g>
  );
}

/** One station: name, role, four link lamps, eight readings and a merged-per-day mini chart. A focusable button. */
export function Station({ view, box, unknown, selected, dim, readings, wrapRef, onSelect }: Props) {
  const { lang, t } = useLang();
  const alarms = view.readings.alarms;
  const err = typeof alarms === "number" && alarms > 0;
  const aria = `${view.name}. ${view.role[lang]}. ${alarms === "not-read" ? t("stationAlarmsNotRead") : t("stationAlarmsN", { n: alarms })}`;
  const sel: Selection = { type: "station", id: view.id };
  const [row1, row2] = cells(view, unknown, t);
  const colW = (box.w - 28) / 4;
  const cellsAt = (list: Cell[], y: number) =>
    list.map((c, i) => (
      <g key={c.label}>
        <SvgText x={box.x + 14 + i * colW} y={y} className="sk">{t(c.label)}</SvgText>
        <SvgText x={box.x + 14 + i * colW} y={y + 18} className={`sv ${c.tone}`}>{c.text}</SvgText>
      </g>
    ));
  return (
    <g data-fx-station={view.id} ref={wrapRef}>
      <g
        className={`station${err ? " err" : ""}${box.ledger ? " ledger" : ""}${dim ? " dim" : ""}`}
        data-focus={`station:${view.id}`}
        tabIndex={0}
        role="button"
        aria-label={aria}
        aria-pressed={selected}
        onClick={() => onSelect(sel, false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(sel, true);
          }
        }}
      >
        <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={16} className="face" />
        <SvgText x={box.x + 14} y={box.y + 26} className="sname">{view.name}</SvgText>
        <SvgText x={box.x + 14} y={box.y + 44} className="srole">{view.role[lang]}</SvgText>
        {box.ledger ? (
          <SvgText x={box.x + 14} y={box.y + 64} className="sk">{t("external")}</SvgText>
        ) : (
          <>
            <Lamps station={view} box={box} unknown={unknown} />
            {readings && (
              <>
                {cellsAt(row1, box.y + 102)}
                <line x1={box.x + 14} y1={box.y + 134} x2={box.x + box.w - 14} y2={box.y + 134} className="rule" />
                {cellsAt(row2, box.y + 156)}
                {view.merged13d.length > 0 && (
                  <>
                    <SvgText x={box.x + 14} y={box.y + box.h - 22} className="sk">{t("mergedSpark")}</SvgText>
                    <Spark series={view.merged13d} box={box} label={t("sparkAria")} />
                  </>
                )}
              </>
            )}
            {unknown && (
              <path
                d={ICONS.unknown}
                className="ic unk"
                data-unknown-icon
                transform={`translate(${box.x + box.w - 30} ${box.y + 12})`}
              />
            )}
          </>
        )}
      </g>
    </g>
  );
}
