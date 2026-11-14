import { useLang } from "../i18n/LangContext";
import type { Board } from "../model/types";
import { Trace } from "./Trace";

const SLOTS = [0, 1, 2, 3];

/** The four telemetry traces over the last 13 completed days. Without a board: busy placeholders, no figures. */
export function Telemetry({ board, paused }: { board: Board | null; paused: boolean }) {
  const { t } = useLang();

  if (!board) {
    return (
      <section className="pulse" aria-label={t("tlTitle")} aria-busy="true">
        {SLOTS.map((i) => (
          <div key={i} className="trace-cell skel" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        ))}
      </section>
    );
  }

  return (
    <section className={`pulse${paused ? " paused" : ""}`} role="group" aria-label={t("tlTitle")}>
      {board.telemetry.map((trace) => (
        <Trace key={trace.key} trace={trace} paused={paused} />
      ))}
    </section>
  );
}
