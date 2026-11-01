/**
 * RT-993 the Overview side column (DESIGN.md §12.4, D-V7): quick actions, the
 * attention list (RT-559, kept from v2), stores today and low stock.
 *
 * - Quick actions: at most four, one colour family, each a destination that
 *   exists and that the role may open (the same gates as the navigation), with
 *   a one-line description of what it opens. None performs an action.
 * - Stores today and low stock have no backing read yet. By owner decision
 *   2026-11-01 (RT-993 comment 15088, amending §12.8.6) each renders its frame
 *   with a clear «قريبًا» state and no invented figure. The reads: store share
 *   RT-1053 (`consoleGetSalesByStore` runtime), low-stock severity RT-1055.
 */
import { canReadCatalog } from "@/catalog/catalogLogic";
import { type MessageKey, useT } from "@/i18n";
import { canUseSaleSyncOps } from "@/sale-sync/saleSyncLogic";
import { canReadSales } from "@/sales/saleLogic";
import { useId } from "react";
import { Link } from "react-router";

type Gate = (role: string | null | undefined) => boolean;

const always: Gate = () => true;

const QUICK_ACTIONS: readonly { to: string; label: MessageKey; note: MessageKey; gate: Gate }[] = [
  {
    to: "/sales-daily",
    label: "overview.quick.salesDaily",
    note: "overview.quick.salesDailyNote",
    gate: canReadSales,
  },
  {
    to: "/sales-needing-repair",
    label: "overview.quick.repair",
    note: "overview.quick.repairNote",
    gate: canUseSaleSyncOps,
  },
  {
    to: "/catalog/products",
    label: "overview.quick.catalog",
    note: "overview.quick.catalogNote",
    gate: canReadCatalog,
  },
  // The navigation lists users for every role (`nav-model.ts`); the API decides.
  {
    to: "/operators",
    label: "overview.quick.operators",
    note: "overview.quick.operatorsNote",
    gate: always,
  },
];

function QuickAction({ to, label, note }: Readonly<{ to: string; label: string; note: string }>) {
  const noteId = useId();
  return (
    <li className="quick-actions__item">
      <Link className="ledger__link" to={to} aria-describedby={noteId}>
        {label}
      </Link>
      <span id={noteId} className="quick-actions__note">
        {note}
      </span>
    </li>
  );
}

function QuickActions({ role }: Readonly<{ role: string | null }>): React.JSX.Element | null {
  const t = useT();
  const titleId = useId();
  const actions = QUICK_ACTIONS.filter((a) => a.gate(role)).slice(0, 4);
  if (actions.length === 0) return null;
  return (
    <nav className="section-panel" aria-labelledby={titleId}>
      <div className="section-panel__head">
        <h2 id={titleId} className="section-panel__title">
          {t("overview.quick.title")}
        </h2>
      </div>
      <div className="section-panel__body">
        {/* biome-ignore lint/a11y/useSemanticElements: the explicit list role is the Safari workaround, not a replacement element. */}
        {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics from a marker-free list; the role restores them. */}
        <ul className="quick-actions" role="list">
          {actions.map((a) => (
            <QuickAction key={a.to} to={a.to} label={t(a.label)} note={t(a.note)} />
          ))}
        </ul>
      </div>
    </nav>
  );
}

/** A widget whose read does not exist yet: its frame, «قريبًا», and what will appear. */
function ComingSoon({ title, note }: Readonly<{ title: MessageKey; note: MessageKey }>) {
  const t = useT();
  const titleId = useId();
  return (
    <section className="section-panel" aria-labelledby={titleId}>
      <div className="section-panel__head">
        <h2 id={titleId} className="section-panel__title">
          {t(title)}
        </h2>
        <span className="soon-chip glance-head-link">{t("overview.soon")}</span>
      </div>
      <div className="section-panel__body">
        <p className="soon-panel__note">{t(note)}</p>
      </div>
    </section>
  );
}

export function SideColumn({
  role,
  attention,
}: Readonly<{ role: string | null; attention: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <section className="overview__side" aria-label={t("overview.side.label")}>
      <QuickActions role={role} />
      {attention}
      <ComingSoon title="overview.stores.title" note="overview.stores.soon" />
      <ComingSoon title="overview.lowStock.title" note="overview.lowStock.soon" />
    </section>
  );
}
