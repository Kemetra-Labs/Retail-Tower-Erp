/**
 * RT-1541 (W8 P-08): the Manager Sales Ask/Explain panel (RT-1526 §5).
 *
 * A read-only, deterministic question box over the caller's own received sales. The controls
 * (stores, business dates, currency) are the ONLY source of scope; the chips and the optional
 * question only select one of the catalogue templates (T-01..T-10, T-12). The server answers with
 * a typed `answer`, `refusal` or `unavailable`, or an HTTP error; each has its own state.
 *
 * Accessibility: the result lands in a polite live region; focus stays where the person was (the
 * Ask button is never natively disabled, a busy Ask only ignores activation); the refusal reason
 * is persistent text; the answer's figures are a semantic table; RTL by logical properties.
 * Nothing is logged, and no question or figure is stored.
 */
import { BusyButton } from "@/components/BusyButton";
import { FilterField as Field } from "@/components/FilterBar";
import { type MessageKey, useT } from "@/i18n";
import { defaultRange } from "@/sales-daily/dailyLogic";
import { useId, useRef, useState } from "react";
import { OutcomeView } from "./OutcomeView";
import {
  type AskChoice,
  type AskControls,
  type ControlErrors,
  DEFAULT_CURRENCY,
  QUESTION_MAX,
  type StoreOption,
  TEMPLATE_CHIPS,
  buildExplainRequest,
  plainName,
  validateAsk,
} from "./managerSalesLogic";
import { type AskState, useManagerSalesAsk } from "./useManagerSalesAsk";
import "./manager-sales.css";

export interface ManagerSalesPanelProps {
  /** The stores the caller may pick from (already narrowed to their scope by the mount). */
  stores: readonly StoreOption[];
  /** `all` store access: an "all stores" request may send the empty list (X-3 otherwise). */
  tenantWide: boolean;
  /** owner | tenant_admin | store_manager: only picks the copy of an entitlement-denied state. */
  role: string;
}

/** The text of the polite live region: a short fact, never the figures themselves. */
function announceKey(state: AskState): MessageKey | null {
  if (state.status === "loading") return "aiManagerSales.loading";
  if (state.status !== "done") return null;
  return state.outcome.kind === "answer"
    ? "aiManagerSales.announce.answer"
    : "aiManagerSales.announce.noAnswer";
}

interface FieldsProps {
  uid: string;
  errors: ControlErrors;
}

interface ScopeProps extends FieldsProps {
  controls: AskControls;
  set: (patch: Partial<AskControls>) => void;
  stores: readonly StoreOption[];
}

function StoreFields({
  controls,
  set,
  stores,
  uid,
  errors,
}: Readonly<ScopeProps>): React.JSX.Element {
  const t = useT();
  const toggle = (id: string, on: boolean) =>
    set({
      pickedStoreIds: on
        ? [...controls.pickedStoreIds, id]
        : controls.pickedStoreIds.filter((picked) => picked !== id),
    });
  return (
    <fieldset
      className="ams-stores"
      aria-describedby={errors.stores ? `${uid}-stores-err` : undefined}
    >
      <legend className="ams-label">{t("aiManagerSales.stores.legend")}</legend>
      <label className="ams-check">
        <input
          type="checkbox"
          checked={controls.allStores}
          onChange={(e) => set({ allStores: e.target.checked })}
        />
        {t("aiManagerSales.stores.all")}
      </label>
      {controls.allStores ? null : (
        <div className="ams-stores__list">
          {stores.map((store) => (
            <label key={store.id} className="ams-check">
              <input
                type="checkbox"
                checked={controls.pickedStoreIds.includes(store.id)}
                onChange={(e) => toggle(store.id, e.target.checked)}
              />
              <bdi>{plainName(store.name ?? store.id)}</bdi>
            </label>
          ))}
        </div>
      )}
      {errors.stores ? (
        <p id={`${uid}-stores-err`} className="ams-field-error">
          {t(errors.stores)}
        </p>
      ) : null}
    </fieldset>
  );
}

function ScopeFields({
  controls,
  set,
  stores,
  uid,
  errors,
}: Readonly<ScopeProps>): React.JSX.Element {
  const t = useT();
  const msg = (key: MessageKey | undefined) => (key ? t(key) : undefined);
  return (
    <fieldset className="ams-fieldset">
      <legend className="ams-legend">{t("aiManagerSales.controls.label")}</legend>
      <StoreFields controls={controls} set={set} stores={stores} uid={uid} errors={errors} />
      <div className="ams-row">
        <Field id={`${uid}-from`} label={t("sales.filter.from")} error={msg(errors.from)}>
          <input
            id={`${uid}-from`}
            type="date"
            className="input"
            value={controls.from}
            aria-invalid={errors.from ? true : undefined}
            onChange={(e) => set({ from: e.target.value })}
          />
        </Field>
        <Field id={`${uid}-to`} label={t("sales.filter.to")} error={msg(errors.to)}>
          <input
            id={`${uid}-to`}
            type="date"
            className="input"
            value={controls.to}
            aria-invalid={errors.to ? true : undefined}
            aria-describedby={`${uid}-range-note`}
            onChange={(e) => set({ to: e.target.value })}
          />
        </Field>
        <Field
          id={`${uid}-currency`}
          label={t("aiManagerSales.currency.label")}
          error={msg(errors.currency)}
        >
          <input
            id={`${uid}-currency`}
            type="text"
            dir="ltr"
            className="input ams-currency"
            maxLength={3}
            autoComplete="off"
            value={controls.currency}
            aria-invalid={errors.currency ? true : undefined}
            onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
          />
        </Field>
      </div>
      <p id={`${uid}-range-note`} className="ams-note">
        {t("aiManagerSales.range.note")}
      </p>
    </fieldset>
  );
}

