import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLang } from "../../i18n/LangContext";
import type { StringKey } from "../../i18n/strings";
import { ARCH, CABLE_IDS, STATION_IDS } from "../../model/architecture";
import type { Alarm, Board, CableId, StationId } from "../../model/types";
import type { BoardEvent } from "../../state/diff";
import { useVisible } from "../../state/useVisible";
import { AlarmPin } from "./AlarmPin";
import { Cable } from "./Cable";
import { Hosts } from "./Hosts";
import { Legend } from "./Legend";
import { SourceBar } from "./SourceBar";
import { Station } from "./Station";
import { SvgText } from "./SvgText";
import { cablePins, layoutRoom, stationPins, VIEW } from "./geometry";
import { useMotion, useReducedMotion, type FxAccess } from "./useMotion";
import { useNarrow } from "./useNarrow";
import type { Selection } from "./selection";

export type { Selection } from "./selection";

export type ControlRoomProps = {
  board: Board;
  /** Newest first (from `useBoard`). Live changes between polls animate once each. */
  events: BoardEvent[];
  /** The 24 h replay, oldest first (from `useBoard`). At most the newest 12 animate. */
  replayQueue: BoardEvent[];
  /** Pause motion (header button). */
  paused: boolean;
  replaying: boolean;
  /** Called once, after the last replayed event was played, skipped or cancelled. */
  onReplayDone: () => void;
  /** `byKey` is true when the keyboard opened it. */
  onSelect: (sel: Selection, byKey?: boolean) => void;
  selection: Selection;
  /** Overrides the system `prefers-reduced-motion` (tests and hosts). */
  reducedMotion?: boolean;
  /**
   * The map as a table (`StatusTable`). When given, a narrow tile (under about
   * 900 px wide) shows it instead of the diagram, and a "Table view" toggle
   * reaches it at any width. The diagram stays mounted (hidden), so focus keys
   * and motion refs survive; nothing animates while the table is shown.
   */
  table?: ReactNode;
  /** Draw each station's eight readings (default true). Story mode turns them off. */
  readings?: boolean;
  /**
   * The guided tour's frame: stations and cables outside it dim to 30%
   * (`null` in a list lights all of that kind). When set it replaces the
   * selection's own dimming; leave it out or `null` outside the tour.
   */
  spot?: { stations: readonly StationId[] | null; cables: readonly CableId[] | null } | null;
};

const ZONE: Record<string, StringKey> = {
  front: "zoneFront",
  core: "zoneCore",
  integration: "zoneIntegration",
  books: "zoneBooks",
};

/** What the selection points at, resolved against the board. A vanished id is no selection. */
function resolve(board: Board, selection: Selection) {
  const none = { active: false, station: null as StationId | null, cable: null as CableId | null, alarm: null as Alarm | null, unplaced: false };
  if (!selection) return none;
  if (selection.type === "station") {
    return STATION_IDS.includes(selection.id as StationId) ? { ...none, active: true, station: selection.id as StationId } : none;
  }
  if (selection.type === "host") {
    const host = board.hosts.find((h) => h.id === selection.id);
    return host ? { ...none, active: true, station: host.station } : none;
  }
  const alarm = board.alarms.find((a) => a.id === selection.id);
  if (!alarm) return none;
  const cable = CABLE_IDS.includes(alarm.at as CableId) ? (alarm.at as CableId) : null;
  return { active: true, station: alarm.station, cable, alarm, unplaced: alarm.at === "unlocated" };
}

/**
 * The signature region: sources on a signal bus, five stations, four labelled
 * cables, the servers, and an alarm pinned where each fault is. Geometry comes
 * from the architecture map's tiers. Motion runs only on a replayed or real
 * change, and never while paused, under reduced motion or off screen.
 */
