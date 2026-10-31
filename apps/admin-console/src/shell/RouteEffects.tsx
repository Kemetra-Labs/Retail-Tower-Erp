/**
 * RT-978: what the router root does on every route change, whether or not the
 * page renders a `PageHeader`. Mounted once inside the router (`RootLayout`).
 *
 * - Records the transition for the page header's focus rule (see
 *   `route-transition.ts`), so returning from sign-in to the same path moves
 *   focus to the page's `<h1>` while a scope change on one path does not.
 * - Names the document again: «<page> – <app>» when a page header is shown, the
 *   app title alone otherwise (sign-out, sign-in, gates), in the active locale.
 *   It reads the committed DOM, so it names the page that is shown; the page
 *   header also sets the title in its own effect, and both give the same result.
 */
import { composeDocumentTitle, useT } from "@/i18n";
import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { recordRoute, resetRouteTransitions } from "./route-transition";

export function RouteEffects(): null {
  const t = useT();
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    recordRoute(pathname);
  }, [pathname]);

  useLayoutEffect(() => resetRouteTransitions, []);

  useEffect(() => {
    // `pathname` is the trigger: the title follows the page that now renders.
    void pathname;
    document.title = composeDocumentTitle(t("app.title"));
  }, [pathname, t]);

  return null;
}
