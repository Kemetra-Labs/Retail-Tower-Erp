/**
 * RT-1515 (PR 2) the lines of a Transfer being drafted: one card per product
 * (and batch), each with the SOURCE store's Physical on-hand and Sellable
 * quantities labelled separately (never a bare "Stock", no Available-to-Sell),
 * the stocking unit, the batch choice for a batch product and the quantity.
 *
 * A line whose stocking unit is unknown (not read yet, the read failed, or the
 * source store has none for the product) says why, and the Transfer cannot be
 * sent. Serial products are not added (the contract refuses them, 409
 * `serial_transfer_not_supported`); an untracked product is one line.
 */
import { ProductPicker } from "@/catalog/ProductPicker";
import { InlineError } from "@/components/InlineError";
import { ListState } from "@/components/ListState";
import { type MessageKey, useT } from "@/i18n";
import type { CatalogProduct } from "@/lib/catalog-queries";
import {
  type TrackingIdentity,
  type TrackingIdentityList,
  listTrackingIdentities,
} from "@/lib/inventory-queries";
import { useState } from "react";
import { LoadMore, Machine, Quantity, ReadError, RetryButton } from "../parts";
import { type InventoryScope, useInventoryPages } from "../useInventory";
import { type LineDraft, type LineErrors, MAX_LINES, isDuplicateLine } from "./transferWriteLogic";
import type { LineStock } from "./useLineStocks";

