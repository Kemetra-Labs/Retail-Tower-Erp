/**
 * RT-1312 shared pieces of the sale quarantine screens: the state badge (the text carries the
 * meaning, the colour only reinforces it) and the summary figure.
 */
import { Money, useT } from "@/i18n";
import { quarantineStateView } from "./quarantineLogic";

export function QuarantineStateBadge({ code }: Readonly<{ code: string }>): React.JSX.Element {
  const t = useT();
  const view = quarantineStateView(code);
  return <span className={view.badge ? `badge ${view.badge}` : "badge"}>{t(view.labelKey)}</span>;
}

/** The till's total as an exact decimal string; "not recorded" when the stored sale has none. */
export function TillTotal({
  total,
  currency,
}: Readonly<{ total: string | null; currency: string | null }>): React.JSX.Element {
  const t = useT();
  if (total === null) return <span className="muted">{t("saleQuarantine.value.notRecorded")}</span>;
  return <Money value={total} currency={currency ?? undefined} />;
}
