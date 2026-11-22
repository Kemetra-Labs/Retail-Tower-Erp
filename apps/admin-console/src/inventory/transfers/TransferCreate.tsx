/**
 * RT-1515 (PR 2) «تحويل جديد»: draft a shipment Transfer (`createShipmentTransfer`,
 * owner, tenant_admin or store_manager of the source store). The source store
 * comes from the stores this caller may open; the destination is any other
 * store of the tenant. 1 to 100 lines, each a product from the shared picker
 * with its quantity (and its batch for a batch product), and an optional reason.
 *
 * The command is a Draft: nothing moves and nothing is reserved until it is
 * approved. The console owns no rules; the server's refusals are worded by
 * `error.code`. On a recorded Draft the new Transfer opens in its drawer, read
 * from the server. A retry after no answer reuses the same Idempotency-Key.
 */
import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { InlineError } from "@/components/InlineError";
import { useT } from "@/i18n";
import type { CatalogProduct } from "@/lib/catalog-queries";
import { useStoreList } from "@/stores/useStoreQueries";
import { useRef, useState } from "react";
import { RetryButton } from "../parts";
import type { InventoryScope } from "../useInventory";
import { usePickerStores } from "../usePickerStores";
import { AddProduct, LineCard } from "./TransferCreateLines";
import { SubmitRow, WriteNotice } from "./TransferWriteParts";
import {
  type CreateErrors,
  type LineDraft,
  REASON_MAX_LENGTH,
  buildCreateCommand,
  hasCreateErrors,
  validateCreate,
} from "./transferWriteLogic";
import { useLineStocks } from "./useLineStocks";
import { useCreateTransfer } from "./useTransferWrites";

const NO_ERRORS: CreateErrors = { perLine: {} };

interface StoreOption {
  id: string;
  name?: string;
}

function StoreSelect({
  id,
  label,
  value,
  options,
  error,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  options: readonly StoreOption[];
  error: string | undefined;
  disabled: boolean;
  onChange: (id: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t("transfers.create.chooseStore")}</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name ?? s.id}
          </option>
        ))}
      </select>
      <InlineError message={error} />
    </div>
  );
}

/** The destination choices: every active store of the tenant except the source. */
function useDestinations(tenantId: string | null, sourceId: string) {
  const { result, refetch } = useStoreList(tenantId);
  const rows = result?.kind === "rows" ? result.rows : [];
  return {
    options: rows
      .filter((s) => s.id !== sourceId && s.is_active !== false)
      .map((s) => ({ id: s.id, name: s.name })),
    failed: result?.kind === "error",
    retry: refetch,
  };
}

