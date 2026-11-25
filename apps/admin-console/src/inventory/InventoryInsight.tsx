/**
 * Modern concept 2/6 — the product page's smart insight (rule 4): one line at
 * the top of the page saying what this balance means, computed only from the
 * `getOnHand` read the page already makes, nothing invented:
 *
 * - While the read has no answer, or a re-read has failed while the earlier
 *   answer stays on screen, it renders nothing: the band facts already drop
 *   in that case, and the on-hand panel carries the loading and error states.
 * - A negative balance renders nothing here: the on-hand panel's warning
 *   banner already carries it, and the band never carries state.
 * - Otherwise it reads only the served by-status table (`statusQuantities`):
 *   if every listed status is Sellable, all on-hand stock is sellable; if
 *   another status is listed, stock also sits there. No quantity is parsed,
 *   summed or compared — the strings stay the API's, as RT-728 requires —
 *   only which statuses the API listed.
 */
import { type MessageKey, useT } from "@/i18n";
import type { OnHand } from "@/lib/inventory-queries";
import { useId } from "react";
import type { ReadState } from "./useInventory";

type InsightKind = "allSellable" | "otherStatuses";

const INSIGHT_TEXT = {
  allSellable: "inventory.insight.allSellable",
  otherStatuses: "inventory.insight.otherStatuses",
} as const satisfies Record<InsightKind, MessageKey>;

/** What this balance means, or null while its read is not ready. */
function insightOf(onHand: ReadState<OnHand>): InsightKind | null {
  const data = onHand.data;
  if (!data || onHand.inlineError) return null;
  if (data.negativeBalance) return null;
  const rows = data.statusQuantities ?? [];
  if (rows.length === 0) return null;
  return rows.some((row) => row.inventoryStatus !== "sellable")
    ? "otherStatuses"
    : "allSellable";
}

export function InventoryInsight({
  onHand,
}: Readonly<{ onHand: ReadState<OnHand> }>): React.JSX.Element | null {
  const t = useT();
  const titleId = useId();
  const insight = insightOf(onHand);
  if (!insight) return null;
  return (
    <section className="inventory-insight" aria-labelledby={titleId}>
      <div className="inventory-insight__body">
        <h2 id={titleId} className="inventory-insight__title">
          {t("inventory.insight.title")}
        </h2>
        <p className="inventory-insight__text">{t(INSIGHT_TEXT[insight])}</p>
      </div>
    </section>
  );
}