function QuestionFields({
  choice,
  setChoice,
  errors,
  uid,
  busy,
}: Readonly<
  FieldsProps & {
    choice: AskChoice | null;
    setChoice: (next: AskChoice | null) => void;
    busy: boolean;
  }
>): React.JSX.Element {
  const t = useT();
  return (
    <fieldset className="ams-fieldset">
      <legend className="ams-legend">{t("aiManagerSales.chips.legend")}</legend>
      <div className="ams-chips">
        {TEMPLATE_CHIPS.map((chip) => {
          const on = choice?.kind === "template" && choice.templateId === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              className={on ? "ams-chip ams-chip--on" : "ams-chip"}
              aria-pressed={on}
              onClick={() => setChoice(on ? null : { kind: "template", templateId: chip.id })}
            >
              {t(chip.labelKey)}
            </button>
          );
        })}
      </div>
      <Field
        id={`${uid}-question`}
        label={t("aiManagerSales.question.label")}
        error={errors.choice ? t(errors.choice) : undefined}
      >
        <input
          id={`${uid}-question`}
          type="text"
          className="input"
          maxLength={QUESTION_MAX}
          autoComplete="off"
          value={choice?.kind === "question" ? choice.question : ""}
          aria-describedby={`${uid}-question-hint`}
          aria-invalid={errors.choice ? true : undefined}
          onChange={(e) =>
            setChoice(e.target.value === "" ? null : { kind: "question", question: e.target.value })
          }
        />
        <p id={`${uid}-question-hint`} className="ams-note">
          {t("aiManagerSales.question.hint")}
        </p>
      </Field>
      <div className="ams-actions">
        <BusyButton type="submit" className="btn-primary" busy={busy}>
          {t("aiManagerSales.ask")}
        </BusyButton>
      </div>
    </fieldset>
  );
}

export function ManagerSalesPanel({
  stores,
  tenantWide,
  role,
}: Readonly<ManagerSalesPanelProps>): React.JSX.Element {
  const t = useT();
  const uid = useId();
  const initial = defaultRange(stores.map((s) => s.timezone ?? "UTC"));
  const [controls, setControls] = useState<AskControls>({
    allStores: true,
    pickedStoreIds: [],
    from: initial.from,
    to: initial.to,
    currency: DEFAULT_CURRENCY,
    locale: t.locale,
  });
  const [choice, setChoice] = useState<AskChoice | null>(null);
  const [errors, setErrors] = useState<ControlErrors>({});
  const { state, ask } = useManagerSalesAsk();
  const lastRequest = useRef<ReturnType<typeof buildExplainRequest> | null>(null);
  const set = (patch: Partial<AskControls>) => setControls((c) => ({ ...c, ...patch }));
  const busy = state.status === "loading";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const current = { ...controls, locale: t.locale };
    const found = validateAsk(current, choice, stores);
    setErrors(found);
    if (Object.keys(found).length > 0 || choice === null) return;
    const request = buildExplainRequest(current, choice, tenantWide, stores);
    lastRequest.current = request;
    ask(request);
  };
  const retry = () => {
    if (lastRequest.current) ask(lastRequest.current);
  };
  const titleId = `${uid}-title`;
  const announce = announceKey(state);

  return (
    <section className="ams" aria-labelledby={titleId}>
      <header className="ams-head">
        <h2 id={titleId} className="surface__section-title">
          {t("aiManagerSales.title")}
        </h2>
        <p className="content__sub">{t("aiManagerSales.sub")}</p>
      </header>

      <form className="ams-form" onSubmit={submit} noValidate>
        <ScopeFields controls={controls} set={set} stores={stores} uid={uid} errors={errors} />
        <QuestionFields
          choice={choice}
          setChoice={setChoice}
          errors={errors}
          uid={uid}
          busy={busy}
        />
      </form>

      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {announce ? t(announce) : ""}
      </output>

      <div className="ams-result">
        {busy ? (
          <div className="list-state list-state--loading" aria-busy="true">
            <span className="spinner" aria-hidden="true" />
            <span className="list-state__msg">{t("aiManagerSales.loading")}</span>
          </div>
        ) : null}
        {state.status === "done" ? (
          <OutcomeView outcome={state.outcome} role={role} stores={stores} onRetry={retry} />
        ) : null}
      </div>
    </section>
  );
}
