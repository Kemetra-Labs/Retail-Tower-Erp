/**
 * RT-770 store-override drawer (CAT-C2c, RT-752 AC 3 and D8). Sets or clears one
 * store's deviation from the tenant for this item: availability as a tri-state
 * («يتبع المؤسسة» sends `null`, available, not available) and, for owner and
 * tenant_admin only, the tax category (O-4). It never changes the store's
 * price (O-2) and never computes what the store resolves: after a write the
 * page shows the raw deviation the server answered with.
 *
 * A drawer form (D7): an inline error on the field and focus on it, no error
 * summary. `expectedUpdatedAt` is the override's `updatedAt` as read, or `null`
 * when the store had none. A 409 `stale_write` keeps what was chosen and offers
 * Reload; a 422 `override_empty` explains and offers to remove the store
 * deviation (retire); a retire refused with 409 `price_override_present` says
 * the store price is kept. Retire is not offered to a `store_manager` on an
 * override that has a tax category (it would be 403 `tax_override_forbidden`).
 */
import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, useT } from "@/i18n";
import type { CatalogProductDetail, CatalogStoreOverride } from "@/lib/catalog-queries";
import { useEffect, useRef, useState } from "react";
import { tenantAvailable } from "./catalogDetailLogic";
import { availabilityKey } from "./catalogLogic";
import {
  AVAILABILITY_CHOICES,
  type OverrideFormValues,
  type OverrideWriteOp,
  type OverrideWriteRender,
  availabilityChoiceKey,
  buildOverrideBody,
  canOverrideTax,
  canRetireOverride,
  expectedUpdatedAtOf,
  mergeOverrideReload,
  overrideOf,
  overrideTaxError,
  overrideValuesOf,
} from "./storeOverrideLogic";
import { useRetireStoreOverride, useUpsertStoreOverride } from "./useStoreOverrideWrites";
import "../components/confirm-delete.css";
import "../components/inline-error.css";

export type OverrideOutcome = "saved" | "removed";

export interface StoreOverrideDrawerProps {
  product: CatalogProductDetail;
  storeId: string;
  /** The store's name, or its id when the name is not known. */
  storeName: string;
  role: string | null;
  tenantId: string;
  /** Read the item again; `undefined` when it could not be read. */
  reload: () => Promise<CatalogProductDetail | undefined>;
  onClose: () => void;
  /** The write succeeded: the page says so and closes the drawer. */
  onDone: (outcome: OverrideOutcome) => void;
}

const TAX_ID = "override-tax-category";

type Notice =
  | { kind: "render"; op: OverrideWriteOp; render: OverrideWriteRender }
  | { kind: "info"; messageKey: MessageKey };

const SERVER_FAILURE: OverrideWriteRender = {
  kind: "banner",
  variant: "danger",
  messageKey: "catalog.write.error.server",
};

function FailureBanner({
  op,
  render,
  onReload,
  reloading,
  onRemove,
}: Readonly<{
  op: OverrideWriteOp;
  render: OverrideWriteRender;
  onReload: () => void;
  reloading: boolean;
  /** Offered on `override_empty` when the store's deviation can be removed. */
  onRemove: (() => void) | null;
}>): React.JSX.Element {
  const t = useT();
  switch (render.kind) {
    case "banner":
      return (
        <Banner
          variant={render.variant}
          message={t(render.messageKey)}
          requestId={render.requestId}
        />
      );
    case "retired":
      return (
        <Banner
          variant="danger"
          message={t("catalog.override.error.retired")}
          requestId={render.requestId}
        />
      );
    case "empty":
      return (
        <Banner
          variant="warning"
          message={t("catalog.override.error.empty")}
          requestId={render.requestId}
          action={
            onRemove ? (
              <button type="button" className="btn-secondary" onClick={onRemove}>
                {t("catalog.override.error.emptyAction")}
              </button>
            ) : undefined
          }
        />
      );
    case "stale":
      return (
        <Banner
          variant="warning"
          message={t(
            op === "retire" ? "catalog.override.error.staleRetire" : "catalog.override.error.stale",
          )}
          requestId={render.requestId}
          action={
            <button type="button" className="btn-secondary" onClick={onReload} disabled={reloading}>
              {t("catalog.edit.reload")}
            </button>
          }
        />
      );
  }
}

function AvailabilityChoices({
  values,
  tenantValue,
  onChange,
}: Readonly<{
  values: OverrideFormValues;
  tenantValue: boolean;
  onChange: (choice: OverrideFormValues["availability"]) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <fieldset className="catalog-override__choices" aria-describedby="override-availability-hint">
      <legend>{t("catalog.override.availability.legend")}</legend>
      {AVAILABILITY_CHOICES.map((choice) => (
        <label key={choice} className="drawer__radio">
          <input
            type="radio"
            name="override-availability"
            value={choice}
            checked={values.availability === choice}
            onChange={() => onChange(choice)}
          />
          <span>{t(availabilityChoiceKey(choice))}</span>
        </label>
      ))}
      <p id="override-availability-hint" className="field__hint">
        {t("catalog.override.availability.tenantHint", {
          value: t(availabilityKey(tenantValue)),
        })}
      </p>
    </fieldset>
  );
}

