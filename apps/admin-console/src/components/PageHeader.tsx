/**
 * RT-969 (Shell v3): the page header every routed page renders first, inside
 * the content container. The canvas grammar: a 24px screen title
 * (`--text-screen-title`) with a muted subtitle under it at the inline start;
 * the page's actions, and an optional segmented control, at the inline end,
 * aligned to the subtitle's baseline and wrapping under the title when narrow.
 *
 * - `title` is the page's one `<h1>`, a focus target (`tabIndex=-1`);
 *   `titleRef` reaches it for a page that moves focus itself; `titleId` lets a
 *   region be labelled by it.
 * - `subtitle` is one muted line: where the page acts (scope) or what it shows.
 * - `children` sit under the subtitle: status chips, a second note.
 * - `actions` hold the page's buttons and links: at most one primary
 *   (DESIGN.md §9), destructive actions last.
 * - `segmented` is a view switch (`role="group"` + `aria-pressed` buttons) shown
 *   before the actions.
 *
 * A back link is not part of the header; it sits above it, as on the canvas.
 *
 * RT-963: the header also names the document («<page> – <app>», WCAG 2.4.2)
 * and, after a navigation to another path, moves focus to its `<h1>`, so a
 * screen reader starts on the new page (scope changes and the first load
 * leave focus where it is; RT-978: navigations are recorded by `RouteEffects`).
 * The header keeps the classes earlier screens style against (`surface__head`,
 * `content__title`, `content__sub`).
 */
import { composeDocumentTitle, useT } from "@/i18n";
import { takeNavigationFocus } from "@/shell/route-transition";
import { useEffect, useRef } from "react";
import "@/shell/surface.css";
import "./page-header.css";

/**
 * Names the document after the page, and moves focus to its title when the
 * router root saw a navigation (RT-978: `RouteEffects` records every path
 * change, including routes without a header, so a return from sign-in to the
 * same path counts and a scope-change remount does not).
 */
function usePageTitle(title: React.RefObject<HTMLHeadingElement | null>): void {
  const t = useT();
  useEffect(() => {
    document.title = composeDocumentTitle(t("app.title"));
    if (takeNavigationFocus()) title.current?.focus();
  });
}

export interface BandFact {
  /** What the figure counts, as the reader names it ("Active memberships"). */
  label: string;
  /** The figure the server serves for the whole set. */
  value: React.ReactNode;
}

/** One to three facts, never more (D-V9). */
export type BandFacts =
  | readonly [BandFact]
  | readonly [BandFact, BandFact]
  | readonly [BandFact, BandFact, BandFact];

/**
 * RT-995 (D-V9): the Ink band of a list page, rendered through `ListHeaderBand`.
 * `group` is the navigation-group label above the title; `facts` are at most
 * three values the server serves for the whole set, named by `label`.
 */
export interface PageHeaderBand {
  group: string;
  facts?: { label: string; items: BandFacts };
}

export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  segmented?: React.ReactNode;
  titleRef?: React.Ref<HTMLHeadingElement>;
  titleId?: string;
  /** The Ink list band variant (RT-995); use `ListHeaderBand`, not this prop. */
  band?: PageHeaderBand;
  children?: React.ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  segmented,
  titleRef,
  titleId,
  band,
  children,
}: Readonly<PageHeaderProps>): React.JSX.Element {
  const hasEnd = Boolean(actions) || Boolean(segmented);
  const ownRef = useRef<HTMLHeadingElement>(null);
  usePageTitle(ownRef);
  const setTitle = (node: HTMLHeadingElement | null) => {
    ownRef.current = node;
    if (typeof titleRef === "function") titleRef(node);
    else if (titleRef) titleRef.current = node;
  };
  const ink = band ? " list-band" : "";
  return (
    <header className={`surface__head page-header${ink}`}>
      <div className={`page-header__text${band ? " list-band__id" : ""}`}>
        {band ? (
          <span className="list-band__group">
            <span className="list-band__rule" aria-hidden="true" />
            {band.group}
          </span>
        ) : null}
        <h1
          ref={setTitle}
          id={titleId}
          // A focus target after navigation (never a Tab stop).
          tabIndex={-1}
          data-page-title=""
          className={`content__title page-header__title${band ? " list-band__title" : ""}`}
        >
          {title}
        </h1>
        {subtitle ? (
          <p className={`content__sub page-header__sub${band ? " list-band__sub" : ""}`}>
            {subtitle}
          </p>
        ) : null}
        {children}
      </div>
      {band?.facts ? (
        <dl className="list-band__facts" aria-label={band.facts.label}>
          {band.facts.items.map((fact) => (
            <div key={fact.label}>
              {/* dt before dd (the dl content model); CSS shows the figure on top. */}
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {hasEnd ? (
        <div className={`page-header__end${band ? " list-band__end" : ""}`}>
          {segmented}
          {actions}
        </div>
      ) : null}
    </header>
  );
}
