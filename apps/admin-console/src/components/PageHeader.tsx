/**
 * RT-969 (Shell v3): the page header every routed page renders first, inside
 * the content container. The canvas grammar: a 24px screen title
 * (`--text-screen-title`) with a muted subtitle under it at the inline start;
 * the page's actions, and an optional segmented control, at the inline end,
 * aligned to the subtitle's baseline and wrapping under the title when narrow.
 *
 * - `title` is the page's one `<h1>`. `titleRef` makes it a focus target
 *   (`tabIndex=-1`) for a page that moves focus to its title; `titleId` lets a
 *   region be labelled by it.
 * - `subtitle` is one muted line: where the page acts (scope) or what it shows.
 * - `children` sit under the subtitle: status chips, a second note.
 * - `actions` hold the page's buttons and links: at most one primary
 *   (DESIGN.md §9), destructive actions last.
 * - `segmented` is a view switch (`role="group"` + `aria-pressed` buttons) shown
 *   before the actions.
 *
 * A back link is not part of the header; it sits above it, as on the canvas.
 * The header keeps the classes earlier screens style against (`surface__head`,
 * `content__title`, `content__sub`).
 */
import "@/shell/surface.css";
import "./page-header.css";

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
  return (
    <header className="surface__head page-header">
      <div className="page-header__text">
        <h1
          ref={titleRef}
          id={titleId}
          tabIndex={titleRef ? -1 : undefined}
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
