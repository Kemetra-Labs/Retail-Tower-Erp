/**
 * RT-1020 (v4.0, C1) the facts of the daily report's Ink band: the period, the
 * time zone(s) and the read time, each exactly as the loaded summary serves it
 * (the rows' dates come from the served `from`/`to`; the zones from the served
 * stores; `asOf` from the read). The scope is the band's subtitle.
 *
 * Not the range totals: they are per currency and may include a day still
 * running, which does not fit a one-line fact. They stay in the tables, whose
 * footer is the server's `rangeTotals`. Nothing before a summary has loaded,
 * and no zone fact when the read named no store.
 */
import type { BandFact, BandFacts } from "@/components/ListHeaderBand";
import { DateTime, useT } from "@/i18n";
import { BusinessDateRange } from "@/sales/SaleParts";
import { Zones } from "./DailyCells";
import type { ReportModel } from "./dailyLogic";

export function useDailyBandFacts(
  model: ReportModel | null,
  readStores: number,
): BandFacts | undefined {
  const t = useT();
  const first = model?.rows[0]?.date;
  const last = model?.rows.at(-1)?.date;
  if (!model || !first || !last) return undefined;
  const period: BandFact = {
    label: t("sales.band.period"),
    value: <BusinessDateRange from={first} to={last} />,
  };
  const asOf: BandFact = {
    label: t("salesDaily.band.asOf"),
    value: (
      <DateTime
        value={model.asOf}
        timeZone={model.scope === "store" ? model.zones[0] : undefined}
      />
    ),
  };
  if (model.zones.length === 0) return [period, asOf];
  const partial = model.zonesComplete
    ? ""
    : ` (${t("salesDaily.context.zonesPartial", { count: readStores })})`;
  const zonesTitle = `${model.zones.join(", ")}${partial}`;
  const zone: BandFact = {
    label: t("salesDaily.band.zone"),
    value: (
      <span className="daily-band__zones" title={zonesTitle}>
        <Zones zones={model.zones} />
        {partial}
      </span>
    ),
  };
  return [period, zone, asOf];
}
