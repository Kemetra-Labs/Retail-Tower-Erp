import { useLang } from "../../i18n/LangContext";
import type { StringKey } from "../../i18n/strings";
import type { Lamp, LinkState, SourceId, StationView } from "../../model/types";
import type { Rect } from "./geometry";

export const LETTER: Record<SourceId, string> = { sentry: "ERR", datadog: "HLT", github: "GIT", jira: "JIR" };
export const SOURCE_NAME: Record<SourceId, StringKey> = {
  sentry: "srcSentry",
  datadog: "srcDatadog",
  github: "srcGithub",
  jira: "srcJira",
};
export const STATE_TEXT: Record<LinkState, StringKey> = {
  sending: "lampSending",
  live: "lampLive",
  linked: "lampLinked",
  none: "lampNone",
  na: "lampNa",
  alert: "lampAlert",
};
export const ORDER: SourceId[] = ["sentry", "datadog", "github", "jira"];

/**
 * The four link lamps of a station. A health lamp with no check behind it is
 * unknown, so it is amber and dashed (never green, never muted-as-fine).
 */
export function Lamps({ station, box, unknown }: { station: StationView; box: Rect; unknown: boolean }) {
  const { t } = useLang();
  const pw = (box.w - 28) / 4;
  return (
    <>
      {ORDER.map((src, i) => {
        const lamp: Lamp = station.lamps[src];
        const x = box.x + 14 + i * pw;
        const y = box.y + 56;
        const amber = src === "datadog" && unknown && lamp.state === "none";
        const checks = src === "datadog" && lamp.checks && lamp.checks.total > 0 ? ` ${lamp.checks.ok}/${lamp.checks.total}` : "";
        const state = amber ? t("kindUnknown") : t(STATE_TEXT[lamp.state]);
        return (
          <g key={src} className={`lamp ${lamp.state}${amber ? " unk" : ""}`} data-lamp={src}>
            <rect x={x} y={y} width={pw - 6} height={20} rx={8} />
            <text x={x + (pw - 6) / 2} y={y + 14} textAnchor="middle">
              {LETTER[src] + checks}
            </text>
            <title>{`${t(SOURCE_NAME[src])}: ${state}`}</title>
          </g>
        );
      })}
    </>
  );
}

