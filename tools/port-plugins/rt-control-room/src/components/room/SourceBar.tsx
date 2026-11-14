import { useLang } from "../../i18n/LangContext";
import { agoText, type StringKey } from "../../i18n/strings";
import type { SourceId, SourceView } from "../../model/types";
import { SvgText } from "./SvgText";
import { ICONS } from "./icons";
import { BUS_Y, VIEW, type RoomLayout } from "./geometry";

const NAME: Record<SourceId, [StringKey, string]> = {
  sentry: ["srcSentry", "Sentry"],
  datadog: ["srcDatadog", "Datadog"],
  github: ["srcGithub", "GitHub"],
  jira: ["srcJira", "Jira"],
};

const since = (iso: string | null, now: number): number | null => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isNaN(ms) ? null : now - ms;
};

type Props = { sources: Record<SourceId, SourceView>; layout: RoomLayout; now: number };

/**
 * The control-room bar: the four sources Port reads, each with its sync state
 * and last change, and the signal bus every station rises to. A stale or
 * unknown source is amber with a "?", never green.
 */
export function SourceBar({ sources, layout, now }: Props) {
  const { lang, t } = useLang();
  return (
    <>
      <g className="cc">
        <rect x={20} y={18} width={VIEW.w - 40} height={116} rx={16} className="frame" />
        <SvgText x={34} y={40} className="zone">
          {t("busTitle")}
        </SvgText>
        {layout.sources.map((box) => {
          const view = sources[box.id];
          const [nameKey, tool] = NAME[box.id];
          const sync = since(view.lastSync, now);
          const change = since(view.lastChange, now);
          const fresh = view.state === "fresh";
          let state: string;
          if (view.state === "unknown") state = t("srcUnknown");
          else if (fresh) state = sync === null ? t("srcUpToDate") : t("srcSynced", { ago: agoText(sync, lang) });
          else state = sync === null ? t("srcStale") : t("srcStaleSynced", { ago: agoText(sync, lang) });
          const changeText = change === null ? t("srcNoChange") : t("srcChange", { ago: agoText(change, lang) });
          return (
            <g key={box.id} className={`tap ${view.state}`} data-source={box.id} data-state={view.state}>
              <rect x={box.x} y={48} width={box.w} height={74} rx={12} />
              <path d={ICONS[fresh ? "ok" : "unknown"]} className="ic" transform={`translate(${box.x + 12} 60) scale(${14 / 18})`} />
              <SvgText x={box.x + 34} y={72} className="t1">
                {`${t(nameKey)} (${tool})`}
              </SvgText>
              <SvgText x={box.x + 34} y={92} className="t3">
                {state}
              </SvgText>
              <SvgText x={box.x + 34} y={110} className="t2">
                {changeText}
              </SvgText>
            </g>
          );
        })}
      </g>
      <line x1={40} y1={BUS_Y} x2={VIEW.w - 40} y2={BUS_Y} className="bus" />
      <SvgText x={VIEW.w - 40} y={BUS_Y - 6} className="zone" anchor="end">
        {t("busLabel")}
      </SvgText>
    </>
  );
}
