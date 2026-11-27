/**
 * Modern concept (Settings & Devices) — the Devices list's smart insight
 * (rule 4): one note at the top of the list saying what needs attention among
 * the devices already loaded, with no link (no single screen owns the answer:
 * the rows themselves open the device that needs doing).
 * Computed only from reads the list already makes, nothing invented:
 *
 * - An open custody exception and a passed credential expiry come from the
 *   loaded `consoleListDevices` rows themselves (`custodyExceptionShiftId`,
 *   `trustState` + `expiresAt`, the same fields the Attention column reads).
 * - Stranded sales come from the health index the list already reads
 *   (`useDeviceHealthIndex`, the same join the Unsent sales column uses).
 *
 * Priority is the most urgent thing first: custody exceptions, then stranded
 * sales, then passed expiry. Counts cover the LOADED rows only — the list is
 * keyset-paged, so the copy says "loaded" and never claims a whole-set total
 * (RT-1013: a device page serves no whole-set value). While the health read is
 * still loading and no custody exception is already known, the note renders
 * nothing: stranded sales are not yet knowable, so "clear" would be a lie.
 * For the same reason "clear" also needs known queue counts for every loaded
 * row; an unavailable or unknown queue leaves the note out.
 * While the list itself is loading, has no rows, or failed, it also renders
 * nothing: the results panel already carries the loading and error states.
 * No "healthy" is ever claimed: the quiet line says only that nothing on the
 * loaded rows needs attention (RT-287 D-Q6).
 */
import { type MessageKey, useT } from "@/i18n";
import type { DeviceSummary } from "@/lib/device-queries";
import { useId } from "react";
import { isPastExpiry } from "./deviceLogic";
import { hasStrandedSales, saleQueueStateOf } from "./saleQueueLogic";
import type { DeviceHealthIndex } from "./useDeviceHealth";
import type { DeviceListState } from "./useDevices";
import "./devices.css";

type InsightKind = "custody" | "stranded" | "pastExpiry" | "clear";

const INSIGHT_TEXT = {
  custody: "devices.insight.custody",
  stranded: "devices.insight.stranded",
  pastExpiry: "devices.insight.pastExpiry",
  clear: "devices.insight.clear",
} as const satisfies Record<InsightKind, MessageKey>;

/** The one thing that needs attention among the loaded rows, or null while its reads are not ready. */
function insightOf(
  list: DeviceListState,
  saleQueues: DeviceHealthIndex,
  now: number,
  showSystem: boolean,
): { kind: InsightKind; count?: number } | null {
  if (list.isLoading || list.error || list.rows.length === 0) return null;
  const custody = list.rows.filter((d) => d.custodyExceptionShiftId).length;
  if (custody > 0) return { kind: "custody", count: custody };
  const queueOf = (d: DeviceSummary) =>
    saleQueueStateOf(saleQueues.byId.get(d.deviceId), saleQueues.status);
  if (showSystem) {
    // Stranded sales are not knowable until the health read settles; a "clear"
    // before that would undercount.
    if (saleQueues.status === "loading") return null;
    const stranded = list.rows.filter((d) => hasStrandedSales(queueOf(d))).length;
    if (stranded > 0) return { kind: "stranded", count: stranded };
  }
  const pastExpiry = list.rows.filter(
    (d) => d.trustState === "active" && isPastExpiry(d.expiresAt, now),
  ).length;
  if (pastExpiry > 0) return { kind: "pastExpiry", count: pastExpiry };
  // "Clear" needs known queue counts for every loaded row when queues are shown.
  if (showSystem && !list.rows.every((d) => queueOf(d).kind === "counts")) return null;
  return { kind: "clear" };
}

export function DeviceInsight({
  list,
  saleQueues,
  now,
  showSystem = true,
}: Readonly<{
  list: DeviceListState;
  saleQueues: DeviceHealthIndex;
  now: number;
  showSystem?: boolean;
}>): React.JSX.Element | null {
  const t = useT();
  const titleId = useId();
  const insight = insightOf(list, saleQueues, now, showSystem);
  if (!insight) return null;
  return (
    <section className="device-insight" aria-labelledby={titleId}>
      <div className="device-insight__body">
        <h2 id={titleId} className="device-insight__title">
          {t("devices.insight.title")}
        </h2>
        <p className="device-insight__text">
          {insight.count === undefined
            ? t(INSIGHT_TEXT[insight.kind])
            : t(INSIGHT_TEXT[insight.kind], { count: insight.count })}
        </p>
      </div>
    </section>
  );
}
