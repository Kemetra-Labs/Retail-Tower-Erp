/**
 * RT-958: the `errorElement` of the protected shell's pages. A page that throws
 * renders this inside the shell's content area, so the navigation, the top bar
 * and the scope header stay usable and another page opens without a reload.
 * It sits inside AppShell's <main>, so it renders no landmark of its own, and
 * its title is the page's one h1. Errors in the shell itself still reach the
 * root fallback (RouteErrorFallback).
 *
 * Copy reads What → Safety → Action → Evidence (DESIGN.md §8). Try again
 * re-enters the same location, which resets the router's error boundary; the
 * way out is the menu or Overview (not offered when Overview itself failed).
 */
import { useT } from "@/i18n";
import { Link, useLocation, useNavigate, useRouteError } from "react-router";
import { ErrorReference } from "./ErrorFallback";
import { useErrorReference } from "./RouteErrorFallback";
import "@/components/banner.css";
import "@/shell/surface.css";
import "./error-fallback.css";

export function ShellRouteErrorFallback(): React.JSX.Element {
  const t = useT();
  const reference = useErrorReference(useRouteError());
  const location = useLocation();
  const navigate = useNavigate();
  const retry = (): void => {
    void navigate(location, { replace: true, state: location.state });
  };
  return (
    <div className="surface">
      <header className="surface__head">
        <div>
          <h1 className="content__title">{t("app.routeError.title")}</h1>
        </div>
      </header>
      <div className="rtc-alert rtc-alert--danger" role="alert">
        <span className="rtc-alert__body">{t("app.routeError.what")}</span>
        <span className="rtc-alert__body">{t("app.crash.safety")}</span>
        <span className="rtc-alert__body">{t("app.routeError.action")}</span>
        <ErrorReference reference={reference} />
        <span className="rtc-alert__action rtc-crash__actions">
          <button type="button" className="btn-primary" onClick={retry}>
            {t("common.tryAgain")}
          </button>
          {location.pathname === "/" ? null : (
            <Link to="/" className="btn-secondary">
              {t("app.routeError.toOverview")}
            </Link>
          )}
        </span>
      </div>
    </div>
  );
}
