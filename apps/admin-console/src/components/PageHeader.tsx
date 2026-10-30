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
 * leave focus where it is).
 * The header keeps the classes earlier screens style against (`surface__head`,
 * `content__title`, `content__sub`).
 */
import { composeDocumentTitle, useT } from "@/i18n";
import { useEffect, useRef } from "react";
import "@/shell/surface.css";
import "./page-header.css";

/** The path the last page header was shown for; null before the first page. */
let shownPath: string | null = null;

/** Names the document after the page, and moves focus to its title on a navigation. */
function usePageTitle(title: React.RefObject<HTMLHeadingElement | null>): void {
  const t = useT();
  useEffect(() => {
    document.title = composeDocumentTitle(t("app.title"));
    const path = window.location.pathname;
    if (path === shownPath) return;
    const navigated = shownPath !== null;
    shownPath = path;
    if (navigated) title.current?.focus();
  });
}

export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  segmented?: React.ReactNode;
  titleRef?: React.Ref<HTMLHeadingElement>;
  titleId?: string;
  children?: React.ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  segmented,
  titleRef,
  titleId,
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
  return (
    <header className="surface__head page-header">
      <div className="page-header__text">
        <h1
          ref={setTitle}
          id={titleId}
          // A focus target after navigation (never a Tab stop).
          tabIndex={-1}
          data-page-title=""
          className="content__title page-header__title"
        >
          {title}
        </h1>
        {subtitle ? <p className="content__sub page-header__sub">{subtitle}</p> : null}
        {children}
      </div>
      {hasEnd ? (
        <div className="page-header__end">
          {segmented}
          {actions}
        </div>
      ) : null}
    </header>
  );
}
