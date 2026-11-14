import { useEffect, useRef } from "react";
import { useLang } from "../i18n/LangContext";
import type { StringKey, Vars } from "../i18n/strings";
import type { Board, CableId, StationId } from "../model/types";

/** What a step lights: stations and cables outside it dim. `null` lights everything. */
export type TourSpot = {
  stations: readonly StationId[] | null;
  cables: readonly CableId[] | null;
};

export type TourStep = TourSpot & { title: string; text: string };

type T = (key: StringKey, vars?: Vars) => string;

/** The frames of the mockup (its `FRAMES`): the stations and cables each step puts in the light. */
const FRAMES: readonly (TourSpot & { n: 1 | 2 | 3 | 4 | 5 })[] = [
  { n: 1, stations: null, cables: null },
  { n: 2, stations: ["pos", "admin"], cables: ["c1", "c2"] },
  { n: 3, stations: ["core"], cables: ["c1", "c2", "c3"] },
  { n: 4, stations: ["conn", "erp"], cables: ["c3", "c4"] },
  { n: 5, stations: ["conn", "erp"], cables: ["c4"] },
];

function faultsPhrase(n: number, t: T): string {
  const key: StringKey = n === 1 ? "tourFaultsOne" : n === 2 ? "tourFaultsTwo" : n <= 10 ? "tourFaultsFew" : "tourFaultsMany";
  return t(key, { n });
}

/**
 * The last step speaks only of what the board holds: the faults on the invoice
 * cable (`c4`), "no faults reported" when there are none, and "not read" when
 * the error read failed (a count is then unknown, never zero). It never says healthy.
 */
function lastStepText(board: Board, t: T): string {
  const cable = board.cables.find((c) => c.id === "c4");
  if (!board.alarmRead.sentry || !cable) return t("tour5NotRead");
  if (cable.faults === 0) return t("tour5None");
  return t("tour5Faults", { faults: faultsPhrase(cable.faults, t) });
}

/** The five steps in the current language (`t`), with the last one filled from the board. */
export function tourSteps(board: Board, t: T): TourStep[] {
  return FRAMES.map(({ n, stations, cables }) => ({
    stations,
    cables,
    title: t(`tour${n}Title`),
    text: n === 5 ? lastStepText(board, t) : t(`tour${n}Text`),
  }));
}

export type TourProps = {
  steps: readonly TourStep[];
  /** The current step (0-based). The caller owns it, so it can dim the map to match. */
  index: number;
  onIndex: (index: number) => void;
  onEnd: () => void;
};

/**
 * A manual tour: Back, Next and Exit, nothing on a timer. Focus moves to Next
 * when it opens; Escape ends it, unless a detail is open or the key was already
 * used to close one (`defaultPrevented`): the detail keeps that Escape and the
 * next one ends the tour, whatever order the two listeners run in.
 */
export function Tour({ steps, index, onIndex, onEnd }: TourProps) {
  const { t } = useLang();
  const next = useRef<HTMLButtonElement>(null);
  const end = useRef(onEnd);
  end.current = onEnd;

  useEffect(() => {
    next.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An Escape that already closed a detail (marked as used) never ends the tour as well.
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[data-detail]")) end.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const last = steps.length - 1;
  const at = Math.min(Math.max(index, 0), last);
  const step = steps[at];
  if (!step) return null;
  return (
    <section className="tour card" role="region" aria-label={t("tourName")}>
      <div aria-live="polite">
        <h3>{step.title}</h3>
        <p>{step.text}</p>
      </div>
      <div className="row">
        <button type="button" aria-disabled={at === 0} onClick={() => at > 0 && onIndex(at - 1)}>
          {t("tourPrev")}
        </button>
        <span className="measured">{t("tourStep", { n: at + 1, total: steps.length })}</span>
        <button type="button" className="primary" ref={next} aria-disabled={at === last} onClick={() => at < last && onIndex(at + 1)}>
          {t("tourNext")}
        </button>
        <button type="button" onClick={() => end.current()}>
          {t("tourExit")}
        </button>
      </div>
    </section>
  );
}
