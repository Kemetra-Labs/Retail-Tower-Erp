import { Banner } from "@/components/Banner";
import {
  FormErrorSummary,
  type SummaryEntry,
  useSummaryFocus,
} from "@/components/FormErrorSummary";
import { FormField } from "@/components/FormField";
import { FormAside, FormPage, FormPanel, FormSection } from "@/components/FormPage";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, type T, useT } from "@/i18n";
import { textField } from "@/lib/form-field";
import type { Rf2ErrorRender } from "@/lib/rf2-queries";
import { DEFAULT_STORE_TIMEZONE, isIanaTimezone } from "@/lib/timezones";
import { SAVED_NAVIGATION } from "@/shell/dirty-guard";
/**
 * SF-S3 — Store create/edit form (T028; RT-400 screens 16 and 17; RT-971 form
 * template, canvas «نموذج»: «بيانات المتجر» and «التوقيت» sections, the error
 * summary, and «بعد الإنشاء» beside the create form). Scoped to
 * the ACTIVE TENANT: the form has NO tenant picker — on create the active
 * tenant is shown as a read-only scope line (FR-004-005). Pre-gates on the
 * active tenant (OQ-4): no active tenant → scope prompt, the form is not
 * reachable and no call fires.
 *
 * Uncontrolled native form (R4-3); the only client-side check is the time zone.
 * Branching:
 *   - success → route to the affected store detail, re-fetch
 *   - 409 store-code conflict → inline on the code field (OQ-9)
 *   - 400 invalid_timezone → inline on the time zone field
 *   - 409 timezone_changed_concurrently / store_has_open_shift → danger banner
 *     with the request reference (RT-477)
 *   - 401 no-active-tenant → scope prompt, NOT a sign-out (OQ-4)
 *   - 403 → persistent danger banner with the request reference
 *   - 404 on update → uniform not-available; anything else → generic banner
 * Code is immutable after create (StoreUpdate has no code), so edit shows it
 * read-only. Save sends the name, plus the three time zone fields together
 * when the zone was changed and its impact reviewed (RT-477); the V1
 * `is_active` flag has its own control in StoreStatusSection, outside the form.
 *
 * Create makes the time zone required with Africa/Cairo preselected: a UI rule
 * (owner decision, Jira RT-477 comment 12083); the contract keeps it optional.
 *
 * RT-1012 (v4.0): the form, the impact review and the status section take the
 * v4 panel shapes through the `stores-v4` wrapper (`stores.css`); the order of
 * the review, the confirm and the outcome banners is unchanged.
 */
import { useIsMutating } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ScopePrompt } from "./ScopePrompt";
import { StoreStatusSection } from "./StoreStatusSection";
import { TimezoneField } from "./TimezoneField";
import { TimezoneImpact } from "./TimezoneImpact";
import { saveStore } from "./saveStore";
import { useStoreFormErrors } from "./useStoreFormErrors";
import {
  STORE_REQUEST_FAILED,
  storeStatusMutationKey,
  useRefreshStoreTimezone,
  useStoreMutations,
} from "./useStoreQueries";
import { useStoreScope } from "./useStoreScope";
import { useTimezoneChange } from "./useTimezoneChange";
import "./stores.css";

export interface StoreFormProps {
  mode: "create" | "edit";
  /** Required in edit mode. */
  storeId?: string;
  /** Backend values to prefill in edit mode. */
  initial?: { code: string; name: string; is_active?: boolean; timezone?: string };
}

/** The 403 render, matched on its catalog copy rather than inferred. */
function isForbidden(render: Rf2ErrorRender): boolean {
  return render.kind === "banner" && render.messageKey === "errors.forbidden";
}

function FormBanner({
  render,
  mode,
}: Readonly<{
  render: Rf2ErrorRender;
  mode: StoreFormProps["mode"];
}>): React.JSX.Element | null {
  const t = useT();
  if (render.kind === "scope-required" || render.kind === "conflict") return null;
  if (render.kind === "field-error") return null;
  const requestId = "requestId" in render ? render.requestId : undefined;
  if (mode === "edit" && isForbidden(render)) {
    return (
      <Banner
        variant="danger"
        title={t("stores.errors.editDeniedTitle")}
        message={t("stores.errors.editDeniedBody")}
        requestId={requestId}
      />
    );
  }
  return <Banner variant="danger" message={t(render.messageKey)} requestId={requestId} />;
}

