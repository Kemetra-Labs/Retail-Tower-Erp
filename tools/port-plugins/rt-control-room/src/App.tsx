import { useEffect, useMemo, type ReactNode } from "react";
import { Header } from "./components/Header";
import { ControlRoom } from "./components/room/ControlRoom";
import { useSelection } from "./components/room/useFocusReturn";
import { Telemetry } from "./components/Telemetry";
import { Verdict } from "./components/Verdict";
import { LangProvider, useLang } from "./i18n/LangContext";
import { usePortBridge } from "./bridge/usePortBridge";
import { usePaused } from "./state/usePaused";
import { useBoard } from "./state/useBoard";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/top.css";
import "./styles/room.css";

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

function ControlRoomApp() {
  // Hooks first, never after an early return: Port delivers the token on a
  // later render, and a conditional hook would blank the iframe.
  const { t } = useLang();
  const { applyThemeCss, status } = usePortBridge();
  // Gated inside by token, base URL, trust and visibility, so it is safe to call before the guards.
  const { board, events, replayQueue, status: boardStatus, replaying, onReplayDone, asOf, labUpdatedAt } = useBoard();
  const [paused, togglePause] = usePaused();
  // The detail panel (next task) renders `selection`; Escape and Back return focus to the opener.
  const { selection, select } = useSelection({ fallback: activeTabButton });
  const asOfDate = useMemo(() => (asOf === null ? null : new Date(asOf)), [asOf]);

  useEffect(() => {
    applyThemeCss();
  }, [applyThemeCss]);

  if (status === "untrusted") {
    return <ShellMessage>{t("untrusted")}</ShellMessage>;
  }
  if (status !== "ready") {
    return <ShellMessage>{t("waiting")}</ShellMessage>;
  }

  return (
    <div className="shell">
      <Header
        board={board}
        status={boardStatus}
        replaying={replaying}
        asOf={asOfDate}
        labUpdatedAt={labUpdatedAt}
        paused={paused}
        onTogglePause={togglePause}
      />
      <main className="main">
        <Verdict board={board} status={boardStatus} />
        <Telemetry board={board} paused={paused} />
        {board ? (
          <ControlRoom
            board={board}
            events={events}
            replayQueue={replayQueue}
            paused={paused}
            replaying={replaying}
            onReplayDone={onReplayDone}
            onSelect={select}
            selection={selection}
          />
        ) : (
          <section className="room" aria-busy={boardStatus === "loading"}>
            <p className="muted">{t(boardStatus === "error" ? "stateErrorNote" : "stateLoadingNote")}</p>
          </section>
        )}
        {/* The alarm panels and the detail are added by the next task. */}
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
