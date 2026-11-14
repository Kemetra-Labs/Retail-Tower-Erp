import { useEffect, useLayoutEffect, useRef } from "react";
import { useLang } from "../i18n/LangContext";
import { STATION_IDS } from "../model/architecture";
import type { Board, StationId } from "../model/types";
import { AlarmBody, HostBody, StationBody } from "./DetailBodies";
import { KIND_TITLE } from "./room/icons";
import type { Selection } from "./room/selection";

export type DetailProps = {
  board: Board;
  selection: Selection;
  /** Back and the buttons inside the detail go through the same selection as the map. */
  onSelect: (sel: Selection, byKey?: boolean) => void;
  /** True when the keyboard opened the current selection: the heading then takes focus. */
  focusOnOpen?: boolean;
  /**
   * Called as the detail leaves the page, with whether focus was inside it at that moment (still
   * known: the DOM is removed after this cleanup). The panel uses it to hand focus back when the
   * selection vanishes by itself (an alarm resolved by a poll), where focus would fall to `<body>`.
   */
  onUnmount?: (hadFocus: boolean) => void;
};

/** True when the selection still points at something on the board (an alarm can resolve while its detail is open). */
export function isResolvable(board: Board, selection: Selection): boolean {
  if (!selection) return false;
  if (selection.type === "alarm") return board.alarms.some((a) => a.id === selection.id);
  if (selection.type === "host") return board.hosts.some((h) => h.id === selection.id);
  return STATION_IDS.includes(selection.id as StationId);
}

/**
 * The detail of an alarm, a station or a server. The root carries
 * `data-detail` (focus return treats it as the open detail); its heading takes
 * focus when the keyboard opened it, and Back is the selection's own clear.
 * It renders nothing for a selection that no longer exists.
 */
export function Detail({ board, selection, onSelect, focusOnOpen = false, onUnmount }: DetailProps) {
  const { t } = useLang();
  const heading = useRef<HTMLHeadingElement>(null);
  const wants = useRef(focusOnOpen);
  wants.current = focusOnOpen;
  const root = useRef<HTMLDivElement>(null);
  const leave = useRef(onUnmount);
  leave.current = onUnmount;
  useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      leave.current?.(root.current !== null && active !== null && root.current.contains(active));
    },
    [],
  );
  const key = selection ? `${selection.type}:${selection.id}` : "";
  // Only when what is open changes, never on a poll re-render or a language switch.
  useEffect(() => {
    if (key && wants.current) heading.current?.focus();
  }, [key]);

  if (!selection || !isResolvable(board, selection)) return null;
  const alarm = selection.type === "alarm" ? board.alarms.find((a) => a.id === selection.id) : undefined;
  const station = selection.type === "station" ? board.stations.find((s) => s.id === selection.id) : undefined;
  const host = selection.type === "host" ? board.hosts.find((h) => h.id === selection.id) : undefined;
  const title = alarm ? t(KIND_TITLE[alarm.kind]) : (station?.name ?? host?.id ?? "");
  return (
    <div className="detail" data-detail ref={root}>
      <button type="button" className="back" onClick={() => onSelect(null, true)}>
        {t("back")}
      </button>
      <h2 ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {alarm && <AlarmBody alarm={alarm} />}
      {station && <StationBody view={station} board={board} onOpen={onSelect} />}
      {host && <HostBody host={host} board={board} onOpen={onSelect} />}
    </div>
  );
}