/** «بيانات المتجر»: name and code, plus the read-only store ID on edit. */
function StoreFields({
  isEdit,
  storeId,
  initial,
  codeError,
}: Readonly<{
  isEdit: boolean;
  storeId?: string;
  initial: StoreFormProps["initial"];
  codeError?: MessageKey;
}>): React.JSX.Element {
  const t = useT();
  return (
    <FormSection title={t("stores.form.section")} columns={2}>
      <FormField id="store-name" label={t("stores.form.nameLabel")} required>
        {(aria) => (
          <input
            id="store-name"
            name="name"
            className="input"
            defaultValue={initial?.name}
            autoComplete="off"
            {...aria}
          />
        )}
      </FormField>

      <FormField
        id="store-code"
        label={t("stores.form.codeLabel")}
        required={!isEdit}
        hint={t(isEdit ? "stores.form.codeHintEdit" : "stores.form.codeHintCreate")}
        error={codeError ? t(codeError) : undefined}
      >
        {(aria) => (
          <input
            id="store-code"
            name="code"
            className="input input--mono"
            dir="ltr"
            defaultValue={initial?.code}
            readOnly={isEdit}
            autoComplete="off"
            {...aria}
          />
        )}
      </FormField>

      {isEdit ? (
        <FormField id="store-id" label={t("stores.field.id")} hint={t("stores.form.idHint")}>
          {(aria) => (
            <input
              id="store-id"
              className="input input--mono"
              dir="ltr"
              defaultValue={storeId}
              readOnly
              {...aria}
            />
          )}
        </FormField>
      ) : null}
    </FormSection>
  );
}

function FormActions({
  isEdit,
  pending,
  submitDisabled,
  onCancel,
}: Readonly<{
  isEdit: boolean;
  pending: boolean;
  submitDisabled: boolean;
  onCancel: () => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <GatedButton type="submit" className="btn-primary" busy={pending} disabled={submitDisabled}>
        {t(isEdit ? "stores.form.saveChanges" : "stores.form.create")}
      </GatedButton>
      <button type="button" className="btn-ghost" onClick={onCancel} disabled={pending}>
        {t(isEdit ? "stores.form.cancelEdit" : "common.cancel")}
      </button>
    </>
  );
}

/** «بعد الإنشاء»: where the new store is set up next. Guidance only. */
function NextSteps(): React.JSX.Element {
  const t = useT();
  return (
    <FormAside title={t("stores.form.next.title")}>
      <ol>
        <li>{t("stores.form.next.erp")}</li>
        <li>{t("stores.form.next.devices")}</li>
        <li>{t("stores.form.next.operators")}</li>
      </ol>
    </FormAside>
  );
}

/** The summary repeats the inline errors in field order: code, then time zone. */
function summaryEntries(
  t: T,
  codeError: MessageKey | undefined,
  timezoneError: MessageKey | undefined,
): SummaryEntry[] {
  const entries: SummaryEntry[] = [];
  if (codeError) entries.push({ fieldId: "store-code", message: t(codeError) });
  if (timezoneError) entries.push({ fieldId: "store-timezone", message: t(timezoneError) });
  return entries;
}

