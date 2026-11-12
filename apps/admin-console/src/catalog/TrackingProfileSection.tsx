/**
 * RT-455 part 2 (item 4): a product's tracking profile, read only, on the
 * product page (`tenantAdminGetTrackingProfile`). The setter is not here: the
 * owner has not asked for it. The section shows only for a tracked product
 * (batch or serial) and only while the tenant's tracked-selling switch is on
 * (OD-T4): otherwise it renders nothing and reads nothing. The values are the
 * server's; a failed read says so with a retry and never shows a default.
 */
import { Banner } from "@/components/Banner";
import { BusyButton } from "@/components/BusyButton";
import { DetailPanel, LedgerField, PanelBody } from "@/components/DetailPanel";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import { getTrackingProfile } from "@/lib/tracking-queries";
import { trackedSellingOn } from "@/tracked-selling/trackedSellingLogic";
import { useTrackedSellingQuery } from "@/tracked-selling/useTrackedSelling";
import { canReadHolds } from "@/tracking/trackingLogic";
import { useQuery } from "@tanstack/react-query";
import { trackingKey } from "./catalogLogic";

export function TrackingProfileSection({
  productId,
  trackingMode,
  tenantId,
  role,
}: Readonly<{
  productId: string;
  trackingMode: string;
  tenantId: string | null;
  role: string | null | undefined;
}>): React.JSX.Element | null {
  const t = useT();
  // The profile read is owner / tenant_admin only (any other role is a 404).
  const tracked = (trackingMode === "batch" || trackingMode === "serial") && canReadHolds(role);
  const gate = useTrackedSellingQuery(tenantId, role, tracked);
  const on = tracked && trackedSellingOn(gate.data);
  const profile = useQuery({
    queryKey: ["tracking-profile", tenantId, productId],
    enabled: on && Boolean(tenantId),
    retry: false,
    queryFn: async () => {
      const res = await getTrackingProfile(productId);
      if (res.status !== 200 || !res.data) throw new Error(`tracking profile ${res.status}`);
      return res.data;
    },
  });
  if (!on) return null;
  const data = profile.data;
  return (
    <DetailPanel id="catalog-detail-tracking-profile" title={t("catalog.trackingProfile.title")}>
      <PanelBody>
        {profile.isLoading ? (
          <ListState state="loading" label={t("catalog.trackingProfile.loadingNoun")} />
        ) : null}
        {profile.isError ? (
          <Banner
            variant="warning"
            message={t("catalog.trackingProfile.loadFailed")}
            action={
              <BusyButton
                type="button"
                className="btn-secondary"
                busy={profile.isFetching}
                onClick={() => void profile.refetch()}
              >
                {t("trackedSelling.retry")}
              </BusyButton>
            }
          />
        ) : null}
        {data ? (
          <dl className="surface__detail" data-testid="catalog-tracking-profile">
            <LedgerField label={t("catalog.trackingProfile.mode")}>
              {t(trackingKey(data.tracking_mode))}
            </LedgerField>
            <LedgerField label={t("catalog.trackingProfile.expiryRequired")}>
              {t(
                data.expiry_required ? "catalog.trackingProfile.yes" : "catalog.trackingProfile.no",
              )}
            </LedgerField>
            <LedgerField label={t("catalog.trackingProfile.locked")}>
              {t(
                data.profile_locked ? "catalog.trackingProfile.yes" : "catalog.trackingProfile.no",
              )}
            </LedgerField>
          </dl>
        ) : null}
        {data?.profile_locked ? (
          <p className="catalog-hint">{t("catalog.trackingProfile.lockedNote")}</p>
        ) : null}
      </PanelBody>
    </DetailPanel>
  );
}
