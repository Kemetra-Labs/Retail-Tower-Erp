/**
 * RT-974 — the sale's ERPNext posting failure, as a state-only banner under the
 * page header (DESIGN.md §8): What (which posting was not made), the posting
 * state as its Evidence, and the Action (the ERPNext connection page, only for
 * the roles that can open it, so no role is sent to a dead destination).
 *
 * The detail read carries the state and nothing else: no reason, no record of
 * what the failure changed. So the banner states neither a cause nor a safety
 * claim; a per-sale reason waits for a Backend-Core contract (RT-977).
 *
 * RT-1009: the v4 shape (a red strip at the inline start) comes from the
 * `sale-erp-failure` wrapper; the copy and the action are unchanged.
 */
import { Banner } from "@/components/Banner";
import { canReadErpStatus } from "@/erp-status/erpStatusLogic";
import { type MessageKey, useT } from "@/i18n";
import type { SaleDetail } from "@/lib/sale-queries";
import { Link } from "react-router";
import { erpStateKey } from "./saleLogic";

interface Failure {
  what: MessageKey;
  field: MessageKey;
  state: string;
}

/** The failed posting, the sale's own first; null when nothing failed. */
function failureOf(erp: SaleDetail["erpPosting"]): Failure | null {
  if (erp.sale === "failed") {
    return { what: "sales.erpFailure.sale", field: "sales.erp.sale", state: erp.sale };
  }
  if (erp.reversal === "failed") {
    return { what: "sales.erpFailure.reversal", field: "sales.erp.reversal", state: erp.reversal };
  }
  return null;
}

export function ErpFailureBanner({
  detail,
  role,
}: Readonly<{ detail: SaleDetail; role: string | null }>): React.JSX.Element | null {
  const t = useT();
  const failure = failureOf(detail.erpPosting);
  if (!failure) return null;
  return (
    <div className="sale-erp-failure">
      <Banner
        variant="danger"
        title={t(failure.what)}
        message={t("sales.erpFailure.evidence", {
          field: t(failure.field),
          state: t(erpStateKey({ erpPostingState: failure.state })),
        })}
        action={
          canReadErpStatus(role) ? (
            <Link to="/erp-connection" className="btn-secondary">
              {t("erp.nav.label")}
            </Link>
          ) : undefined
        }
      />
    </div>
  );
}