export function StoreForm({ mode, storeId, initial }: Readonly<StoreFormProps>): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const { activeTenantId, activeTenantName } = useStoreScope();
  const { create, update } = useStoreMutations(activeTenantId, storeId);
  const isEdit = mode === "edit";
  const timezone = useTimezoneChange(
    storeId,
    isEdit ? initial?.timezone : undefined,
    initial?.timezone ?? (isEdit ? "" : DEFAULT_STORE_TIMEZONE),
  );
  const refreshTimezone = useRefreshStoreTimezone(storeId);
  const errors = useStoreFormErrors(() => {
    // The store's zone moved under the user: re-read it, and ask for a fresh review.
    timezone.resetReview();
    void refreshTimezone();
  });

  const summary = useSummaryFocus();

  const pending = create.isPending || update.isPending;
  // The status toggle and the name save never run at the same time.
  const statusPending = useIsMutating({ mutationKey: storeStatusMutationKey(storeId ?? "") }) > 0;

  // Pre-gate: no active tenant -> scope prompt, the form is not reachable (OQ-4).
  if (!activeTenantId || errors.scopeLost) {
    return <ScopePrompt />;
  }

  /** Save, then go to the store; a failure is shown where it belongs and stays on the form. */
  async function save(name: string, code: string): Promise<string | undefined> {
    const outcome = await saveStore({
      mode,
      storeId,
      submit: () =>
        isEdit
          ? update.mutateAsync({ name, ...timezone.payload() })
          : create.mutateAsync({ code, name, timezone: timezone.zone }),
    });
    if ("render" in outcome) {
      errors.show(outcome.render);
      if (outcome.render.kind === "conflict" || outcome.render.kind === "field-error") {
        summary.focusSummary();
      }
      return undefined;
    }
    return outcome.to;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    errors.clear();
    // Required in the UI: the select cannot be blank, but nothing unknown is ever sent.
    if (!isEdit && !isIanaTimezone(timezone.zone)) {
      errors.setTimezoneError("stores.errors.timezoneInvalid");
      summary.focusSummary();
      return;
    }
    if (!timezone.canSave) return;
    const form = new FormData(e.currentTarget);
    try {
      const to = await save(textField(form, "name"), textField(form, "code"));
      if (to) navigate(to, { state: SAVED_NAVIGATION });
    } catch {
      // A thrown request (offline, aborted) is still a visible failure, never silent.
      errors.setBanner(STORE_REQUEST_FAILED);
    }
  }

  const title = isEdit
    ? t.rich("stores.form.editTitle", { name: <bdi>{initial?.name}</bdi> })
    : t("stores.form.createTitle");

  const detailPath = isEdit && storeId ? `/stores/${storeId}` : "/stores";
  return (
    <div className="stores-v4 stores-v4--wrap">
      <FormPage
        back={{ to: detailPath, label: t(isEdit ? "stores.form.back" : "stores.detail.back") }}
        title={title}
        // Scope is fixed to the active tenant — shown, not selectable (FR-004-005).
        subtitle={
          isEdit
            ? undefined
            : t.rich("stores.form.scopeLine", { tenant: <bdi>{activeTenantName}</bdi> })
        }
        notices={errors.banner ? <FormBanner render={errors.banner} mode={mode} /> : null}
        aside={isEdit ? null : <NextSteps />}
        after={
          isEdit && storeId ? (
            <StoreStatusSection
              storeId={storeId}
              storeName={initial?.name}
              isActive={initial?.is_active}
              disabled={pending}
              onStart={() => errors.setBanner(undefined)}
              onError={errors.show}
            />
          ) : null
        }
      >
        <FormPanel
          onSubmit={onSubmit}
          summary={
            <FormErrorSummary
              ref={summary.ref}
              entries={summaryEntries(t, errors.codeError, errors.timezoneError)}
            />
          }
          actions={
            <FormActions
              isEdit={isEdit}
              pending={pending}
              submitDisabled={statusPending || !timezone.canSave}
              onCancel={() => navigate(detailPath)}
            />
          }
        >
          <StoreFields
            isEdit={isEdit}
            storeId={storeId}
            initial={initial}
            codeError={errors.codeError}
          />

          <FormSection title={t("stores.form.timingSection")}>
            <TimezoneField
              value={timezone.zone}
              onChange={(zone) => {
                errors.setTimezoneError(undefined);
                timezone.select(zone);
              }}
              required={!isEdit}
              current={initial?.timezone}
              error={errors.timezoneError}
            />
            <TimezoneImpact change={timezone} />
          </FormSection>
        </FormPanel>
      </FormPage>
    </div>
  );
}
