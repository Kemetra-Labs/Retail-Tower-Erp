import { useEffect, useMemo, type ReactNode } from "react";
import { Header } from "./components/Header";
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
  const { board, status: boardStatus, replaying, asOf, labUpdatedAt } = useBoard();
  const [paused, togglePause] = usePaused();
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
        {/* The control room diagram and the alarm panels are added by the next tasks. */}
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
