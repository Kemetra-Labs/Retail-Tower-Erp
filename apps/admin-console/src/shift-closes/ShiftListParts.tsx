import type { BandFact, BandFacts } from "@/components/ListHeaderBand";
import { Icon } from "@/components/icons/Icon";
import { type MessageKey, useT } from "@/i18n";
/**
 * RT-1015 (v4.0): the parts the Shifts list adds around its table.
 *
 * - `useBandFacts`: the band shows the list's scope and period only, never a
 *   count (the page serves none). The page echoes no scope, so each fact is the
 *   filter the server was asked to apply to the whole set: the dates (with the
 *   zone they are read in), and a minimum absolute variance the person chose
 *   (the default non-zero floor is not stated). With none of them applied the
 *   band has no facts and the subtitle names the tenant. The caller shows them
 *   only once a page has loaded, never while loading or after a refusal.
 * - `FormulaStrip`: the variance rule in words and as tokens, with the
 *   direction legend. The tokens and bars are decoration (`aria-hidden`); the
 *   sentence and the labelled formula carry the meaning.
 * - `VarianceMark`: a fixed half bar on the side of the direction, beside the
 *   amount and its word. It has no length, so it never reads as a magnitude.
 */
import { type ShiftCloseFilters, chosenMinVariance } from "./shiftCloseFilters";
import type { VarianceDirection } from "./shiftCloseLogic";

interface ZoneInfo {
  /** The IANA zone the dates are read in; undefined while the store's is unread. */
  zone: string | undefined;
}

function PeriodValue({ from, to }: Readonly<{ from: string; to: string }>): React.JSX.Element {
  const t = useT();
  if (from && to) {
    return (
      <bdi dir="ltr">
        {from} → {to}
      </bdi>
    );
  }
  const key: MessageKey = from ? "shift.band.periodFrom" : "shift.band.periodTo";
  return <>{t.rich(key, { date: <bdi dir="ltr">{from || to}</bdi> })}</>;
}

export function useBandFacts(
  filters: ShiftCloseFilters,
  { zone }: ZoneInfo,
): BandFacts | undefined {
  const t = useT();
  const facts: BandFact[] = [];
  if (filters.fromDate || filters.toDate) {
    facts.push({
      label: t("shift.band.period"),
      value: <PeriodValue from={filters.fromDate} to={filters.toDate} />,
    });
    if (zone) {
      facts.push({ label: t("shift.band.zone"), value: <bdi dir="ltr">{zone}</bdi> });
    }
  }
  const minimum = chosenMinVariance(filters);
  if (minimum) {
    facts.push({
      label: t("shift.filter.minVariance"),
      value: <bdi dir="ltr">{minimum}</bdi>,
    });
  }
  // At most three are ever pushed (period, zone, floor), as D-V9 allows.
  return facts.length > 0 ? (facts as unknown as BandFacts) : undefined;
}

export function VarianceMark({
  direction,
}: Readonly<{ direction: VarianceDirection }>): React.JSX.Element {
  return <span className={`shift-vbar shift-vbar--${direction}`} aria-hidden="true" />;
}

export function FormulaStrip(): React.JSX.Element {
  const t = useT();
  return (
    <div className="shift-formula">
      <span className="shift-formula__icon" aria-hidden="true">
        <Icon name="cash" />
      </span>
      <span className="shift-formula__body">
        <span className="shift-formula__lead">{t("shift.formula.lead")}</span>
        <span className="shift-formula__eq" role="img" aria-label={t("shift.formula.aria")}>
          <span className="shift-token shift-token--result" aria-hidden="true">
            {t("shift.list.col.variance")} <em>≠ 0</em>
          </span>
          <span className="shift-op" aria-hidden="true">
            =
          </span>
          <span className="shift-token" aria-hidden="true">
            {t("shift.list.col.counted")}
          </span>
          <span className="shift-op" aria-hidden="true">
            −
          </span>
          <span className="shift-token" aria-hidden="true">
            {t("shift.list.col.expected")}
          </span>
        </span>
      </span>
      <span className="shift-legend" aria-hidden="true">
        <span>
          <VarianceMark direction="short" />
          {t("shift.variance.short")}
        </span>
        <span>
          <VarianceMark direction="over" />
          {t("shift.variance.over")}
        </span>
      </span>
    </div>
  );
}
