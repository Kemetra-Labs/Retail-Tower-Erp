/**
 * RT-1074 stock-level drawer: sets or removes ONE level of a product, either
 * the tenant default or one store's deviation (RT-1064 TH-3: a store level
 * replaces the tenant level as a pair, both values together).
 *
 * - Values are exact decimal strings (TH-2): typed into text fields, checked
 *   digit by digit, sent as typed (ends trimmed, Arabic digits written as
 *   0-9), never parsed to a number or rounded. `critical <= reorder` is checked
 *   here and by the server; its 422 `critical_above_reorder` lands on the
 *   critical field.
 * - Concurrency (TH-4): every write sends `expectedUpdatedAt`, the level's
 *   `updatedAt` as read or `null` when there was none. On 409 `stale_write`
 *   the drawer reads the levels again at once and says so: a field the person
 *   changed keeps what they typed, the others take the fresh value, and the
 *   next save carries the fresh precondition. Nothing is overwritten.
 * - Idempotency (TH-4): each set intent gets a fresh `Idempotency-Key`; only a
 *   retry of the same intent (same target, same body, after an answer that may
 *   not have been final) reuses it.
 * - Remove asks first (Cancel has focus). A 404 on remove means the level was
 *   already gone: the levels are read again and the page says so.
 *
 * A drawer form (D7): an inline error on the field and focus on it.
 */
import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, useT } from "@/i18n";
import type { ProductStockLevels } from "@/lib/stock-level-queries";
import { useEffect, useRef, useState } from "react";
import {
  type KeyedIntent,
  type LevelFormErrors,
  type LevelFormValues,
  type LevelTarget,
  type LevelWriteOp,
  type LevelWriteRender,
  buildSetBody,
  expectedUpdatedAtOf,
  hasErrors,
  intentFingerprint,
  isUnchanged,
  keepsKey,
  keyForIntent,
  levelOf,
  levelValuesOf,
  mergeLevelReload,
  validateLevelForm,
} from "./stockLevelLogic";
import { useRetireStockLevel, useSetStockLevel } from "./useStockLevels";
import "../components/confirm-delete.css";
import "../components/inline-error.css";

export type LevelOutcome = "saved" | "removed" | "gone";

export interface StockLevelDrawerProps {
  levels: ProductStockLevels;
  target: LevelTarget;
  /** The store's name (or id) for a store level; unused for the tenant level. */
  storeName: string;
  tenantId: string;
  /** The active store of the scope: part of the read's cache key. */
  activeStoreId: string | null;
  /** Read the levels again; `undefined` when the read failed. */
  reload: () => Promise<ProductStockLevels | undefined>;
  onClose: () => void;
  /** The write is over: the page says so and closes the drawer. */
  onDone: (outcome: LevelOutcome) => void;
}

const REORDER_ID = "stock-level-reorder";
const CRITICAL_ID = "stock-level-critical";

type Notice =
  | { kind: "render"; op: LevelWriteOp; render: LevelWriteRender }
  | { kind: "info"; messageKey: MessageKey };

const SERVER_FAILURE: LevelWriteRender = {
  kind: "banner",
  variant: "danger",
  messageKey: "catalog.write.error.server",
};

function FailureBanner({
  op,
  render,
}: Readonly<{ op: LevelWriteOp; render: LevelWriteRender }>): React.JSX.Element | null {
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
          message={t("catalog.stockLevels.error.retired")}
          requestId={render.requestId}
        />
      );
    case "stale":
      return (
        <Banner
          variant="warning"
          message={t(
            op === "retire"
              ? "catalog.stockLevels.error.staleRetire"
              : "catalog.stockLevels.error.stale",
          )}
          requestId={render.requestId}
        />
      );
    case "in-progress":
      return <Banner variant="warning" message={t("catalog.stockLevels.error.inProgress")} />;
    // Shown elsewhere: on the critical field, or by the page after a reload.
    case "critical":
    case "gone":
      return null;
  }
}

