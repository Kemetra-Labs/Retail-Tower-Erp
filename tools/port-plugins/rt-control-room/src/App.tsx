import { useEffect, type ReactNode } from "react";
import { usePortPluginData } from "@port-labs/plugins-sdk/react";
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
  const { portToken, portApiBaseUrl, applyThemeCss } = usePortPluginData();

  useEffect(() => {
    applyThemeCss();
  }, [applyThemeCss]);

  if (!portApiBaseUrl || !portToken) {
    return <ShellMessage>Waiting for Port...</ShellMessage>;
  }

  return (
    <div className="shell">
      <main className="main" />
    </div>
  );
}

export default App;
