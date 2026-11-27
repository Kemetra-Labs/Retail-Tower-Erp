/**
 * RT-1020 (v4.0) «التقارير · الفهرس»: the reports index at `/reports`.
 *
 * Four groups (sales, cash and shifts, inventory, ERPNext integration), each a
 * section with its index badge. An item is one of three things, always named in
 * words and never by colour alone:
 * - available: the built report, a link;
 * - review screen: an existing screen, a link;
 * - proposed, not available yet: no link, no figure, no preview. It is a plain
 *   card that says so, because a report with no contract has nothing to show.
 *
 * The band carries no facts: the catalogue's own counts are not figures the
 * server serves for a set (C1), so they are left out rather than invented.
 * Nothing is read from Backend-Core here.
 *
 * Modern concept 2/6 — presentation only, same reads (none), routes, role
 * gates and copy:
 * - Wider rhythm: the page, group and grid gaps and the card padding grow one
 *   token step each (rule 1, less crowded), and cards widen to 20rem so fewer
 *   sit on a row. The cards keep the DESIGN v4 panel radius, resting shadow
 *   and existing colour roles; the root drops the `surface--v4` class:
 *   neither stylesheet this page loads defines it, so it has no effect here
 *   (and dropping it removes an order-dependent leak — a Reports visit after
 *   a Sales visit used to inherit Sales' v4 panel radius and shadow).
 *   `.surface--v4` rules live in `sales.css`, for the Sales page; the
 *   Overview's root is plain `surface`.
 * - A status filter below the band (the band holds no filters, RT-995): All /
 *   Available / Review screens / Proposed, a segmented switch in the
 *   TrendPanel pattern (`fieldset` + `aria-pressed`). It filters only the
 *   catalogue this page already renders for the role — no new read, no new
 *   route, no new report. Default is All, so the page on load is unchanged.
 * - Deliberately NOT added, because the page has nothing to compute them
 *   from: no smart insight (rule 4 — the page makes no Backend-Core read),
 *   no KPI strip (rule 3 — no figure is served for this set), no main action
 *   (rule 2 — the screen has no action; its cards are the navigation, and the
 *   band takes no `actions` and no `facts`). Sales by hour stays proposed:
 *   no contract serves hourly buckets (see the `sales-by-hour` note in
 *   `reportsLogic.ts`), so no hourly chart and no new report. No link to
 *   `/search` or `/alerts` (out of scope for this screen).
 */
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { SectionIndex } from "@/components/SectionIndex";
import { type MessageKey, useT } from "@/i18n";
import { useSaleScope } from "@/sales/useSales";
import { useId, useState } from "react";
import { Link } from "react-router";
import {
  type ReportGroup,
  type ReportItem,
  type ReportKind,
  canOpenAnyReport,
  reportGroups,
} from "./reportsLogic";
import "../shell/surface.css";
import "./reports.css";

const STATUS_KEY: Record<ReportItem["kind"], MessageKey> = {
  available: "reports.status.available",
  review: "reports.status.review",
  proposed: "reports.status.proposed",
};

/** The status filter: `all` is the page as it loads; the rest narrow the catalogue. */
type ReportFilter = "all" | ReportKind;

const FILTER_KEY: Record<ReportFilter, MessageKey> = {
  all: "reports.filter.all",
  available: "reports.filter.available",
  review: "reports.filter.review",
  proposed: "reports.filter.proposed",
};

const FILTERS: readonly ReportFilter[] = ["all", "available", "review", "proposed"];

/**
 * The status filter, below the band: a segmented switch (TrendPanel's
 * `fieldset` + `aria-pressed` pattern). It narrows only what is already on
 * the page for the role; switching reads nothing.
 */
function ReportsFilter({
  value,
  onChange,
}: Readonly<{ value: ReportFilter; onChange: (next: ReportFilter) => void }>): React.JSX.Element {
  const t = useT();
  return (
    <fieldset className="reports-filter">
      <legend className="sr-only">{t("reports.filter.label")}</legend>
      {FILTERS.map((filter) => (
        <button
          key={filter}
          type="button"
          className="reports-filter__btn"
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
        >
          {t(FILTER_KEY[filter])}
        </button>
      ))}
    </fieldset>
  );
}

function CardBody({
  item,
  titleId,
  statusId,
  questionId,
}: Readonly<{ item: ReportItem; titleId: string; statusId: string; questionId: string }>) {
  const t = useT();
  return (
    <>
      <span id={statusId} className={`reports-pill reports-pill--${item.kind}`}>
        {t(STATUS_KEY[item.kind])}
      </span>
      <span id={titleId} className="reports-card__title">
        {t(item.title)}
      </span>
      <span id={questionId} className="reports-card__question">
        <b>{t("reports.answers")}</b> {t(item.question)}
      </span>
    </>
  );
}

function ReportCard({ item }: Readonly<{ item: ReportItem }>): React.JSX.Element {
  const t = useT();
  const uid = useId();
  const ids = {
    titleId: `${uid}-t`,
    statusId: `${uid}-s`,
    questionId: `${uid}-q`,
  };
  if (item.kind === "proposed" || !item.to) {
    // Not available: a card, never a link, a button or a tab stop.
    return (
      <div
        className="section-panel reports-card reports-card--proposed"
        data-report={item.id}
      >
        <CardBody item={item} {...ids} />
      </div>
    );
  }
  return (
    <Link
      to={item.to}
      className="section-panel reports-card reports-card--open"
      data-report={item.id}
      aria-labelledby={ids.titleId}
      aria-describedby={`${ids.statusId} ${ids.questionId}`}
    >
      <CardBody item={item} {...ids} />
      <span className="reports-card__open" aria-hidden="true">
        {t(item.kind === "available" ? "reports.open.report" : "reports.open.screen")}
      </span>
    </Link>
  );
}

export function ReportsIndex(): React.JSX.Element {
  const t = useT();
  const scope = useSaleScope();
  const sectionId = useId();
  const [filter, setFilter] = useState<ReportFilter>("all");
  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("sales.list.scopePrompt")}</p>
      </div>
    );
  }
  const groups = reportGroups(scope.role);
  // The filter narrows the role's catalogue; an emptied group leaves the page.
  const visible: ReportGroup[] =
    filter === "all"
      ? groups
      : groups
          .map((group) => ({ ...group, items: group.items.filter((item) => item.kind === filter) }))
          .filter((group) => group.items.length > 0);
  return (
    <div className="surface reports">
      <ListHeaderBand
        group={t("shell.nav.section.daily")}
        title={t("reports.nav.label")}
        subtitle={t.rich("reports.index.sub", { tenant: <bdi>{scope.tenantName}</bdi> })}
      />
      <ReportsFilter value={filter} onChange={setFilter} />
      {filter === "all" && !canOpenAnyReport(scope.role) ? (
        <p className="content__sub">{t("reports.index.noneOpen")}</p>
      ) : null}
      {filter !== "all" && visible.length === 0 ? (
        <p className="content__sub">{t("reports.filter.none")}</p>
      ) : null}
      {visible.map((group, index) => {
        const headingId = `${sectionId}-${group.id}`;
        return (
          <section key={group.id} className="reports-group" aria-labelledby={headingId}>
            <div className="reports-group__head">
              <SectionIndex position={index + 1} />
              <h2 id={headingId} className="reports-group__title">
                {t(group.title)}
              </h2>
            </div>
            <ul className="reports-grid">
              {group.items.map((item) => (
                <li key={item.id}>
                  <ReportCard item={item} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
