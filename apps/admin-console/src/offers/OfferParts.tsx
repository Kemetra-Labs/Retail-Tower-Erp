/**
 * RT-1338: small read-only pieces shared by the offers list and the facts panel. Status is data, not
 * decoration (UX-10.29): the badge always carries its text. Store-local times are shown as written
 * and never converted; an offer scoped to stores names those the roster knows and counts the rest.
 */
import { useT } from "@/i18n";
import type { OfferSchedule, OfferStoreScope } from "@/lib/offer-queries";
import { offerStateBadgeClass, offerStateKey, scheduleText } from "./offerLogic";

export function OfferStateBadge({ state }: Readonly<{ state: string }>): React.JSX.Element {
  const t = useT();
  return <span className={offerStateBadgeClass(state)}>{t(offerStateKey(state))}</span>;
}

export function ScheduleText({
  schedule,
}: Readonly<{ schedule: OfferSchedule }>): React.JSX.Element {
  const t = useT();
  const text = scheduleText(schedule);
  return (
    <>
      <bdi dir="ltr">{text.start}</bdi>
      {" → "}
      {text.end ? <bdi dir="ltr">{text.end}</bdi> : t("offers.schedule.open")}
      {text.storeLocal ? ` (${t("offers.schedule.storeLocal")})` : null}
    </>
  );
}

export function ScopeText({
  scope,
  roster,
}: Readonly<{
  scope: OfferStoreScope;
  roster: readonly { id: string; name?: string }[];
}>): React.JSX.Element {
  const t = useT();
  if ("allStores" in scope) return <>{t("offers.scope.all")}</>;
  const names: string[] = [];
  let unnamed = 0;
  for (const id of scope.storeIds) {
    const name = roster.find((s) => s.id === id)?.name;
    if (name) names.push(name);
    else unnamed += 1;
  }
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 ? "، " : null}
          <bdi dir="auto">{name}</bdi>
        </span>
      ))}
      {unnamed > 0 ? (
        <span>
          {names.length > 0 ? "، " : null}
          {t("offers.scope.unnamed", { count: unnamed })}
        </span>
      ) : null}
    </>
  );
}
