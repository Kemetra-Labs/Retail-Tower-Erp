/**
 * RT-1612 (D10, DESIGN.md §13.5a): one shared no-access state for system-plumbing
 * routes hidden from non-system roles (`/audit`, `/stock-discrepancies`). Names who
 * can open the page (§13.6) and offers a way back to Overview.
 */
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/icons/Icon";
import { useT } from "@/i18n";
import { Link } from "react-router";
import "@/auth/no-access.css";

export function SystemDetailNoAccess(): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <div className="noaccess">
        <span className="noaccess__icon" aria-hidden="true">
          <Icon name="lock" size="lg" />
        </span>
        <PageHeader
          title={t("shell.systemNoAccess.title")}
          subtitle={t("shell.systemNoAccess.body")}
        />
        <Link className="btn-secondary" to="/">
          {t("platform.noAccess.home")}
        </Link>
      </div>
    </div>
  );
}
