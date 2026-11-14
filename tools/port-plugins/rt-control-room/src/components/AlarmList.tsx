import { useLang } from "../i18n/LangContext";
import { fmtStamp } from "../i18n/strings";
import { ARCH } from "../model/architecture";
import type { Alarm, Board } from "../model/types";
import { KindIcon } from "./KindIcon";
import { KIND_CODE, KIND_TITLE } from "./room/icons";
import type { Selection } from "./room/selection";
import { whereOf, type Where } from "./where";

type Props = {
  board: Board;
  selection: Selection;
  onSelect: (sel: Selection, byKey?: boolean) => void;
};

/** "Inside X", "On the cable A to B (what it carries)", "On server lab-01, inside X" or the unplaced line. */
export function WhereText({ where }: { where: Where }) {
  const { t } = useLang();
  switch (where.kind) {
    case "cable":
      return <>{t("whereCable", { from: where.from, to: where.to, carries: where.carries })}</>;
    case "station":
      return <>{t("whereInside", { name: where.name })}</>;
    case "host":
      return <>{t("whereHost", { host: where.host, name: where.name })}</>;
    default:
      return <>{t("whereUnplaced")}</>;
  }
}

/** The time an alarm was first seen in Port, or "no data" (Datadog gives none). Never "Invalid Date". */
export function Since({ iso }: { iso: string | null }) {
  const { lang, t } = useLang();
  const ms = iso === null ? NaN : Date.parse(iso);
  return <bdi dir="ltr">{Number.isNaN(ms) ? t("noData") : fmtStamp(new Date(ms), lang)}</bdi>;
}

function AlarmRow({ alarm, selected, onSelect }: { alarm: Alarm; selected: boolean; onSelect: Props["onSelect"] }) {
  const { lang, t } = useLang();
  return (
    <li>
      <button
        type="button"
        className={`alarm${alarm.example ? " example" : ""}`}
        data-focus={`alarm:${alarm.id}`}
        aria-pressed={selected}
        // Opened from the list, the detail takes focus (as in the approved mockup).
        onClick={() => onSelect({ type: "alarm", id: alarm.id }, true)}
      >
        <span className="ib">
          <KindIcon kind={alarm.kind} />
        </span>
        <span>
          <span className="tt">{t(KIND_TITLE[alarm.kind])}</span>
          <span className="loc">
            <WhereText where={whereOf(alarm, lang)} />
          </span>
          <span className="meta">
            <span className="measured">{KIND_CODE[alarm.kind]}</span>
            <span>{alarm.source}</span>
            <span>
              {t("dSince")} <Since iso={alarm.since} />
            </span>
            {alarm.example && <span className="chip stale">{t("exampleTag")}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Alarms that sit on the map, then (only when there are any) the group Port
 * cannot place, then the places with no health check. Those last are not faults
 * and read amber: unknown is never healthy.
 */
export function AlarmList({ board, selection, onSelect }: Props) {
  const { t } = useLang();
  const placed = board.alarms.filter((a) => a.at !== "unlocated");
  const unplaced = board.alarms.filter((a) => a.at === "unlocated");
  const picked = (a: Alarm) => selection?.type === "alarm" && selection.id === a.id;
  return (
    <ul className="alarms">
      {placed.map((a) => (
        <AlarmRow key={a.id} alarm={a} selected={picked(a)} onSelect={onSelect} />
      ))}
      {unplaced.length > 0 && (
        <li className="grp" data-group="unplaced">
          <h3>{t("notPlaced")}</h3>
        </li>
      )}
      {unplaced.map((a) => (
        <AlarmRow key={a.id} alarm={a} selected={picked(a)} onSelect={onSelect} />
      ))}
      {board.unknowns.map((u) => {
        const name = ARCH.stations[u.station].name;
        return (
          <li key={u.station}>
            <button
              type="button"
              className="alarm unknown"
              data-focus={`watch:${u.station}`}
              onClick={() => onSelect({ type: "station", id: u.station }, true)}
            >
              <span className="ib">
                <KindIcon kind="unknown" />
              </span>
              <span>
                <span className="tt">{t("watchNoCheck", { name })}</span>
                <span className="loc">{t("watchNote")}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