function IdentityChoice({
  scope,
  line,
  error,
  onChoose,
}: Readonly<{
  scope: InventoryScope;
  line: LineDraft;
  error: MessageKey | undefined;
  onChoose: (identityId: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const list = useInventoryPages<TrackingIdentity, TrackingIdentityList>({
    queryKey: ["transfers", scope.tenantId, scope.activeStoreId, "identities", line.productId],
    scope,
    fetchPage: (page) => listTrackingIdentities(line.productId, page),
  });
  const batches = list.rows.filter((identity) => identity.kind === "batch");
  let body: React.ReactNode;
  if (list.isLoading) {
    body = <ListState state="loading" label={t("transfers.create.identitiesNoun")} />;
  } else if (list.error) {
    body = (
      <ReadError
        error={list.error}
        failedKey="transfers.create.identitiesFailed"
        notFoundKey="transfers.create.identitiesUnavailable"
        onRetry={list.retry}
      />
    );
  } else if (batches.length === 0 && !list.hasMore) {
    body = <ListState state="empty" emptyMessage={t("transfers.create.identitiesEmpty")} />;
  } else {
    body = (
      <>
        <ul className="transfers__choices">
          {batches.map((identity) => (
            <li key={identity.id}>
              <label className="transfers__choice">
                <input
                  type="radio"
                  name={`transfer-identity-${line.id}`}
                  checked={line.identityId === identity.id}
                  onChange={() => onChoose(identity.id)}
                />
                <Machine value={identity.code} />
              </label>
            </li>
          ))}
        </ul>
        <LoadMore
          hasMore={list.hasMore}
          isFetching={list.isFetchingNextPage}
          label={t("transfers.create.identitiesMore")}
          onLoadMore={list.loadMore}
        />
      </>
    );
  }
  return (
    <fieldset className="transfers__fieldset" aria-invalid={error ? true : undefined}>
      <legend>{t("transfers.create.identity")}</legend>
      {body}
      <InlineError message={error ? t(error) : undefined} />
    </fieldset>
  );
}

/** The source store's figures for the line, or why its unit is unknown. */
function StockFigures({
  stock,
  hasSource,
}: Readonly<{ stock: LineStock | undefined; hasSource: boolean }>): React.JSX.Element {
  const t = useT();
  if (!hasSource) return <p className="inventory__note">{t("transfers.create.stock.noSource")}</p>;
  if (!stock || stock.state === "loading") {
    return <p className="inventory__note">{t("transfers.create.stock.loading")}</p>;
  }
  if (stock.state === "failed" || !stock.onHand) {
    return (
      <div className="transfers__stock-failed">
        <p className="inventory__note">{t("transfers.create.stock.failed")}</p>
        <RetryButton onRetry={stock.retry} />
      </div>
    );
  }
  const { quantity, sellableQuantity, stockingUnit } = stock.onHand;
  return (
    <dl className="transfers__figures">
      <div>
        <dt>{t("transfers.create.stock.physical")}</dt>
        <dd>
          <Quantity value={quantity} />
        </dd>
      </div>
      <div>
        <dt>{t("transfers.create.stock.sellable")}</dt>
        <dd>
          <Quantity value={sellableQuantity} />
        </dd>
      </div>
      <div>
        <dt>{t("transfers.lines.col.unit")}</dt>
        <dd>
          {stockingUnit?.trim() ? (
            <Machine value={stockingUnit} />
          ) : (
            <span className="inventory__unknown">{t("transfers.create.stock.noUnit")}</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

export function LineCard({
  scope,
  line,
  stock,
  hasSource,
  errors,
  disabled,
  onChange,
  onRemove,
}: Readonly<{
  scope: InventoryScope;
  line: LineDraft;
  stock: LineStock | undefined;
  hasSource: boolean;
  errors: LineErrors | undefined;
  disabled: boolean;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
}>): React.JSX.Element {
  const t = useT();
  const quantityId = `transfer-line-${line.id}-quantity`;
  return (
    <li className="transfers__line" data-testid="transfer-create-line">
      <fieldset className="transfers__plain" disabled={disabled}>
        <div className="transfers__line-head">
          <bdi dir="auto" className="transfers__name">
            {line.name}
          </bdi>
          <button
            type="button"
            className="btn-ghost"
            aria-label={t("transfers.create.removeLine", { name: line.name })}
            onClick={onRemove}
          >
            {t("transfers.create.remove")}
          </button>
        </div>
        <StockFigures stock={stock} hasSource={hasSource} />
        <InlineError message={errors?.unit ? t(errors.unit) : undefined} />
        {line.trackingMode === "batch" ? (
          <IdentityChoice
            scope={scope}
            line={line}
            error={errors?.identity}
            onChoose={(identityId) => onChange({ identityId })}
          />
        ) : null}
        <div className="field">
          <label htmlFor={quantityId}>
            {t("transfers.create.quantity")}
            {line.unit?.trim() ? (
              <>
                {" "}
                (<Machine value={line.unit.trim()} />)
              </>
            ) : null}
          </label>
          <input
            id={quantityId}
            className="input input--mono"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={line.quantity}
            aria-invalid={errors?.quantity ? true : undefined}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
          <InlineError message={errors?.quantity ? t(errors.quantity) : undefined} />
        </div>
        <InlineError message={errors?.duplicate ? t(errors.duplicate) : undefined} />
      </fieldset>
    </li>
  );
}

type AddRefusal = Extract<
  MessageKey,
  | "transfers.create.add.serial"
  | "transfers.create.add.duplicate"
  | "transfers.create.add.tooMany"
  | "transfers.create.add.unknownMode"
>;

/** Why a product cannot be added as a line, or undefined when it can. */
function addRefusal(
  product: Pick<CatalogProduct, "productId" | "trackingMode">,
  lines: readonly LineDraft[],
): AddRefusal | undefined {
  if (product.trackingMode === "serial") return "transfers.create.add.serial";
  if (product.trackingMode !== "none" && product.trackingMode !== "batch") {
    return "transfers.create.add.unknownMode";
  }
  if (lines.length >= MAX_LINES) return "transfers.create.add.tooMany";
  const untrackedTwice =
    product.trackingMode === "none" &&
    isDuplicateLine(lines, { productId: product.productId, identityId: null });
  return untrackedTwice ? "transfers.create.add.duplicate" : undefined;
}

export function AddProduct({
  tenantId,
  lines,
  disabled,
  onAdd,
}: Readonly<{
  tenantId: string | null;
  lines: readonly LineDraft[];
  disabled: boolean;
  onAdd: (product: CatalogProduct) => void;
}>): React.JSX.Element {
  const t = useT();
  const [refusal, setRefusal] = useState<AddRefusal | undefined>();
  const choose = (product: CatalogProduct) => {
    const found = addRefusal(product, lines);
    setRefusal(found);
    if (!found) onAdd(product);
  };
  return (
    <fieldset className="transfers__plain" disabled={disabled}>
      <legend className="transfers__heading">{t("transfers.create.addProduct")}</legend>
      <p className="inventory__note">{t("transfers.create.addProductHelp")}</p>
      <ProductPicker tenantId={tenantId} onSelect={choose} selectedId={null} />
      <InlineError message={refusal ? t(refusal) : undefined} />
    </fieldset>
  );
}
