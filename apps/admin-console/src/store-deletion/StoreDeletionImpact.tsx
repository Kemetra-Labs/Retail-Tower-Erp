/**
 * RT-1441 (U2): what the store-deletion dialog shows of the server's impact preview: the facts, the
 * terminals with their unsent-sale counters, what changes and what does not, the caveats, and the
 * blockers each linked to the screen that clears it. Every verdict, blocker and effect is the
 * server's; this renders it and picks copy (the server's words never show).
 */
import { ImpactFootnotes, ImpactList } from "@/components/ImpactList";
import { TrustBadge } from "@/devices/DeviceParts";
import { DateTime, useT } from "@/i18n";
import { formatNumber } from "@/i18n/translate";
import type { StoreDeletionPreview } from "@/lib/store-deletion-queries";
import { StoreStateBadge } from "@/stores/StoreStateBadge";
import { Link } from "react-router";
import {
  type BlockerEntry,
  type BlockerLink,
  blockerRows,
  caveatKeys,
  effectKeys,
  hasUnknownEffect,
} from "./storeDeletionLogic";

type Device = StoreDeletionPreview["devices"][number];

function Fact({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="store-deletion__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Num({ value }: Readonly<{ value: number }>): React.JSX.Element {
  return <bdi dir="ltr">{formatNumber(value)}</bdi>;
}

function Facts({ data }: Readonly<{ data: StoreDeletionPreview }>): React.JSX.Element {
  const t = useT();
  return (
    <dl className="store-deletion__facts">
      <Fact label={t("storeDeletion.fact.store")}>
        <bdi dir="auto">{data.store.name}</bdi>
      </Fact>
      <Fact label={t("storeDeletion.fact.code")}>
        <bdi dir="ltr">{data.store.code}</bdi>
      </Fact>
      <Fact label={t("storeDeletion.fact.state")}>
        <StoreStateBadge isActive={data.store.isActive} />
      </Fact>
      <Fact label={t("storeDeletion.fact.openShifts")}>
        <Num value={data.openShifts.length} />
      </Fact>
      <Fact label={t("storeDeletion.fact.devices")}>
        <Num value={data.devices.length} />
      </Fact>
      <Fact label={t("storeDeletion.fact.openCounts")}>
        <Num value={data.openCountSessions.length} />
      </Fact>
      <Fact label={t("storeDeletion.fact.warehouses")}>
        <Num value={data.warehouseMappings.length} />
      </Fact>
      <Fact label={t("storeDeletion.fact.members")}>
        <Num value={data.singleStoreMembers.length} />
      </Fact>
      <Fact label={t("storeDeletion.fact.offers")}>
        <Num value={data.offersRebuiltCount} />
      </Fact>
    </dl>
  );
}

/** The till's unsent sales, or "unknown": a till that never reported is not zero. */
function Queue({ queue }: Readonly<Pick<Device, "queue">>): React.JSX.Element {
  const t = useT();
  if (queue === null) return <>{t("storeDeletion.device.queueUnknown")}</>;
  return (
    <>
      {t("storeDeletion.device.queue", {
        pending: formatNumber(queue.pending),
        deadLetter: formatNumber(queue.deadLetter),
        held: formatNumber(queue.held),
      })}
    </>
  );
}

function DeviceRow({
  device,
  timeZone,
}: Readonly<{ device: Device; timeZone?: string }>): React.JSX.Element {
  const t = useT();
  return (
    <li className="store-deletion__device">
      <span className="store-deletion__device-name">
        {device.label ? <bdi dir="auto">{device.label}</bdi> : t("storeDeletion.device.noLabel")}{" "}
        <TrustBadge trustState={device.trustState} />
      </span>
      <span className="device-quiet">
        {device.lastSeenAt === null
          ? t("storeDeletion.device.neverSeen")
          : t.rich("storeDeletion.device.lastSeen", {
              time: (
                <bdi dir="ltr">
                  <DateTime value={device.lastSeenAt} timeZone={timeZone} />
                </bdi>
              ),
            })}
      </span>
      <span className="device-quiet">
        <Queue queue={device.queue} />
      </span>
    </li>
  );
}

function Devices({
  devices,
  timeZone,
}: Readonly<{ devices: readonly Device[]; timeZone?: string }>): React.JSX.Element | null {
  const t = useT();
  if (devices.length === 0) return null;
  return (
    <section className="store-deletion__effects">
      <h3>{t("storeDeletion.devices.heading")}</h3>
      <ul className="store-deletion__devices">
        {devices.map((d) => (
          <DeviceRow key={d.deviceId} device={d} timeZone={timeZone} />
        ))}
      </ul>
    </section>
  );
}

/** The server's effect codes as the shared list's props: the keys it has copy for, and a line for the rest. */
function effectProps(list: "willChange" | "willNotChange", codes: readonly string[]) {
  return {
    keys: effectKeys(list, codes),
    unknownKey: hasUnknownEffect(list, codes)
      ? ("storeDeletion.effect.unknown" as const)
      : undefined,
  };
}

/** What the preview says: the impact of deleting, as a snapshot. */
export function DeletionImpact({
  data,
  timeZone,
}: Readonly<{ data: StoreDeletionPreview; timeZone?: string }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <Facts data={data} />
      <Devices devices={data.devices} timeZone={timeZone} />
      <ImpactList
        className="store-deletion__effects"
        heading={t("storeDeletion.heading.willChange")}
        {...effectProps("willChange", data.effects.willChange)}
      />
      <ImpactList
        className="store-deletion__effects"
        heading={t("storeDeletion.heading.willNotChange")}
        {...effectProps("willNotChange", data.effects.willNotChange)}
      />
      <ImpactFootnotes
        caveats={caveatKeys(data.caveats)}
        snapshotKey="storeDeletion.snapshot"
        evaluatedAt={data.evaluatedAt}
        timeZone={timeZone}
      />
    </>
  );
}

function FixLink({ link }: Readonly<{ link: BlockerLink }>): React.JSX.Element {
  const t = useT();
  switch (link.kind) {
    case "shifts":
      return (
        <Link to={link.to} className="store-panel-link">
          {t("forceActions.storeLink")}
        </Link>
      );
    case "device":
      return (
        <Link to={link.to} className="store-panel-link">
          {t("storeDeletion.link.device", {
            label: link.label ?? t("storeDeletion.device.noLabel"),
          })}
        </Link>
      );
    case "count":
      return (
        <Link to={link.to} className="store-panel-link">
          {t("storeDeletion.link.countSession", { index: formatNumber(link.index) })}
        </Link>
      );
  }
}

/** Why the store cannot be deleted now, as persistent text, each reason with the link to its fix (UX-11.11). */
export function DeletionBlockers({
  blockers,
  preview,
  storeId,
}: Readonly<{
  blockers: readonly BlockerEntry[];
  preview: StoreDeletionPreview | undefined;
  storeId: string;
}>): React.JSX.Element {
  const t = useT();
  return (
    <section className="store-deletion__blocked" aria-label={t("storeDeletion.blockedIntro")}>
      <p className="store-deletion__blocked-intro">{t("storeDeletion.blockedIntro")}</p>
      <ul className="store-deletion__blockers">
        {blockerRows(blockers, preview, storeId).map((row) => (
          <li key={row.code}>
            <p>{t(row.messageKey, { count: row.count })}</p>
            {row.links.length > 0 ? (
              <ul className="store-deletion__fixes">
                {row.links.map((link) => (
                  <li key={link.to}>
                    <FixLink link={link} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