export function TransferCreateDrawer({
  scope,
  onClose,
  onCreated,
}: Readonly<{
  scope: InventoryScope;
  onClose: () => void;
  onCreated: (transferId: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const picker = usePickerStores(scope);
  const write = useCreateTransfer();
  const nextId = useRef(1);
  const [sourceChoice, setSourceChoice] = useState("");
  const [destination, setDestination] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [errors, setErrors] = useState<CreateErrors>(NO_ERRORS);
  const source = sourceChoice || (picker.stores.length === 1 ? (picker.stores[0]?.id ?? "") : "");
  const destinations = useDestinations(scope.tenantId, source);
  const stocks = useLineStocks(
    scope,
    source,
    lines.map((l) => l.productId),
  );

  // An edit makes a refusal stale, so it is cleared. "No answer" is not cleared: the
  // earlier request may still have been recorded, and that stays true until a new answer.
  const edited = () => {
    if (write.outcome?.kind !== "failed") write.reset();
  };
  const addLine = (product: CatalogProduct) => {
    edited();
    const id = nextId.current++;
    const line: LineDraft = {
      id,
      productId: product.productId,
      name: product.name,
      trackingMode: product.trackingMode,
      identityId: null,
      quantity: "",
      unit: undefined,
    };
    setLines((all) => [...all, line]);
  };
  const changeLine = (id: number, patch: Partial<LineDraft>) => {
    edited();
    setLines((all) => all.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };
  const changeSource = (id: string) => {
    edited();
    setSourceChoice(id);
    if (destination === id) setDestination("");
  };

  /**
   * What the operator chose: the Idempotency-Key follows this, never the built command.
   * The stocking unit comes from a live read, so a retry after no answer must not let
   * a changed read mint a new key and record the Draft twice.
   */
  const operatorInput = {
    sourceStoreId: source,
    destinationStoreId: destination,
    reason: reason.trim(),
    lines: lines.map((l) => ({
      productId: l.productId,
      identityId: l.identityId,
      quantity: l.quantity.trim(),
    })),
  };

  const submit = async () => {
    const draft = {
      sourceStoreId: source,
      destinationStoreId: destination,
      reason,
      lines: lines.map((l) => ({ ...l, unit: stocks.get(l.productId)?.onHand?.stockingUnit })),
    };
    const found = validateCreate(draft);
    setErrors(found);
    if (hasCreateErrors(found)) return;
    const { outcome, transfer } = await write.submit(operatorInput, () =>
      buildCreateCommand(draft),
    );
    if (outcome.kind === "recorded" && transfer) onCreated(transfer.id);
  };

  return (
    <Drawer
      title={t("transfers.create.title")}
      scope={t("transfers.create.scope")}
      onClose={onClose}
      dismissible={!write.pending}
      id="transfer-create"
    >
      {/* A div, not a form: the product picker holds a search form, and forms do not nest. */}
      <div className="surface__form transfers__create">
        <p className="inventory__note">{t("transfers.create.intro")}</p>
        {picker.failed || destinations.failed ? (
          <Banner
            variant="warning"
            message={t("inventory.stores.loadFailed")}
            action={<RetryButton onRetry={picker.failed ? picker.retry : destinations.retry} />}
          />
        ) : null}
        <fieldset className="transfers__plain" disabled={write.pending}>
          <div className="surface__form-grid">
            <StoreSelect
              id="transfer-source"
              label={t("transfers.create.source")}
              value={source}
              options={picker.stores}
              error={errors.source ? t(errors.source) : undefined}
              disabled={write.pending}
              onChange={changeSource}
            />
            <StoreSelect
              id="transfer-destination"
              label={t("transfers.create.destination")}
              value={destination}
              options={destinations.options}
              error={errors.destination ? t(errors.destination) : undefined}
              disabled={write.pending}
              onChange={(id) => {
                edited();
                setDestination(id);
              }}
            />
          </div>
        </fieldset>
        <section className="transfers__section" aria-labelledby="transfer-create-lines">
          <h3 id="transfer-create-lines" className="transfers__heading">
            {t("transfers.lines.title")}
          </h3>
          {lines.length === 0 ? (
            <p className="inventory__note">{t("transfers.create.noLines")}</p>
          ) : (
            <ul className="transfers__lines">
              {lines.map((line) => (
                <LineCard
                  key={line.id}
                  scope={scope}
                  line={line}
                  stock={stocks.get(line.productId)}
                  hasSource={Boolean(source)}
                  errors={errors.perLine[line.id]}
                  disabled={write.pending}
                  onChange={(patch) => changeLine(line.id, patch)}
                  onRemove={() => {
                    edited();
                    setLines((all) => all.filter((l) => l.id !== line.id));
                  }}
                />
              ))}
            </ul>
          )}
          <InlineError message={errors.lines ? t(errors.lines) : undefined} />
          <AddProduct
            tenantId={scope.tenantId}
            lines={lines}
            disabled={write.pending}
            onAdd={addLine}
          />
        </section>
        <div className="field">
          <label htmlFor="transfer-reason">
            {t("transfers.create.reason")}{" "}
            <span className="field__required">{t("transfers.write.optional")}</span>
          </label>
          <textarea
            id="transfer-reason"
            className="input"
            rows={2}
            dir="auto"
            value={reason}
            disabled={write.pending}
            aria-invalid={errors.reason ? true : undefined}
            onChange={(e) => {
              edited();
              setReason(e.target.value);
            }}
          />
          <p className="inventory__note">
            {t("transfers.create.reasonHelp", { max: REASON_MAX_LENGTH })}
          </p>
          <InlineError message={errors.reason ? t(errors.reason) : undefined} />
        </div>
        <p className="inventory__note">{t("transfers.create.effect")}</p>
        <WriteNotice outcome={write.outcome} />
        <SubmitRow
          label={t("transfers.create.submit")}
          sameRequest={write.holds(operatorInput)}
          pending={write.pending}
          outcome={write.outcome}
          onClose={onClose}
          onSubmit={submit}
        />
      </div>
    </Drawer>
  );
}
