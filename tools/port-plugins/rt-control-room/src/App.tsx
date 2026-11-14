import { useEffect, type ReactNode } from "react";
import { usePortBridge } from "./bridge/usePortBridge";
import { useBoard, type BoardStatus } from "./state/useBoard";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";

function ShellMessage({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <p className="muted" role="status">
        {children}
      </p>
    </div>
  );
}

const STATUS_TEXT: Record<BoardStatus, string> = {
  loading: "Loading the board...",
  ready: "Board ready",
  stale: "Showing the last good data",
  error: "Port could not be read",
};

export function App() {
  // Hooks first, never after an early return: Port delivers the token on a
  // later render, and a conditional hook would blank the iframe.
  const { applyThemeCss, status } = usePortBridge();
  // Gated inside by token, base URL, trust and visibility, so it is safe to call before the guards.
  const { status: boardStatus } = useBoard();

  useEffect(() => {
    applyThemeCss();
  }, [applyThemeCss]);

  if (status === "untrusted") {
    return <ShellMessage>Untrusted Port API host</ShellMessage>;
  }
  if (status !== "ready") {
    return <ShellMessage>Waiting for Port...</ShellMessage>;
  }

  return (
    <div className="shell">
      <main className="main">
        <p className="muted" role="status">
          {STATUS_TEXT[boardStatus]}
        </p>
      </main>
    </div>
  );
}

export default App;