function LevelField({
  id,
  label,
  hint,
  value,
  error,
  inputRef,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  hint: string;
  value: string;
  error: MessageKey | undefined;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const describedBy = error ? `${id}-hint ${id}-error` : `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        className="input input--mono"
        dir="ltr"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      <p id={`${id}-hint`} className="field__hint">
        {hint}
      </p>
      {error ? (
        <span id={`${id}-error`} className="rtc-inline-error">
          {t(error)}
        </span>
      ) : null}
    </div>
  );
}

function RetireLevel({
  target,
  storeName,
  confirming,
  pending,
  locked,
  onStart,
  onCancel,
  onConfirm,
  startRef,
}: Readonly<{
  target: LevelTarget;
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
  const isTenant = target.kind === "tenant";
  return (
    <section className="drawer__danger-section" aria-labelledby="stock-level-retire-title">
      <h3 id="stock-level-retire-title" className="drawer__danger-title">
        {t("catalog.stockLevels.retire.title")}
      </h3>
      <p className="catalog-detail__note">
        {isTenant
          ? t("catalog.stockLevels.retire.tenantSub")
          : t.rich("catalog.stockLevels.retire.storeSub", { store })}
      </p>
      {confirming ? (
        <section
          className="confirm-delete"
          aria-label={t("catalog.stockLevels.retire.confirmLabel")}
        >
          <p className="confirm-delete__msg">
            {isTenant
              ? t("catalog.stockLevels.retire.tenantPrompt")
              : t.rich("catalog.stockLevels.retire.storePrompt", {
                  store: <strong>{store}</strong>,
                })}
          </p>
          <div className="confirm-delete__actions">
            <GatedButton
              type="button"
              className="btn-destructive"
              onClick={onConfirm}
              busy={pending}
            >
              {t("catalog.stockLevels.retire.confirm")}
            </GatedButton>
            <button
              ref={cancelRef}
              type="button"
              className="btn-ghost"
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
          {t("catalog.stockLevels.retire.start")}
        </button>
      )}
    </section>
  );
}

export function StockLevelDrawer({
  levels,
  target,
  storeName,
  tenantId,
  activeStoreId,
  reload,
  onClose,
  onDone,
}: Readonly<StockLevelDrawerProps>): React.JSX.Element {
  const t = useT();
  const productId = levels.productId;
  const setLevel = useSetStockLevel(tenantId, activeStoreId, productId);
  const retire = useRetireStockLevel(tenantId, activeStoreId, productId);
  // The level as last read: the base of the change and its precondition.
  const [seen, setSeen] = useState(() => levelOf(levels, target));
  const base = levelValuesOf(seen);
  const [values, setValues] = useState<LevelFormValues>(base);
  const [errors, setErrors] = useState<LevelFormErrors>({});
  const [notice, setNotice] = useState<Notice | undefined>();
  const [reloadFailed, setReloadFailed] = useState(false);
  // The item turned out to be retired: its levels are read-only from now on.
  const [locked, setLocked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [returnFocus, setReturnFocus] = useState(0);
  // The set intent in flight or last attempted, with its Idempotency-Key.
  const intentRef = useRef<KeyedIntent | undefined>(undefined);
  const reorderRef = useRef<HTMLInputElement>(null);
  const criticalRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (returnFocus > 0) startRef.current?.focus();
  }, [returnFocus]);
  // A server answer that belongs to a field moves focus there once the form is
  // enabled again (it is disabled while the request is pending).
  const [focusCritical, setFocusCritical] = useState(0);
  useEffect(() => {
    if (focusCritical > 0) criticalRef.current?.focus();
  }, [focusCritical]);

  const pending = setLevel.isPending || retire.isPending;
  const store = <bdi dir="auto">{storeName}</bdi>;

  function change(next: Partial<LevelFormValues>): void {
    const merged = { ...values, ...next };
    setValues(merged);
    // An error already shown clears as soon as the value is fixed.
    if (hasErrors(errors)) setErrors(validateLevelForm(merged));
  }

  /** After a stale write: read again, keep what was typed, take the fresh precondition. */
  async function reloadAfterStale(op: LevelWriteOp, requestId: string | undefined): Promise<void> {
    const fresh = await reload();
    setNotice({ kind: "render", op, render: { kind: "stale", requestId } });
    setReloadFailed(!fresh);
    if (!fresh) return;
    const freshSeen = levelOf(fresh, target);
    const freshBase = levelValuesOf(freshSeen);
    setValues((typed) => (op === "retire" ? freshBase : mergeLevelReload(base, typed, freshBase)));
    setSeen(freshSeen);
    setErrors({});
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending || locked) return;
    setNotice(undefined);
    setReloadFailed(false);
    const found = validateLevelForm(values);
    setErrors(found);
    if (found.reorder) {
      reorderRef.current?.focus();
      return;
    }
    if (found.critical) {
      criticalRef.current?.focus();
      return;
    }
    const body = buildSetBody(values, expectedUpdatedAtOf(seen));
    if (isUnchanged(seen, body)) {
      setNotice({ kind: "info", messageKey: "catalog.edit.noChanges" });
      return;
    }
    const intent = keyForIntent(intentRef.current, intentFingerprint(target, body));
    intentRef.current = intent;
    try {
      const result = await setLevel.mutateAsync({ target, body, idempotencyKey: intent.key });
      if (result.ok) {
        intentRef.current = undefined;
        onDone("saved");
        return;
      }
      if (!keepsKey(result.status)) intentRef.current = undefined;
      const { render } = result;
      if (render.kind === "critical") {
        setErrors({ critical: "catalog.stockLevels.error.criticalAboveReorder" });
        setFocusCritical((n) => n + 1);
        return;
      }
      if (render.kind === "stale") {
        await reloadAfterStale("set", render.requestId);
        return;
      }
      setNotice({ kind: "render", op: "set", render });
      if (render.kind === "retired") setLocked(true);
    } catch {
      // A request that never completed may still have been written: keep the
      // key, so saving again is a retry of this same intent. Never silent.
      setNotice({ kind: "render", op: "set", render: SERVER_FAILURE });
    }
  }

  async function onConfirmRetire(): Promise<void> {
    if (seen === null || retire.isPending) return;
    setNotice(undefined);
    setReloadFailed(false);
    try {
      const result = await retire.mutateAsync({ target, expectedUpdatedAt: seen.updatedAt });
      if (result.ok) {
        onDone("removed");
        return;
      }
      if (result.render.kind === "gone") {
        await reload();
        onDone("gone");
        return;
      }
      if (result.render.kind === "stale") {
        await reloadAfterStale("retire", result.render.requestId);
      } else {
        setNotice({ kind: "render", op: "retire", render: result.render });
      }
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

  const isTenant = target.kind === "tenant";
  return (
    <Drawer
      title={
        isTenant
          ? t("catalog.stockLevels.drawer.tenantTitle")
          : t("catalog.stockLevels.drawer.storeTitle", { store: storeName })
      }
      onClose={onClose}
      dismissible={!pending}
    >
      <p className="surface__scope-line">
        {isTenant
          ? t("catalog.stockLevels.drawer.tenantSub")
          : t.rich("catalog.stockLevels.drawer.storeSub", { store })}
      </p>
      {notice?.kind === "render" ? <FailureBanner op={notice.op} render={notice.render} /> : null}
      {reloadFailed ? (
        <Banner variant="info" message={t("catalog.stockLevels.error.reloadFailed")} />
      ) : null}
      {notice?.kind === "info" ? <Banner variant="info" message={t(notice.messageKey)} /> : null}

      <form className="surface__form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <fieldset className="catalog-form__fields" disabled={locked || pending}>
          <LevelField
            id={REORDER_ID}
            label={t("catalog.stockLevels.field.reorder")}
            hint={t("catalog.stockLevels.field.reorderHint")}
            value={values.reorder}
            error={errors.reorder}
            inputRef={reorderRef}
            onChange={(reorder) => change({ reorder })}
          />
          <LevelField
            id={CRITICAL_ID}
            label={t("catalog.stockLevels.field.critical")}
            hint={t("catalog.stockLevels.field.criticalHint")}
            value={values.critical}
            error={errors.critical}
            inputRef={criticalRef}
            onChange={(critical) => change({ critical })}
          />
        </fieldset>
        <div className="surface__actions">
          <GatedButton
            type="submit"
            className="btn-primary"
            busy={setLevel.isPending}
            disabled={retire.isPending || locked}
          >
            {t("catalog.stockLevels.save")}
          </GatedButton>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </button>
        </div>
      </form>

      {seen !== null && !locked ? (
        <RetireLevel
          target={target}
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
