/**
 * Root `errorElement` of the data router (RT-633). A data router catches route
 * render and loader errors itself, so they never reach AppErrorBoundary; this
 * reports them once and renders the same safe fallback. Since RT-958 it only
 * sees errors outside the protected shell's pages (the shell itself, sign-in,
 * the platform console); a page error stays in the shell (ShellRouteErrorFallback).
 */
import { useEffect, useState } from "react";
import { useRouteError } from "react-router";
import { ErrorFallback } from "./ErrorFallback";
import { reportError } from "./report";

/** Reports the error once (see reportError) and returns its reference, if any. */
export function useErrorReference(error: unknown): string | undefined {
  const [reference, setReference] = useState<string>();
  useEffect(() => {
    setReference(reportError(error));
  }, [error]);
  return reference;
}

export function RouteErrorFallback(): React.JSX.Element {
  const reference = useErrorReference(useRouteError());
  return <ErrorFallback reference={reference} />;
}