function TaxField({
  values,
  tenantTax,
  error,
  inputRef,
  onChange,
}: Readonly<{
  values: OverrideFormValues;
  tenantTax: string;
  error: MessageKey | undefined;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const describedBy = error ? `${TAX_ID}-hint ${TAX_ID}-error` : `${TAX_ID}-hint`;
  return (
    <div className="field">
      <label htmlFor={TAX_ID}>{t("catalog.override.taxCategory")}</label>
      <input
        ref={inputRef}
        id={TAX_ID}
        className="input input--mono"
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        value={values.taxCategory}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      <p id={`${TAX_ID}-hint`} className="field__hint">
        {t.rich("catalog.override.taxCategoryHint", {
          tax: (
            <bdi dir="ltr" className="catalog-code">
              {tenantTax}
            </bdi>
          ),
        })}
      </p>
      {error ? (
        <span id={`${TAX_ID}-error`} className="rtc-inline-error">
          {t(error)}
        </span>
      ) : null}
    </div>
  );
}

function RetireOverride({
  storeName,
  confirming,
  pending,
  locked,
  onStart,
  onCancel,
  onConfirm,
  startRef,
}: Readonly<{
  storeName: string;
  confirming: boolean;
  pending: boolean;
  locked: boolean;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  startRef: React.RefObject<HTMLButtonElement | null>;
}>): React.JSX.Element {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The safe choice has focus when the confirmation opens.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);
  const store = <bdi dir="auto">{storeName}</bdi>;
  return (
    <section className="drawer__danger-section" aria-labelledby="override-retire-title">
      <h3 id="override-retire-title" className="drawer__danger-title">
        {t("catalog.override.retire.title")}
      </h3>
      <p className="catalog-detail__note">{t.rich("catalog.override.retire.sub", { store })}</p>
      {confirming ? (
        <section className="confirm-delete" aria-label={t("catalog.override.retire.confirmLabel")}>
          <p className="confirm-delete__msg">
            {t.rich("catalog.override.retire.prompt", { store: <strong>{store}</strong> })}
          </p>
          <div className="confirm-delete__actions">
            <GatedButton
              type="button"
              className="btn-destructive"
              onClick={onConfirm}
              disabled={pending}
            >
              {pending ? <span className="spinner" aria-hidden="true" /> : null}
              {t("catalog.override.retire.confirm")}
            </GatedButton>
            <button
              ref={cancelRef}
              type="button"
              className="btn-secondary"
              onClick={onCancel}
              disabled={pending}
            >
              {t("common.cancel")}
            </button>
          </div>
        </section>
      ) : (
        <button
          ref={startRef}
          type="button"
          className="btn-danger-quiet"
          onClick={onStart}
          disabled={locked}
        >
          {t("catalog.override.retire.start")}
        </button>
      )}
    </section>
  );
}

