import { useEffect, type ReactNode } from "react";
import { usePortBridge } from "./bridge/usePortBridge";
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

export function App() {
  // Hooks first, never after an early return: Port delivers the token on a
  // later render, and a conditional hook would blank the iframe.
  const { applyThemeCss, status } = usePortBridge();

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
      <main className="main" />
    </div>
  );
}

export default App;
