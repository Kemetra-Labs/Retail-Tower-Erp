import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlarmPanel } from "./components/AlarmPanel";
import { Header } from "./components/Header";
import { LowerPanels } from "./components/LowerPanels";
import { ModeSwitch, type Mode } from "./components/ModeSwitch";
import type { Freshness } from "./components/PanelHead";
import type { Selection } from "./components/room/selection";
import { StatusTable } from "./components/StatusTable";
import { ControlRoom } from "./components/room/ControlRoom";
import { useSelection } from "./components/room/useFocusReturn";
import { Telemetry } from "./components/Telemetry";
import { Tour, tourSteps } from "./components/Tour";
import { Verdict } from "./components/Verdict";
import { LangProvider, useLang } from "./i18n/LangContext";
import { usePortBridge } from "./bridge/usePortBridge";
import { isDemo } from "./state/demo";
import { usePaused } from "./state/usePaused";
import { useBoard } from "./state/useBoard";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/top.css";
import "./styles/room.css";
import "./styles/panel.css";
import "./styles/modes.css";

/** Where focus goes when the opener of a closed detail is gone: the active tab button. */
function activeTabButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
}

function ShellMessage({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <p className="muted" role="status">
        {children}
      </p>
    </div>
  );
}

/** The id of the labelled example alarm (`buildBoard` with `demo`). */
const EXAMPLE_ALARM_ID = "example-latency";

function ControlRoomApp() {
  // Hooks first, never after an early return: Port delivers the token on a
  // later render, and a conditional hook would blank the iframe.
  const { t } = useLang();
  const { applyThemeCss, status } = usePortBridge();
  // The example alarm is a review aid: its button exists only when the plugin URL has demo=1.
  const [demoAvailable] = useState(isDemo);
  const [demoOn, setDemoOn] = useState(false);
  // Gated inside by token, base URL, trust and visibility, so it is safe to call before the guards.
  const { board, events, replayQueue, status: boardStatus, replaying, onReplayDone, asOf, labUpdatedAt } = useBoard({ demo: demoOn });
  const [paused, togglePause] = usePaused();
  // The detail panel renders `selection`; Escape and Back return focus to the opener (or the active tab).
  const { selection, select } = useSelection({ fallback: activeTabButton });
  // Whether the keyboard opened the current selection: the detail then takes focus on its heading.
  const [openedByKey, setOpenedByKey] = useState(false);
  const open = useCallback(
    (sel: Selection, byKey?: boolean) => {
      setOpenedByKey(byKey === true);
      select(sel, byKey);
    },
    [select],
  );
  const [mode, setMode] = useState<Mode>("ops");
  const [tourOn, setTourOn] = useState(false);
  const [tourAt, setTourAt] = useState(0);
  const tourButton = useRef<HTMLButtonElement>(null);
  const story = mode === "story";
  const steps = useMemo(() => (board ? tourSteps(board, t) : []), [board, t]);
  const spot = story && tourOn ? (steps[tourAt] ?? null) : null;

  const endTour = useCallback((returnFocus: boolean) => {
    setTourOn(false);
    if (returnFocus) tourButton.current?.focus();
  }, []);
  const toggleTour = useCallback(() => {
    if (tourOn) return endTour(true);
    select(null);
    setTourAt(0);
    setTourOn(true);
  }, [tourOn, endTour, select]);
  // A mode switch ends the tour: it belongs to Story.
  const changeMode = useCallback(
    (next: Mode) => {
      if (next !== mode) endTour(false);
      setMode(next);
    },
    [mode, endTour],
  );
  const toggleDemo = useCallback(() => {
    // Turning the example off while its alarm is open drops the selection with it.
    if (demoOn && selection?.type === "alarm" && selection.id === EXAMPLE_ALARM_ID) select(null);
    setDemoOn(!demoOn);
  }, [demoOn, selection, select]);
  const asOfDate = useMemo(() => (asOf === null ? null : new Date(asOf)), [asOf]);
  // A stale board shows the last good snapshot, with the time of that sync on every panel.
  const fresh = useMemo<Freshness>(() => ({ stale: boardStatus === "stale", asOf: asOfDate }), [boardStatus, asOfDate]);

  useEffect(() => {
    applyThemeCss();
  }, [applyThemeCss]);

  if (status === "untrusted") {
    return <ShellMessage>{t("untrusted")}</ShellMessage>;
  }
  if (status !== "ready") {
    return <ShellMessage>{t("waiting")}</ShellMessage>;
  }

  const controls = (
    <>
      {demoAvailable && (
        <>
          <button type="button" onClick={toggleDemo}>
            {t(demoOn ? "demoOn" : "demo")}
          </button>
          {demoOn && <span className="chip stale">{t("exampleTag")}</span>}
        </>
      )}
      <ModeSwitch ref={tourButton} mode={mode} onMode={changeMode} tourOn={tourOn && story} onTour={toggleTour} />
    </>
  );

  return (
    <div className={`shell mode-${mode}`}>
      <Header
        board={board}
        status={boardStatus}
        replaying={replaying}
        asOf={asOfDate}
        labUpdatedAt={labUpdatedAt}
        paused={paused}
        onTogglePause={togglePause}
        controls={controls}
      />
      <main className="main">
        <Verdict board={board} status={boardStatus} />
        <Telemetry board={board} paused={paused} />
        {board ? (
          <>
            <div className="stage">
              <div className="stage-main">
                {story && tourOn && <Tour steps={steps} index={tourAt} onIndex={setTourAt} onEnd={() => endTour(true)} />}
                <ControlRoom
                  board={board}
                  events={events}
                  replayQueue={replayQueue}
                  paused={paused}
                  replaying={replaying}
                  onReplayDone={onReplayDone}
                  onSelect={open}
                  selection={selection}
                  readings={!story}
                  spot={spot}
                  table={story ? undefined : <StatusTable board={board} fresh={fresh} onSelect={open} />}
                />
              </div>
              <AlarmPanel
                board={board}
                events={events}
                selection={selection}
                onSelect={open}
                focusOnOpen={openedByKey}
                fresh={fresh}
              />
            </div>
            {mode === "ops" && <LowerPanels board={board} fresh={fresh} />}
          </>
        ) : (
          <section className="room" aria-busy={boardStatus === "loading"}>
            <p className="muted">{t(boardStatus === "error" ? "stateErrorNote" : "stateLoadingNote")}</p>
          </section>
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <LangProvider>
      <ControlRoomApp />
    </LangProvider>
  );
}

export default App;
