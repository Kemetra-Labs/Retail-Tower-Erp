/**
 * RT-769 add an identifier (CAT-C2b, RT-752 AC 3 "Identifier drawer form", D6).
 * A drawer over the item's detail, one write: `consoleAddProductIdentifier`.
 *
 * Fields, in order: type; scope (tenant-wide or one store of the caller's
 * scope; hidden for `external_pos_id`); source system (only, and required, for
 * `external_pos_id`); then the value, last, so a scanner's trailing Enter
 * submits a form whose other choices are already made.
 *
 * The value is a machine code: LTR, isolated, monospace, no spellcheck, no
 * autocorrect or autocapitalize. It is sent BYTE FOR BYTE: never trimmed, case
 * folded or digit-converted. What the contract would reject is named inline
 * and the value is left as typed. Arabic-Indic digits in a barcode or PLU are a
 * non-blocking warning (D6).
 *
 * Errors: no summary in a drawer (D7). A blocked submit shows the inline error
 * and moves focus to the first field in error. 409 `alias_conflict` is an error
 * on the value that never names the other item (FR-042); it stays until the
 * key is changed. Every other failure is a banner at the top of the drawer;
 * 409 `product_retired` also locks the form, and the page reads the item again
 * when the drawer closes.
 */
import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { useT } from "@/i18n";
import type { CatalogIdentifierKey, CatalogIdentifierType } from "@/lib/catalog-queries";
import { useEffect, useState } from "react";
import { Field } from "./ProductFormFields";
import { identifierTypeKey } from "./catalogDetailLogic";
import {
  EMPTY_IDENTIFIER_FORM,
  IDENTIFIER_TYPES,
  type IdentifierField,
  type IdentifierFieldErrors,
  type IdentifierFormValues,
  type IdentifierWriteRender,
  TENANT_WIDE,
  digitWarning,
  firstErrorField,
  hasScope,
  identifierKeyOf,
  needsSourceSystem,
  sameKey,
  validateIdentifierForm,
} from "./identifierFormLogic";
import { type ScopeStoreOption, useAddIdentifier } from "./useIdentifierWrites";

export const IDENTIFIER_FIELD_IDS = {
  identifierType: "identifier-type",
  storeId: "identifier-scope",
  sourceSystem: "identifier-source",
  value: "identifier-value",
} as const;

export interface IdentifierAddProps {
  productId: string;
  tenantId: string;
  /** The stores in the caller's scope; empty offers only the tenant-wide scope. */
  stores: readonly ScopeStoreOption[];
  onClose: () => void;
  /** The identifier is bound; the page already holds the detail after the change. */
  onAdded: () => void;
  /** The item changed under the drawer (retired): the page reads it again on close. */
  onStale: () => void;
}

type BannerRender = Exclude<IdentifierWriteRender, { kind: "field" }>;

function FailureBanner({ render }: Readonly<{ render: BannerRender }>): React.JSX.Element {
  const t = useT();
  if (render.kind === "banner") {
    return (
      <Banner
        variant={render.variant}
        message={t(render.messageKey)}
        requestId={render.requestId}
      />
    );
  }
  return (
    <Banner
      variant="danger"
      message={t(
        render.kind === "retired"
          ? "catalog.identifier.error.retired"
          : "catalog.identifier.error.notFound",
      )}
      requestId={render.requestId}
    />
  );
}

