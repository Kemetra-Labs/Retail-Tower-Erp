import { useLang } from "../i18n/LangContext";
import { ARCH, STATION_IDS } from "../model/architecture";
import type { Board, Lamp, SourceId, StationView } from "../model/types";
import { StaleChip, type Freshness } from "./PanelHead";
import { LETTER, ORDER, STATE_TEXT } from "./room/Lamps";
import type { Selection } from "./room/selection";

type Tone = "bad" | "unk" | "";
type T = ReturnType<typeof useLang>["t"];

/** The state of one station in words. Unknown (no health check, an external ledger, errors not read) is amber, never "fine". */
function stateOf(view: StationView, unknown: boolean, t: T): { tone: Tone; text: string } {
  const n = view.readings.alarms;
  if (typeof n === "number" && n > 0) return { tone: "bad", text: t("stFault") };
  if (view.id === "erp") return { tone: "unk", text: t("stLedger") };
  if (unknown) return { tone: "unk", text: t("stUnknown") };
  if (n === "not-read") return { tone: "unk", text: t("stNotRead") };
  return { tone: "", text: view.readings.checks === "na" ? t("stNoErrors") : t("stNoFaults") };
}

function checksOf(view: StationView, unknown: boolean, t: T): { tone: Tone; text: string } {
  if (view.id === "erp" || view.readings.checks === "na") return { tone: "", text: "-" };
  if (unknown) return { tone: "unk", text: t("none") };
  const c = view.readings.checks;
  if (c === null) return { tone: "unk", text: t("noData") };
  return c.total === 0 ? { tone: "unk", text: t("none") } : { tone: c.ok < c.total ? "bad" : "", text: `${c.ok}/${c.total}` };
}

function linkTone(src: SourceId, lamp: Lamp, unknown: boolean): Tone {
  if (lamp.state === "alert") return "bad";
  return src === "datadog" && unknown ? "unk" : "";
}

type Props = {
  board: Board;
  fresh?: Freshness;
  /** When given, each station name opens its detail (the diagram is hidden at this width). */
  onSelect?: (sel: Selection, byKey?: boolean) => void;
};

/**
 * The map as a table: every station with its state, alarms, health checks and
 * the four links. Same data as the diagram, for a narrow tile.
 */
export function StatusTable({ board, fresh, onSelect }: Props) {
  const { t } = useLang();
  const unknownIds = new Set(board.unknowns.map((u) => u.station));
  return (
    <div className="statustable" data-status-table>
      <div className="stale-row">
        <p className="legend-cap">{t("tableNote")}</p>
        <StaleChip fresh={fresh} />
      </div>
      <table className="ptable">
        <thead>
          <tr>
            <th scope="col">{t("thStation")}</th>
            <th scope="col">{t("thState")}</th>
            <th scope="col">{t("thAlarms")}</th>
            <th scope="col">{t("thChecks")}</th>
            <th scope="col">{t("thLinks")}</th>
          </tr>
        </thead>
        <tbody>
          {STATION_IDS.map((id) => {
            const view = board.stations.find((s) => s.id === id);
            if (!view) return null;
            const unknown = unknownIds.has(id);
            const state = stateOf(view, unknown, t);
            const checks = checksOf(view, unknown, t);
            const alarms = view.readings.alarms;
            const ledger = id === "erp";
            return (
              <tr key={id} data-station-row={id}>
                <th scope="row">
                  {onSelect ? (
                    <button type="button" className="linklike" data-focus={`row:${id}`} onClick={() => onSelect({ type: "station", id }, true)}>
                      {ARCH.stations[id].name}
                    </button>
                  ) : (
                    ARCH.stations[id].name
                  )}
                </th>
                <td className={state.tone}>{state.text}</td>
                <td className={`measured ${ledger ? "" : alarms === "not-read" ? "unk" : alarms > 0 ? "bad" : ""}`}>
                  {ledger ? "-" : alarms === "not-read" ? t("notRead") : alarms}
                </td>
                <td className={`measured ${checks.tone}`}>{checks.text}</td>
                <td>
                  {ledger ? (
                    "-"
                  ) : (
                    <ul className="links">
                      {ORDER.map((src) => (
                        <li key={src} className={linkTone(src, view.lamps[src], unknown)}>
                          <span className="measured">{LETTER[src]}</span> {t(STATE_TEXT[view.lamps[src].state])}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
