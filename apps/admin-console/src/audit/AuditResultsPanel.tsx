/**
 * RT-1019 (v4.0): the one panel every result state of the audit search sits in
 * (before the search, loading, no results, a refused or failed search, the
 * rows with their pager). It is titled by its heading, which says what the
 * panel holds, and its hint states the evidence rule once: rows are shown as
 * recorded, so codes are not translated and times are not converted.
 *
 * No section index («01»): the screen has a single panel (DESIGN.md §12.2).
 */
import { useT } from "@/i18n";
import "../shell/surface.css";
import "./audit.css";

/** A failed search or "Load more": the v4 banner shape, its copy unchanged. */
export function AuditBanner({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="audit-banner">{children}</div>;
}

export function AuditResultsPanel({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  // A plain group, not a landmark: once rows load, the table's own scroll region
  // already carries the name «Audit events», and a second region of the same
  // name would be announced twice. The heading still titles the panel.
  return (
    <div className="section-panel audit-results">
      <header className="audit-results__head">
        <h2 className="audit-results__title">{t("audit.table.caption")}</h2>
        <p className="audit-results__hint">{t("audit.panel.hint")}</p>
      </header>
      <div className="audit-results__body">{children}</div>
    </div>
  );
}