export function IdentifierAdd({
  productId,
  tenantId,
  stores,
  onClose,
  onAdded,
  onStale,
}: Readonly<IdentifierAddProps>): React.JSX.Element {
  const t = useT();
  const add = useAddIdentifier(tenantId, productId);
  const [values, setValues] = useState<IdentifierFormValues>(EMPTY_IDENTIFIER_FORM);
  const [submitted, setSubmitted] = useState(false);
  // The exact key the server refused as taken: the error stands until the key changes.
  const [taken, setTaken] = useState<CatalogIdentifierKey | null>(null);
  const [failure, setFailure] = useState<BannerRender | undefined>();
  const [locked, setLocked] = useState(false);
  // Focus moves once the error it points at is rendered (aria-describedby included).
  const [focusRequest, setFocusRequest] = useState<{ field: IdentifierField; n: number }>();

  useEffect(() => {
    if (focusRequest) document.getElementById(IDENTIFIER_FIELD_IDS[focusRequest.field])?.focus();
  }, [focusRequest]);

  const key = identifierKeyOf(values);
  const errors: IdentifierFieldErrors = {
    ...(submitted ? validateIdentifierForm(values) : {}),
  };
  if (!errors.value && taken && sameKey(taken, key)) {
    errors.value = "catalog.identifier.error.aliasConflict";
  }
  const warning = digitWarning(values);
  const pending = add.isPending;

  function change<K extends keyof IdentifierFormValues>(
    field: K,
    value: IdentifierFormValues[K],
  ): void {
    setValues((v) => ({ ...v, [field]: value }));
  }

  function focusField(field: IdentifierField): void {
    setFocusRequest((r) => ({ field, n: (r?.n ?? 0) + 1 }));
  }

  async function send(body: CatalogIdentifierKey): Promise<void> {
    try {
      const result = await add.mutateAsync(body);
      if (result.ok) {
        onAdded();
        return;
      }
      const { render } = result;
      if (render.kind === "field") {
        setTaken(body);
        focusField("value");
        return;
      }
      if (render.kind === "retired") {
        setLocked(true);
        onStale();
      }
      setFailure(render);
    } catch {
      // A thrown request (offline, aborted) is still a visible failure, never silent.
      setFailure({ kind: "banner", variant: "danger", messageKey: "catalog.write.error.server" });
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (pending || locked) return;
    setFailure(undefined);
    setSubmitted(true);
    const blocked = firstErrorField(validateIdentifierForm(values));
    if (blocked) {
      focusField(blocked);
      return;
    }
    if (taken && sameKey(taken, key)) {
      // Sending the same key again would only be refused again.
      focusField("value");
      return;
    }
    void send(key);
  }

  const type = values.identifierType;
  return (
    <Drawer title={t("catalog.identifier.add.title")} onClose={onClose} dismissible={!pending}>
      {failure ? <FailureBanner render={failure} /> : null}
      <form className="surface__form" onSubmit={onSubmit} noValidate>
        <fieldset className="catalog-form__fields" disabled={locked}>
          <Field
            id={IDENTIFIER_FIELD_IDS.identifierType}
            label={t("catalog.identifier.field.type")}
          >
            {(aria) => (
              <select
                id={IDENTIFIER_FIELD_IDS.identifierType}
                className="input"
                value={type}
                onChange={(e) => change("identifierType", e.target.value as CatalogIdentifierType)}
                {...aria}
              >
                {IDENTIFIER_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {t(identifierTypeKey(option))}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {hasScope(type) ? (
            <Field
              id={IDENTIFIER_FIELD_IDS.storeId}
              label={t("catalog.identifier.field.scope")}
              hint={t("catalog.identifier.field.scopeHint")}
            >
              {(aria) => (
                <select
                  id={IDENTIFIER_FIELD_IDS.storeId}
                  className="input"
                  value={values.storeId}
                  onChange={(e) => change("storeId", e.target.value)}
                  {...aria}
                >
                  <option value={TENANT_WIDE}>{t("catalog.detail.identifiers.scopeAll")}</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name ?? store.id}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}

          {needsSourceSystem(type) ? (
            <Field
              id={IDENTIFIER_FIELD_IDS.sourceSystem}
              label={t("catalog.identifier.field.source")}
              required
              hint={t("catalog.identifier.field.sourceHint")}
              error={errors.sourceSystem}
            >
              {(aria) => (
                <input
                  id={IDENTIFIER_FIELD_IDS.sourceSystem}
                  className="input input--mono"
                  dir="ltr"
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  value={values.sourceSystem}
                  onChange={(e) => change("sourceSystem", e.target.value)}
                  {...aria}
                />
              )}
            </Field>
          ) : null}

          <Field
            id={IDENTIFIER_FIELD_IDS.value}
            label={t("catalog.identifier.field.value")}
            required
            hint={t("catalog.identifier.field.valueHint")}
            warning={warning ? t(warning) : null}
            error={errors.value}
          >
            {(aria) => (
              <input
                id={IDENTIFIER_FIELD_IDS.value}
                className="input input--mono catalog-identifier__value"
                dir="ltr"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                value={values.value}
                onChange={(e) => change("value", e.target.value)}
                {...aria}
              />
            )}
          </Field>
        </fieldset>
        <div className="surface__actions">
          <GatedButton type="submit" className="btn-primary" disabled={pending || locked}>
            {pending ? <span className="spinner" aria-hidden="true" /> : null}
            {t("catalog.identifier.add.submit")}
          </GatedButton>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
