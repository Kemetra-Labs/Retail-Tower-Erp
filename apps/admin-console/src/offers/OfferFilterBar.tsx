/**
 * RT-1338 offers list filter: by derived state. Archived offers leave the server's default list and
 * show under the Archived state.
 */
import { FilterBar, FilterField } from "@/components/FilterBar";
import { useT } from "@/i18n";
import type { OfferState } from "@/lib/offer-queries";
import { useRef } from "react";
import { OFFER_STATES, offerStateKey } from "./offerLogic";
import type { OfferFilters } from "./useOffers";

export function OfferFilterBar({
  onApply,
}: Readonly<{ onApply: (filters: OfferFilters) => void }>): React.JSX.Element {
  const t = useT();
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <FilterBar
      label={t("offers.filters.label")}
      formRef={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        const state = String(new FormData(e.currentTarget).get("state") ?? "");
        onApply({ state: state ? (state as OfferState) : undefined });
      }}
      onClear={() => {
        formRef.current?.reset();
        onApply({});
      }}
    >
      <FilterField id="offer-f-state" label={t("offers.filters.state")}>
        <select id="offer-f-state" name="state" className="input" defaultValue="">
          <option value="">{t("offers.filters.stateAny")}</option>
          {OFFER_STATES.map((state) => (
            <option key={state} value={state}>
              {t(offerStateKey(state))}
            </option>
          ))}
        </select>
      </FilterField>
    </FilterBar>
  );
}
