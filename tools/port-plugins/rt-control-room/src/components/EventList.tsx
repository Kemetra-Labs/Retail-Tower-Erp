import { useMemo } from "react";
import { useLang } from "../i18n/LangContext";
import { fmtTime, type StringKey } from "../i18n/strings";
import { ARCH } from "../model/architecture";
import type { BoardEvent, EventKind } from "../state/diff";

const KIND: Record<EventKind, StringKey> = {
  alarm: "evAlarm",
  monitor: "evMonitor",
  merge: "evMerge",
  ci: "evCi",
  jira: "evJira",
  deploy: "evDeploy",
};

/**
 * Changes, newest first. An event Port could not place (`station: null`) is
 * listed as received, with an "Unlocated" label and its original text (it
 * carries the monitor's own title); it never moves anything on the map. One
 * line says when the list is a partial replay.
 */
export function EventList({ events }: { events: BoardEvent[] }) {
  const { lang, t } = useLang();
  const sorted = useMemo(() => events.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [events]);
  const partial = sorted.some((e) => e.replay);
  if (sorted.length === 0) return <p className="muted">{t("eventsEmpty")}</p>;
  return (
    <>
      {partial && <p className="note">{t("replayNote")}</p>}
      <ol className="trail">
        {sorted.map((e) => {
          const ms = Date.parse(e.at);
          return (
            <li key={e.id} data-kind={e.kind} data-station={e.station ?? "none"}>
              <div className="meta">
                <span className="when measured">{Number.isNaN(ms) ? t("noData") : fmtTime(new Date(ms), lang)}</span>
                <span>{t(KIND[e.kind])}</span>
                {e.station === null ? (
                  <span className="chip stale">{t("unlocated")}</span>
                ) : (
                  <span>{ARCH.stations[e.station].name}</span>
                )}
              </div>
              <div className="what">{e.text[lang]}</div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