export function StoreOverrideDrawer({
  product,
  storeId,
  storeName,
  role,
  tenantId,
  reload,
  onClose,
  onDone,
}: Readonly<StoreOverrideDrawerProps>): React.JSX.Element {
  const t = useT();
  const productId = product.summary.productId;
  const upsert = useUpsertStoreOverride(tenantId, productId);
  const retire = useRetireStoreOverride(tenantId, productId);
  // The override as last read: the base of the change and its precondition.
  const [seen, setSeen] = useState<CatalogStoreOverride | null>(() =>
    overrideOf(product.storeOverrides, storeId),
  );
  const base = overrideValuesOf(seen);
  const [values, setValues] = useState<OverrideFormValues>(base);
  const [taxError, setTaxError] = useState<MessageKey | undefined>();
  const [notice, setNotice] = useState<Notice | undefined>();
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  // The item turned out to be retired: its store values are read-only from now on.
  const [locked, setLocked] = useState(product.summary.status === "retired");
  const [confirming, setConfirming] = useState(false);
  const [returnFocus, setReturnFocus] = useState(0);
  const taxRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (returnFocus > 0) startRef.current?.focus();
  }, [returnFocus]);

  const taxEditable = canOverrideTax(role);
  const retirable = canRetireOverride(role, seen);
  const pending = upsert.isPending || retire.isPending;

  function change(next: Partial<OverrideFormValues>): void {
    const merged = { ...values, ...next };
    setValues(merged);
    // An error already shown clears as soon as the value is fixed.
    if (taxError) setTaxError(overrideTaxError(merged));
  }

  async function onReload(): Promise<void> {
    setReloading(true);
    try {
      const fresh = await reload();
      setReloadFailed(!fresh);
      if (!fresh) return;
      const freshSeen = overrideOf(fresh.storeOverrides, storeId);
      setValues((typed) => mergeOverrideReload(base, typed, overrideValuesOf(freshSeen)));
      setSeen(freshSeen);
      setConfirming(false);
      if (fresh.summary.status === "retired") {
        setLocked(true);
        setNotice({ kind: "render", op: "upsert", render: { kind: "retired" } });
      } else {
        setNotice({ kind: "info", messageKey: "catalog.override.reloaded" });
      }
    } finally {
      setReloading(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending || locked) return;
    setNotice(undefined);
    setReloadFailed(false);
    const error = taxEditable ? overrideTaxError(values) : undefined;
    setTaxError(error);
    if (error) {
      taxRef.current?.focus();
      return;
    }
    const body = buildOverrideBody(base, values, expectedUpdatedAtOf(seen), taxEditable);
    if (!body) {
      setNotice({ kind: "info", messageKey: "catalog.edit.noChanges" });
      return;
    }
    try {
      const result = await upsert.mutateAsync({ storeId, body });
      if (result.ok) {
        onDone("saved");
        return;
      }
      setNotice({ kind: "render", op: "upsert", render: result.render });
      if (result.render.kind === "retired") {
        setLocked(true);
        await reload();
      }
    } catch {
      // A thrown request (offline, aborted) is still a visible failure, never silent.
      setNotice({ kind: "render", op: "upsert", render: SERVER_FAILURE });
    }
  }

  async function onConfirmRetire(): Promise<void> {
    if (seen === null || retire.isPending) return;
    setNotice(undefined);
    setReloadFailed(false);
    try {
      const result = await retire.mutateAsync({ storeId, expectedUpdatedAt: seen.updatedAt });
      if (result.ok) {
        onDone("removed");
        return;
      }
      setNotice({ kind: "render", op: "retire", render: result.render });
    } catch {
      setNotice({ kind: "render", op: "retire", render: SERVER_FAILURE });
    }
    setConfirming(false);
    setReturnFocus((n) => n + 1);
  }

  function cancelRetire(): void {
    setConfirming(false);
    setReturnFocus((n) => n + 1);
  }

  const store = <bdi dir="auto">{storeName}</bdi>;
  return (
    <Drawer
      title={t("catalog.override.drawer.title", { store: storeName })}
      onClose={onClose}
      dismissible={!pending}
    >
      <p className="surface__scope-line">{t.rich("catalog.override.drawer.sub", { store })}</p>
      {notice?.kind === "render" ? (
        <FailureBanner
          op={notice.op}
          render={notice.render}
          onReload={() => void onReload()}
          reloading={reloading}
          onRemove={retirable && !locked ? () => setConfirming(true) : null}
        />
      ) : null}
      {reloadFailed ? <Banner variant="info" message={t("catalog.detail.loadFailed")} /> : null}
      {notice?.kind === "info" ? <Banner variant="info" message={t(notice.messageKey)} /> : null}

      <form className="surface__form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <fieldset className="catalog-form__fields" disabled={locked || pending}>
          <AvailabilityChoices
            values={values}
            tenantValue={tenantAvailable(product.summary)}
            onChange={(availability) => change({ availability })}
          />
          {taxEditable ? (
            <TaxField
              values={values}
              tenantTax={product.summary.taxCategory}
              error={taxError}
              inputRef={taxRef}
              onChange={(taxCategory) => change({ taxCategory })}
            />
          ) : null}
          {!taxEditable && seen?.taxCategory ? (
            <p className="catalog-detail__note">
              {t.rich("catalog.override.taxReadOnly", {
                tax: (
                  <bdi dir="ltr" className="catalog-code">
                    {seen.taxCategory}
                  </bdi>
                ),
              })}
            </p>
          ) : null}
          {seen?.price ? (
            <p className="catalog-detail__note">{t("catalog.override.priceKept")}</p>
          ) : null}
        </fieldset>
        <div className="surface__actions">
          <GatedButton type="submit" className="btn-primary" disabled={pending || locked}>
            {upsert.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            {t("catalog.override.save")}
          </GatedButton>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </button>
        </div>
      </form>

      {seen !== null && retirable ? (
        <RetireOverride
          storeName={storeName}
          confirming={confirming}
          pending={retire.isPending}
          locked={locked}
          onStart={() => {
            setNotice(undefined);
            setConfirming(true);
          }}
          onCancel={cancelRetire}
          onConfirm={() => void onConfirmRetire()}
          startRef={startRef}
        />
      ) : null}
    </Drawer>
  );
}
