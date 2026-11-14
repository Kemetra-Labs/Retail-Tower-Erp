import { useEffect, useState } from "react";
import { useLang } from "../i18n/LangContext";
import type { Board } from "../model/types";
import type { BoardEvent } from "../state/diff";
import { AlarmList } from "./AlarmList";
import { AlarmAnnouncer } from "./Announcer";
import { Detail, isResolvable } from "./Detail";
import { EventList } from "./EventList";
import { StaleChip, type Freshness } from "./PanelHead";
import type { Selection } from "./room/selection";

export type AlarmPanelProps = {
  board: Board;
  /** Newest first (from `useBoard`). */
  events: BoardEvent[];
  selection: Selection;
  /** `byKey` is true when the keyboard did it. */
  onSelect: (sel: Selection, byKey?: boolean) => void;
  /** True when the keyboard opened the current selection: the detail heading then takes focus. */
  focusOnOpen?: boolean;
  /** The last good snapshot, when a poll failed in part. */
  fresh?: Freshness;
};

type Tab = "alarms" | "events";

/**
 * The side panel: an Alarms tab and an Events tab, and the detail of what is
 * selected in their place. The lists stay mounted (hidden) while a detail is
 * open, so the tab and the list keep their place and focus can return to them.
 * Also holds the board's one quiet `role="status"` region.
 */
export function AlarmPanel({ board, events, selection, onSelect, focusOnOpen = false, fresh }: AlarmPanelProps) {
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>("alarms");
  const open = isResolvable(board, selection);

  // A selection that no longer exists (an alarm cleared, the example turned off) is dropped quietly.
  useEffect(() => {
    if (selection !== null && !open) onSelect(null, false);
  }, [selection, open, onSelect]);

  const notRead = !board.alarmRead.sentry;
  return (
    <>
      <section className="side card" aria-label={t("alarms")}>
        {fresh?.stale && (
          <div className="stale-row">
            <StaleChip fresh={fresh} />
            <span className="note">{t("alarmsMayBeMissing")}</span>
          </div>
        )}
        {open && <Detail board={board} selection={selection} onSelect={onSelect} focusOnOpen={focusOnOpen} />}
        <div hidden={open} data-lists>
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              id="tab-alarms"
              aria-selected={tab === "alarms"}
              aria-controls="panel-alarms"
              onClick={() => setTab("alarms")}
            >
              {`${t("alarms")} (${board.alarms.length})`}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-events"
              aria-selected={tab === "events"}
              aria-controls="panel-events"
              onClick={() => setTab("events")}
            >
              {t("events")}
            </button>
          </div>
          <div role="tabpanel" id="panel-alarms" aria-labelledby="tab-alarms" hidden={tab !== "alarms"}>
            {notRead && (
              <p className="note stale-note">
                {t("errorsNotRead")}. {t("alarmsMayBeMissing")}
              </p>
            )}
            {board.alarms.length === 0 && !notRead && <p className="muted">{t("alarmsEmpty")}</p>}
            <AlarmList board={board} selection={selection} onSelect={onSelect} />
          </div>
          <div role="tabpanel" id="panel-events" aria-labelledby="tab-events" hidden={tab !== "events"}>
            <EventList events={events} />
          </div>
        </div>
      </section>
      <AlarmAnnouncer events={events} />
    </>
  );
}
