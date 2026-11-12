/**
 * RT-1338 "Validate → Preview" (spec 048 §10, §18). Shows what Backend-Core says about the SAVED
 * draft: whether it is publishable, each issue a publish would refuse for, the eligible-set count
 * and a sample (up to 20), the conflicts with other live offers (OD-7), and a simulation box ("a
 * cart of these prices → this result"). The Console computes none of it: it renders the answer.
 *
 * The preview is of one draft revision. The editor drops it the moment the form changes or the
 * revision moves, so a stale "publishable" never sits next to an edited form.
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { useT } from "@/i18n";
import { CURRENCY, formatMoney } from "@/i18n/format";
import type {
  OfferConflict,
  OfferPreview,
  OfferSimulationRequest,
  OfferSimulationResult,
} from "@/lib/offer-queries";
import { useState } from "react";
import { issueKey } from "./offerOutcomes";
import {
  EMPTY_SIM_ROW,
  MAX_SIM_LINES,
  type SimulationRow,
  type SimulationRowError,
  buildSimulation,
} from "./offerSimulationLogic";

/** Conflicts with other live offers (OD-7): who, in which state, and how many products they share. */
export function OfferConflictList({
  conflicts,
}: Readonly<{ conflicts: readonly OfferConflict[] }>): React.JSX.Element | null {
  const t = useT();
  if (conflicts.length === 0) return null;
  return (
    <section className="offer-preview__block" aria-label={t("offers.preview.conflicts")}>
      <h4 className="offer-rule__legend">{t("offers.preview.conflicts")}</h4>
      <p className="field__hint">{t("offers.preview.conflictsHint")}</p>
      <ul className="offer-preview__list">
        {conflicts.map((c) => (
          <li key={c.offerId}>
            <bdi dir="auto">{c.nameAr}</bdi> · {t(`offers.state.${c.state}`)} ·{" "}
            {t("offers.preview.sharedProducts", { count: c.sharedProductCount })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EligibleSet({ preview }: Readonly<{ preview: OfferPreview }>): React.JSX.Element {
  const t = useT();
  const { count, sample } = preview.eligibleSet;
  return (
    <section className="offer-preview__block" aria-label={t("offers.preview.eligible")}>
      <h4 className="offer-rule__legend">{t("offers.preview.eligible")}</h4>
      <p className="offer-preview__count">
        <strong>{t("offers.preview.eligibleCount", { count })}</strong>
      </p>
      {sample.length > 0 ? (
        <>
          <p className="field__hint">{t("offers.preview.sampleHint", { shown: sample.length })}</p>
          <ul className="offer-preview__list">
            {sample.map((p) => (
              <li key={p.productId}>
                <bdi dir="auto">{p.name}</bdi>
                {p.sku ? (
                  <>
                    {" "}
                    · <bdi dir="ltr">{p.sku}</bdi>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function SimulationResultView({
  result,
}: Readonly<{ result: OfferSimulationResult }>): React.JSX.Element {
  const t = useT();
  const money = (v: string) => formatMoney(v, result.currencyCode);
  return (
    <div className="offer-preview__sim-result">
      <p>
        {t("offers.sim.summary", {
          applications: result.applications,
          discount: money(result.totalDiscount),
          total: money(result.total),
        })}
      </p>
      <table className="data-table">
        <caption className="sr-only">{t("offers.sim.resultCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("offers.sim.col.line")}</th>
            <th scope="col" className="data-table__cell--num">
              {t("offers.sim.col.price")}
            </th>
            <th scope="col" className="data-table__cell--num">
              {t("offers.sim.col.quantity")}
            </th>
            <th scope="col">{t("offers.sim.col.eligible")}</th>
            <th scope="col" className="data-table__cell--num">
              {t("offers.sim.col.discount")}
            </th>
            <th scope="col" className="data-table__cell--num">
              {t("offers.sim.col.amount")}
            </th>
          </tr>
        </thead>
        <tbody>
          {result.lines.map((line) => (
            <tr key={line.lineIndex} className="data-table__row">
              <td>{line.lineIndex + 1}</td>
              <td className="data-table__cell--num">
                <bdi dir="ltr">{money(line.unitPrice)}</bdi>
              </td>
              <td className="data-table__cell--num">{line.quantity}</td>
              <td>{t(line.eligible ? "offers.sim.yes" : "offers.sim.no")}</td>
              <td className="data-table__cell--num">
                <bdi dir="ltr">{money(line.discountAmount)}</bdi>
              </td>
              <td className="data-table__cell--num">
                <bdi dir="ltr">{money(line.lineAmount)}</bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SimulationBox({
  result,
  busy,
  onRun,
}: Readonly<{
  result: OfferSimulationResult | null;
  busy: boolean;
  onRun: (request: OfferSimulationRequest) => void;
}>): React.JSX.Element {
  const t = useT();
  const [rows, setRows] = useState<SimulationRow[]>([{ ...EMPTY_SIM_ROW }]);
  const [errors, setErrors] = useState<(SimulationRowError | undefined)[]>([]);
  const [formError, setFormError] = useState<string | undefined>();

  function setRow(index: number, patch: Partial<SimulationRow>): void {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function run(): void {
    const built = buildSimulation(rows, CURRENCY);
    if (!built.ok) {
      setErrors(built.errors);
      setFormError(built.form ? t(built.form) : undefined);
      return;
    }
    setErrors([]);
    setFormError(undefined);
    onRun(built.request);
  }

  return (
    <section className="offer-preview__block" aria-label={t("offers.sim.title")}>
      <h4 className="offer-rule__legend">{t("offers.sim.title")}</h4>
      <p className="field__hint">{t("offers.sim.hint", { currency: CURRENCY })}</p>
      <ul className="offer-sim__rows">
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional cart lines with no id.
          <li key={index} className="offer-sim__row">
            <label className="offer-sim__field">
              {t("offers.sim.price", { n: index + 1 })}
              <input
                className="input"
                inputMode="decimal"
                dir="ltr"
                autoComplete="off"
                value={row.unitPrice}
                aria-invalid={errors[index]?.unitPrice ? true : undefined}
                onChange={(e) => setRow(index, { unitPrice: e.target.value })}
              />
            </label>
            <label className="offer-sim__field">
              {t("offers.sim.quantity", { n: index + 1 })}
              <input
                className="input"
                inputMode="numeric"
                dir="ltr"
                autoComplete="off"
                value={row.quantity}
                aria-invalid={errors[index]?.quantity ? true : undefined}
                onChange={(e) => setRow(index, { quantity: e.target.value })}
              />
            </label>
            {errors[index] ? (
              <p className="field__error" role="alert">
                {errors[index]?.unitPrice ? t(errors[index].unitPrice) : null}{" "}
                {errors[index]?.quantity ? t(errors[index].quantity) : null}
              </p>
            ) : null}
            <button
              type="button"
              className="btn-ghost"
              disabled={rows.length === 1}
              onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              aria-label={t("offers.sim.removeLine", { n: index + 1 })}
            >
              {t("offers.sim.remove")}
            </button>
          </li>
        ))}
      </ul>
      {formError ? (
        <p className="field__error" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="offer-preview__actions">
        <button
          type="button"
          className="btn-secondary"
          disabled={rows.length >= MAX_SIM_LINES}
          onClick={() => setRows((current) => [...current, { ...EMPTY_SIM_ROW }])}
        >
          {t("offers.sim.addLine")}
        </button>
        <GatedButton type="button" className="btn-primary" busy={busy} onClick={run}>
          {t("offers.sim.run")}
        </GatedButton>
      </div>
      {result ? <SimulationResultView result={result} /> : null}
    </section>
  );
}

export interface OfferPreviewPanelProps {
  preview: OfferPreview;
  simulating: boolean;
  onSimulate: (request: OfferSimulationRequest) => void;
}

export function OfferPreviewPanel({
  preview,
  simulating,
  onSimulate,
}: Readonly<OfferPreviewPanelProps>): React.JSX.Element {
  const t = useT();
  return (
    <div className="offer-preview">
      <Banner
        variant={preview.publishable ? "success" : "warning"}
        message={t(preview.publishable ? "offers.preview.publishable" : "offers.preview.blocked")}
      />
      {preview.issues.length > 0 ? (
        <ul className="offer-preview__list" aria-label={t("offers.preview.issues")}>
          {preview.issues.map((issue) => (
            <li key={`${issue.code}-${issue.field ?? ""}`}>{t(issueKey(issue.code))}</li>
          ))}
        </ul>
      ) : null}
      <EligibleSet preview={preview} />
      <OfferConflictList conflicts={preview.conflicts} />
      <SimulationBox result={preview.simulation} busy={simulating} onRun={onSimulate} />
    </div>
  );
}
