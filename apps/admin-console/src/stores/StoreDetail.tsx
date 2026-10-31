import { StorePolicySection } from "@/cash-policy/StorePolicySection";
import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import {
  DetailGrid,
  DetailPanel,
  HeaderStatus,
  LedgerField,
  PanelBody,
} from "@/components/DetailPanel";
import { ListState } from "@/components/ListState";
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
/**
 * SF-S2 — Store detail (T027; RT-400 screen 19). Read-first field rows plus
 * the state badge and the store's time zone (RT-477), and «تعديل المتجر» in the header for everyone (no role
 * pre-hide, OQ-3; the server's 403 is the authority). 404 renders uniformly
 * (FR-004-008).
 *
 * There is no delete or closure action: permanent closure is a governed
 * workflow (Org & Store decision 194), not something this V1 surface offers.
 *
 * RT-371: «أجهزة هذا المتجر» deep-links to the device registry filtered to this
 * store. Like the edit action it is shown to everyone (no role pre-hide, OQ-3
 * / VG-5): the device API's non-disclosing 404 is the authority, and the
 * registry renders it as "this store's devices are not available to you". The
 * link sets a filter in the URL, never the active scope.
 *
 * RT-389: the shift variance policy section sits under the fields. It decides
 * its own visibility from the role (owner / tenant_admin edit, store_manager
 * reads, others see nothing), so this page adds no role gate of its own.
 *
 * RT-961: the v3 detail template: the back link to the list, the page header,
 * then the store's ledger in a section panel.
 *
 * RT-1012 (v4.0): the header is the Ink entity band (initials tile, name, state;
 * «تعديل المتجر» is its one primary) and the sections are numbered in the
 * board's order: 01 store data, 02 timing, 03 this store's devices, 04 store
 * status. The time zone change (with its impact review) and suspend / activate
 * stay on the edit route where their data flow lives (behaviour unchanged);
 * sections 02 and 04 read the served value and link there. Not drawn, because
 * nothing serves them: the active-device and open-shift counts, the store
 * clock and the business-day bar.
 */
import { Link, useParams } from "react-router";
import { ScopePrompt } from "./ScopePrompt";
import { StoreHeroArt } from "./StoreHeroArt";
import { StoreInitials } from "./StoreInitials";
import { StoreStateBadge } from "./StoreStateBadge";
import { ZoneName } from "./ZoneName";
import { useStoreDetail } from "./useStoreQueries";
import "../shell/surface.css";
import "./stores.css";

export function StoreDetail(): React.JSX.Element {
  const t = useT();
  const { storeId } = useParams();
  const { result, isLoading } = useStoreDetail(storeId);

  if (isLoading) {
    return (
      <div className="surface">
        <ListState state="loading" label={t("stores.detail.loadingNoun")} />
      </div>
    );
  }

  if (result?.kind === "error") {
    if (result.render.kind === "scope-required") {
      return <ScopePrompt />;
    }
    return (
      <div className="surface">
        <Banner
          variant="danger"
          message={t(result.render.messageKey)}
          requestId={result.render.kind === "banner" ? result.render.requestId : undefined}
        />
        <Link to="/stores" className="surface__back">
          <BackArrow /> {t("stores.detail.back")}
        </Link>
      </div>
    );
  }

  const store = result?.kind === "store" ? result.store : undefined;
  if (!store) {
    return <div className="surface" />;
  }

  const suspended = store.is_active === false;
  return (
    <div className="surface stores-v4">
      <Link to="/stores" className="surface__back">
        <BackArrow /> {t("stores.detail.back")}
      </Link>
      <div className="store-hero">
        <StoreHeroArt />
        <StoreInitials name={store.name} size="lg" />
        <PageHeader
          title={store.name}
          actions={
            <div className="surface__actions surface__actions--head">
              <Link to={`/stores/${store.id}/edit`} className="btn-primary">
                {t("stores.detail.edit")}
              </Link>
            </div>
          }
        >
          <HeaderStatus label={t("stores.field.state")}>
            <StoreStateBadge isActive={store.is_active} />
          </HeaderStatus>
        </PageHeader>
      </div>

      <DetailGrid>
        <DetailPanel id="store-data-title" title={t("stores.section.data")} index={1}>
          <PanelBody>
            <dl className="surface__detail">
              <LedgerField label={t("stores.field.code")} mono>
                <bdi dir="ltr">{store.code}</bdi>
              </LedgerField>
              <LedgerField label={t("stores.field.id")} mono>
                <bdi dir="ltr">{store.id}</bdi>
              </LedgerField>
            </dl>
          </PanelBody>
        </DetailPanel>

        <DetailPanel
          id="store-timing-title"
          title={t("stores.form.timingSection")}
          index={2}
          aside={<span className="store-panel-note">{t("stores.timing.sub")}</span>}
        >
          <PanelBody>
            <dl className="surface__detail">
              <LedgerField label={t("stores.field.timezone")}>
                <ZoneName zone={store.timezone} />
              </LedgerField>
            </dl>
            <p className="store-panel-row">
              <Link to={`/stores/${store.id}/edit`} className="store-panel-link">
                {t("stores.detail.changeTimezone")}
              </Link>
            </p>
          </PanelBody>
        </DetailPanel>
      </DetailGrid>

      <DetailPanel id="store-devices-title" title={t("stores.detail.devicesSection")} index={3}>
        <PanelBody>
          <p className="store-panel-note">{t("stores.detail.devicesBody")}</p>
          <p className="store-panel-row">
            <Link
              to={{ pathname: "/devices", search: `?store=${encodeURIComponent(store.id)}` }}
              className="store-panel-link"
            >
              {t("stores.detail.devices")}
            </Link>
          </p>
        </PanelBody>
      </DetailPanel>

      <DetailPanel
        id="store-status-title"
        title={t("stores.status.title")}
        index={4}
        className="store-section--status"
      >
        <PanelBody>
          <p className="store-panel-note">
            {t(suspended ? "stores.detail.statusBodySuspended" : "stores.detail.statusBody")}
          </p>
          <p className="store-panel-row">
            <Link to={`/stores/${store.id}/edit`} className="store-panel-link">
              {t(suspended ? "stores.detail.activateStatus" : "stores.detail.changeStatus")}
            </Link>
          </p>
        </PanelBody>
      </DetailPanel>

      <StorePolicySection storeId={store.id} timeZone={store.timezone} />
    </div>
  );
}
