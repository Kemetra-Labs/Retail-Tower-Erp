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
 */
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { SectionIndex } from "@/components/SectionIndex";
import { type MessageKey, useT } from "@/i18n";
import { useSaleScope } from "@/sales/useSales";
import { useId } from "react";
import { Link } from "react-router";
import { type ReportItem, canOpenAnyReport, reportGroups } from "./reportsLogic";
import "../shell/surface.css";
import "./reports.css";

const STATUS_KEY: Record<ReportItem["kind"], MessageKey> = {
  available: "reports.status.available",
  review: "reports.status.review",
  proposed: "reports.status.proposed",
};

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
      <div className="reports-card reports-card--proposed" data-report={item.id}>
        <CardBody item={item} {...ids} />
      </div>
    );
  }
  return (
    <Link
      to={item.to}
      className="reports-card reports-card--open"
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
  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t("sales.list.scopePrompt")}</p>
      </div>
    );
  }
  const groups = reportGroups(scope.role);
  return (
    <div className="surface surface--v4 reports">
      <ListHeaderBand
        group={t("shell.nav.section.operations")}
        title={t("reports.nav.label")}
        subtitle={t.rich("reports.index.sub", { tenant: <bdi>{scope.tenantName}</bdi> })}
      />
      {canOpenAnyReport(scope.role) ? null : (
        <p className="content__sub">{t("reports.index.noneOpen")}</p>
      )}
      {groups.map((group, index) => {
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
