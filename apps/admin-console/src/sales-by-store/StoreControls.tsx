/**
 * RT-1054 the report's controls: quick ranges, the previous-period switch and
 * the ranking currency. The exact dates stay in the shared range form below
 * (`DailyRangeForm`, which checks the contract's 31-day rule before anything is
 * read). Every control writes the URL, which is the report's state.
 */
import { useT } from "@/i18n";
import {
  PRESET_IDS,
  type PresetId,
  type ReportParams,
  activePreset,
  presetRange,
} from "./storeLogic";

const PRESET_KEY = {
  last7: "salesByStore.preset.last7",
  last10: "salesByStore.preset.last10",
  month: "salesByStore.preset.month",
} as const;

export function StoreControls({
  params,
  today,
  currencies,
  onChange,
}: Readonly<{
  params: ReportParams;
  /** The scope's business today; null until the store zones are known. */
  today: string | null;
  currencies: readonly string[];
  onChange: (next: ReportParams) => void;
}>): React.JSX.Element {
  const t = useT();
  const active = today ? activePreset(params, today) : null;
  const pick = (id: PresetId) => {
    if (today) onChange({ ...params, ...presetRange(id, today) });
  };
  return (
    <section className="section-panel sbs-controls" aria-label={t("salesByStore.controls.label")}>
      <fieldset className="sbs-presets">
        <legend className="sr-only">{t("salesByStore.preset.label")}</legend>
        {PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={id === active ? "sbs-preset sbs-preset--on" : "sbs-preset"}
            aria-pressed={id === active}
            disabled={today === null}
            onClick={() => pick(id)}
          >
            {t(PRESET_KEY[id])}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        role="switch"
        className={
          params.compare === "previous_period" ? "sbs-switch sbs-switch--on" : "sbs-switch"
        }
        aria-checked={params.compare === "previous_period"}
        onClick={() =>
          onChange({
            ...params,
            compare: params.compare === "previous_period" ? "none" : "previous_period",
          })
        }
      >
        <span className="sbs-switch__track" aria-hidden="true" />
        {t("salesByStore.compare.label")}
      </button>
      <label className="sbs-currency" htmlFor="sbs-currency">
        {t("salesByStore.currency.label")}
        <select
          id="sbs-currency"
          className="input"
          value={params.currency}
          onChange={(e) => onChange({ ...params, currency: e.target.value })}
        >
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