export function ControlRoom(props: ControlRoomProps) {
  const { board, events, replayQueue, paused, replaying, onReplayDone, onSelect, selection, table, readings = true, spot = null } = props;
  const { t } = useLang();
  const sectionRef = useRef<HTMLElement | null>(null);
  const narrow = useNarrow(sectionRef);
  // The viewer's own choice wins over the width; null follows the width.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const tableOn = table !== undefined && (chosen ?? narrow);
  const layout = useMemo(layoutRoom, []);
  const reduced = useReducedMotion(props.reducedMotion);
  const visible = useVisible();
  const still = paused || reduced || !visible || tableOn;

  const fxRef = useRef<SVGGElement | null>(null);
  const wraps = useRef(new Map<string, Element>());
  const keep = useCallback(
    (kind: string, id: string) => (el: SVGGElement | null) => {
      if (el) wraps.current.set(`${kind}:${id}`, el);
      else wraps.current.delete(`${kind}:${id}`);
    },
    [],
  );
  // Read when a gesture starts, so it always sees the mounted layer and wrappers.
  const access = useMemo<FxAccess>(
    () => ({
      get fx() {
        return fxRef.current;
      },
      wrap: (id) => wraps.current.get(`station:${id}`) ?? null,
      cableWrap: (id) => wraps.current.get(`cable:${id}`) ?? null,
      gate: (id) => wraps.current.get(`gate:${id}`) ?? null,
    }),
    [],
  );
  useMotion({ board, events, replayQueue, replaying, still, reducedMotion: reduced, layout, fx: access, onReplayDone });
  // The replay only plays on the diagram: with the table showing it ends here, so "Replaying" never sticks.
  useEffect(() => {
    if (tableOn && replaying) onReplayDone();
  }, [tableOn, replaying, onReplayDone]);

  const sel = resolve(board, selection);
  const now = useMemo(() => Date.now(), [board.sources]);
  const notRead = !board.alarmRead.sentry;
  const unknownIds = new Set(board.unknowns.map((u) => u.station));
  const slowStations = new Set(board.alarms.filter((a) => a.kind === "latency" && a.station).map((a) => a.station));
  const placed = board.alarms.filter((a) => a.at !== "unlocated");
  const pinProps = (a: Alarm) => ({
    alarm: a,
    selected: selection?.type === "alarm" && selection.id === a.id,
    onSelect,
  });

  return (
    <section className="room" data-still={still ? "true" : "false"} ref={sectionRef}>
      <div className="room-head">
        <div>
          <h2>{t("mapTitle")}</h2>
          <p className="sub">{t("mapSub")}</p>
        </div>
        {table !== undefined && (
          <button type="button" className="table-toggle" aria-pressed={tableOn} onClick={() => setChosen(!tableOn)}>
            {t("tableView")}
          </button>
        )}
      </div>
      {tableOn && table}
      <div className="diagram" hidden={tableOn}>
        <svg className="grid" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} role="group" aria-label={t("mapAria")}>
          <defs>
            <filter id="rt-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <SourceBar sources={board.sources} layout={layout} now={now} />
          {layout.zones.map((z) => (
            <SvgText key={z.tier} x={z.x} y={212} className="zone">
              {t(ZONE[z.tier])}
            </SvgText>
          ))}

          {layout.risers.map((r) => {
            const view = board.stations.find((s) => s.id === r.station);
            // Dot speed follows 7-day activity (180 / activity seconds); no activity, no dots.
            const activity = view?.activity7d ?? 0;
            return (
              <g key={r.station}>
                <path d={r.d} className="riser" data-riser={r.station} />
                {activity > 0 && (
                  <path
                    d={r.d}
                    className="current riser"
                    data-riser-current={r.station}
                    filter="url(#rt-glow)"
                    style={{ animationDuration: `${(180 / activity).toFixed(2)}s` }}
                  />
                )}
              </g>
            );
          })}

          {layout.rules.map((r) => (
            <path key={r.from} d={r.d} className="cable rule" data-rule={r.from} />
          ))}
          <SvgText x={layout.ruleLabel.x} y={layout.ruleLabel.y} className="cstate rule-note" anchor="middle">
            {t("ruleNote")}
          </SvgText>

          {board.cables.map((cable) => {
            const geom = layout.cables.find((g) => g.id === cable.id);
            if (!geom) return null;
            const related =
              sel.cable === cable.id || (sel.station !== null && (cable.from === sel.station || cable.to === sel.station));
            return (
              <Cable
                key={cable.id}
                cable={cable}
                geom={geom}
                notRead={notRead}
                dim={spot ? spot.cables !== null && !spot.cables.includes(cable.id) : sel.active && !sel.unplaced && !related}
                slow={slowStations.has(cable.from) || slowStations.has(cable.to)}
                wrapRef={keep("cable", cable.id)}
                gateRef={keep("gate", cable.id)}
              />
            );
          })}

          <Hosts
            hosts={board.hosts}
            layout={layout}
            alarms={board.alarms}
            selection={selection}
            dimmed={false}
            onSelect={onSelect}
          />

          {board.stations.map((view) => {
            const box = layout.stations[view.id];
            const cableTo = sel.cable ? ARCH.cables[sel.cable].to : null;
            const related = !sel.active || sel.unplaced || view.id === sel.station || view.id === cableTo;
            return (
              <Station
                key={view.id}
                view={view}
                box={box}
                unknown={unknownIds.has(view.id)}
                selected={selection?.type === "station" && selection.id === view.id && sel.active}
                dim={spot ? spot.stations !== null && !spot.stations.includes(view.id) : !related}
                readings={readings}
                wrapRef={keep("station", view.id)}
                onSelect={onSelect}
              />
            );
          })}

          {/* Pins last, so they sit on top. An unlocated alarm has no place on the map and draws none. */}
          {layout.cables.map((geom) => {
            const mine = placed.filter((a) => a.at === geom.id);
            const spots = cablePins(geom, mine.length);
            return mine.map((a, i) => <AlarmPin key={a.id} {...pinProps(a)} x={spots[i].x} y={spots[i].y} />);
          })}
          {STATION_IDS.map((id) => {
            const mine = placed.filter((a) => a.at === id);
            const spots = stationPins(layout.stations[id], mine.length);
            return mine.map((a, i) => <AlarmPin key={a.id} {...pinProps(a)} x={spots[i].x} y={spots[i].y} />);
          })}

          <g ref={fxRef} data-fx-layer />
        </svg>
      </div>
      {!tableOn && <Legend />}
    </section>
  );
}
