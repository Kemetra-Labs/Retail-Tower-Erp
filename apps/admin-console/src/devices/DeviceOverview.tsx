/**
 * RT-371 device detail, Overview tab: identity, store, label, trust state,
 * credential expiry and last seen with its source. Read-only. There is no
 * health field: last seen is activity, and the tab says so (RT-287 D-Q6).
 * RT-961: the ledger sits in a section panel; the tab names it, so the panel
 * has no title of its own.
 */
import { DetailGrid, DetailPanel, LedgerField, PanelBody } from "@/components/DetailPanel";
import { DateTime, useT } from "@/i18n";
import type { DeviceDetail } from "@/lib/device-queries";
import { LastSeen } from "./DeviceParts";
import { isPastExpiry } from "./deviceLogic";
import "../shell/surface.css";
import "./devices.css";

export const Field = LedgerField;

export interface DeviceViewProps {
  device: DeviceDetail;
  storeName?: string;
  timeZone?: string;
  now: number;
}

function Expiry({ device, timeZone, now }: Readonly<DeviceViewProps>): React.JSX.Element {
  const t = useT();
  const passed = device.trustState === "active" && isPastExpiry(device.expiresAt, now);
  return (
    <span className="device-name">
      <DateTime value={device.expiresAt} timeZone={timeZone} />
      {passed ? (
        <span className="device-flag device-flag--warning">
          {t("devices.attention.pastExpiry")}
        </span>
      ) : null}
      <small className="device-quiet">{t("devices.field.expiryNote")}</small>
    </span>
  );
}

export function DeviceOverview(props: Readonly<DeviceViewProps>): React.JSX.Element {
  const t = useT();
  const { device, storeName, timeZone } = props;
  return (
    <DetailGrid>
      <DetailPanel>
        <PanelBody>
          <dl className="surface__detail">
            <Field label={t("devices.field.deviceId")} mono>
              <bdi dir="ltr">{device.deviceId}</bdi>
            </Field>
            <Field label={t("devices.field.label")}>
              {device.label ? (
                <bdi dir="auto">{device.label}</bdi>
              ) : (
                <span className="device-quiet">{t("devices.list.unlabelled")}</span>
              )}
            </Field>
            <Field label={t("devices.field.store")}>
              {storeName ?? t("devices.list.unknownStore")}
            </Field>
            <Field label={t("devices.field.pairedAt")}>
              <DateTime value={device.createdAt} timeZone={timeZone} />
            </Field>
            <Field label={t("devices.field.expiresAt")}>
              <Expiry {...props} />
            </Field>
            <Field label={t("devices.field.lastSeen")}>
              <LastSeen
                lastSeenAt={device.lastSeenAt}
                lastSeenSource={device.lastSeenSource}
                timeZone={timeZone}
                showSource
              />
            </Field>
          </dl>
          <p className="content__sub">{t("devices.lastSeen.notHealth")}</p>
        </PanelBody>
      </DetailPanel>
    </DetailGrid>
  );
}
