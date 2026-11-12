/**
 * RT-1338 offers list (RT-286 S6): the active tenant's offers, newest first, with state, schedule,
 * store scope and current version. Filtered by derived state; archived offers leave the default
 * list (the server hides them) and show under the Archived filter. For a store_manager the server
 * returns only offers that cover one of their stores and filters the stores to theirs.
 *
 * Read: owner, tenant_admin, store_manager. "New offer" is for owner and tenant_admin. Any other
 * role gets NoAccess and nothing is requested; no active tenant → a scope prompt. Errors show
 * catalog copy and the request id, never the server's words. A failed "Load more" keeps the rows.
 */
import { NoAccess } from "@/auth/NoAccess";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ScopePrompt } from "@/components/ScopePrompt";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { usePayerStores } from "@/payers/usePayerStores";
import type { ScopeMembership } from "@/shell/scope-stores";
import { useSignOut } from "@/shell/useSignOut";
import { useState } from "react";
import { useNavigate } from "react-router";
import { OfferFilterBar } from "./OfferFilterBar";
import { OfferListBody } from "./OfferListBody";
import { offerAccess } from "./offerLogic";
import { type OfferFilters, useOfferList } from "./useOffers";
import "../shell/surface.css";
import "./offers.css";

export function OfferList(): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const { context } = useActiveContextValue();
  const tenant = context?.active_tenant ?? null;
  const membership = context?.memberships?.find((m) => m.tenant_id === tenant?.id) as
    | ScopeMembership
    | undefined;
  const access = offerAccess(context?.active_role_code, membership?.store_access_kind);
  const [filters, setFilters] = useState<OfferFilters>({});
  const list = useOfferList(tenant?.id ?? null, filters, access.canRead);
  const roster = usePayerStores(tenant?.id ?? null, access.canRead);

  if (!tenant?.id) {
    return <ScopePrompt message={t("offers.list.scopePrompt")} />;
  }
  if (!access.canRead) return <NoAccess onSignOut={signOut} />;

  const subtitle = t.rich("offers.list.subtitle", {
    tenant: <bdi>{tenant.name ?? tenant.id}</bdi>,
  });
  const newButton = access.canManage ? (
    <button type="button" className="btn-primary" onClick={() => navigate("/offers/new")}>
      {t("offers.list.create")}
    </button>
  ) : undefined;
  return (
    <div className="surface">
      <ListHeaderBand
        group={t("shell.nav.section.management")}
        title={t("offers.list.title")}
        subtitle={subtitle}
        actions={newButton}
      />
      {access.tenantWide && context?.active_role_code !== "store_manager" ? null : (
        <p className="field__hint">{t("offers.list.ownStoresNote")}</p>
      )}
      <OfferFilterBar onApply={setFilters} />
      <OfferListBody
        list={list}
        filtered={Boolean(filters.state)}
        roster={roster}
        onOpen={(offerId) => navigate(`/offers/${offerId}`)}
      />
    </div>
  );
}
