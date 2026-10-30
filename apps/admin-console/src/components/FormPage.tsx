/**
 * RT-971 (canvas «نموذج», DESIGN.md §9 "Form template"): the shared form-page
 * template. Four parts that compose:
 *
 * - `FormPage`: the page frame. A back link above the header, the `PageHeader`
 *   (the page's one `<h1>`), the page's notices (banners), then the body: the
 *   form panel and an optional aside beside it ("what happens next"), which
 *   wraps under the panel when narrow.
 * - `FormPanel`: the `<form>` itself, so the unsaved-work guard (RT-268) still
 *   tracks it. `variant="panel"` (a full page) is a single-column surface with a
 *   1px edge and the object radius, at most `--form-panel-max` wide;
 *   `variant="plain"` (a drawer, or a form inside a section panel) drops the
 *   surface, because panels never nest. The error summary sits at its top; the
 *   action bar at its foot: primary first, then Cancel as ghost (RT-957). On a
 *   page the action bar sticks to the bottom of the viewport while the form is
 *   taller than it.
 * - `FormSection`: a `<fieldset>` with its `<legend>` title, one or two columns
 *   of fields. `disabled` locks every control in it.
 * - `FormAside`: a short titled note beside the panel.
 *
 * Fields are `FormField` (labels above inputs, hint, required mark, inline
 * error). Context errors are a `Banner` in `notices`, never a summary entry.
 */
import { useId } from "react";
import { Link } from "react-router";
import { BackArrow } from "./BackArrow";
import { PageHeader } from "./PageHeader";
import "./form-page.css";

export interface FormPageProps {
  back?: { to: string; label: React.ReactNode };
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Banners about the page or the last submit: above the body, full width. */
  notices?: React.ReactNode;
  /** A `FormAside`, shown beside the panel. */
  aside?: React.ReactNode;
  /** The `FormPanel`. */
  children: React.ReactNode;
  /** Sections that belong to the page but not to the form (a status control). */
  after?: React.ReactNode;
}

export function FormPage({
  back,
  title,
  subtitle,
  notices,
  aside,
  children,
  after,
}: Readonly<FormPageProps>): React.JSX.Element {
  return (
    <div className="surface form-page">
      {back ? (
        <Link to={back.to} className="surface__back">
          <BackArrow /> {back.label}
        </Link>
      ) : null}
      <PageHeader title={title} subtitle={subtitle} />
      {notices}
      <div className="form-page__body">
        {children}
        {aside}
      </div>
      {after}
    </div>
  );
}

export interface FormPanelProps
  extends Omit<React.FormHTMLAttributes<HTMLFormElement>, "className" | "children"> {
  variant?: "panel" | "plain";
  /** An extra class: an inline form inside a section panel keeps its inset (`map-form`). */
  className?: string;
  /** A `FormErrorSummary`, at the top of the form. */
  summary?: React.ReactNode;
  /** The action bar: the primary action, then Cancel (`.btn-ghost`). */
  actions: React.ReactNode;
  children: React.ReactNode;
}

export function FormPanel({
  variant = "panel",
  className,
  summary,
  actions,
  children,
  ...form
}: Readonly<FormPanelProps>): React.JSX.Element {
  return (
    <form
      className={["form-panel", `form-panel--${variant}`, className].filter(Boolean).join(" ")}
      noValidate
      {...form}
    >
      {summary ? <div className="form-panel__summary">{summary}</div> : null}
      {children}
      <div className="form-panel__actions">{actions}</div>
    </form>
  );
}

export interface FormSectionProps {
  /** The section's legend. Omit it only when the form has one section and its title is the page's. */
  title?: React.ReactNode;
  /** A muted line under the title. */
  lead?: React.ReactNode;
  columns?: 1 | 2;
  disabled?: boolean;
  children: React.ReactNode;
}

export function FormSection({
  title,
  lead,
  columns = 1,
  disabled,
  children,
}: Readonly<FormSectionProps>): React.JSX.Element {
  return (
    <fieldset className="form-section" disabled={disabled}>
      {title ? <legend className="form-section__title">{title}</legend> : null}
      {lead ? <p className="form-section__lead">{lead}</p> : null}
      <div
        className={
          columns === 2 ? "form-section__fields form-section__fields--2" : "form-section__fields"
        }
      >
        {children}
      </div>
    </fieldset>
  );
}

export function FormAside({
  title,
  children,
}: Readonly<{ title: React.ReactNode; children: React.ReactNode }>): React.JSX.Element {
  const titleId = useId();
  return (
    <aside className="form-aside" aria-labelledby={titleId}>
      <h2 id={titleId} className="form-aside__title">
        {title}
      </h2>
      {children}
    </aside>
  );
}
