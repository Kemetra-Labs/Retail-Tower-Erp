import { ProductPicker } from "@/catalog/ProductPicker";
/**
 * RT-455 «تسجيل استدعاء» (`createInventoryRecall`, owner or tenant_admin): one
 * product, then 1 to 100 of its batches or serials, a reason from the fixed list
 * («أخرى» needs a note), the external reference, an optional effective time
 * (now or earlier, never later) and a note. The product comes from the shared
 * catalog picker; its identities from `listTrackingIdentities`. The recall
 * moves the listed identities' sellable and return-inspection stock into
 * «حجز استدعاء» in every store: the server does it and the screen re-reads.
 */
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import type { CatalogProduct } from "@/lib/catalog-queries";
import {
  type TrackingIdentity,
  type TrackingIdentityList,
  listTrackingIdentities,
} from "@/lib/inventory-queries";
import type { SafetyReasonCodeInput } from "@/lib/tracking-queries";
import { useState } from "react";
import { trackingKindKey } from "../inventory/inventoryLogic";
import { LoadMore, Machine, ReadError } from "../inventory/parts";
import { type InventoryScope, useInventoryPages } from "../inventory/useInventory";
import { ReasonFields, WriteResult } from "./TrackingForms";
import { DateValue } from "./parts";
import { useCreateRecall } from "./useTrackingWrites";
import {
  MAX_RECALL_IDENTITIES,
  REFERENCE_MAX_LENGTH,
  type WriteErrors,
  buildRecallCommand,
  validateRecall,
} from "./writeLogic";

function IdentityChoices({
  scope,
  productId,
  chosen,
  onToggle,
  error,
}: Readonly<{
  scope: InventoryScope;
  productId: string;
  chosen: readonly string[];
  onToggle: (id: string) => void;
  error: WriteErrors["identities"];
}>): React.JSX.Element {
  const t = useT();
  const list = useInventoryPages<TrackingIdentity, TrackingIdentityList>({
    queryKey: ["tracking", scope.tenantId, scope.activeStoreId, "recall-identities", productId],
    scope,
    fetchPage: (page) => listTrackingIdentities(productId, page),
  });
  let body: React.ReactNode;
  if (list.isLoading)
    body = <ListState state="loading" label={t("tracking.recallCreate.identitiesNoun")} />;
  else if (list.error) {
    body = (
      <ReadError
        error={list.error}
        failedKey="tracking.recallCreate.identitiesFailed"
        notFoundKey="tracking.recallCreate.identitiesFailed"
        onRetry={list.retry}
      />
    );
  } else if (list.rows.length === 0 && !list.hasMore) {
    body = <ListState state="empty" emptyMessage={t("tracking.recallCreate.identitiesEmpty")} />;
  } else {
    body = (
      <>
        <ul className="tracking__choices">
          {list.rows.map((identity) => (
            <li key={identity.id}>
              <label className="tracking__choice">
                <input
                  type="checkbox"
                  checked={chosen.includes(identity.id)}
                  onChange={() => onToggle(identity.id)}
                />
                <span className="tracking__muted">{t(trackingKindKey(identity.kind))}</span>
                <Machine value={identity.code} />
                <span className="tracking__muted">
                  {t("tracking.col.expiry")}: <DateValue value={identity.expiryDate} />
                </span>
              </label>
            </li>
          ))}
        </ul>
        <LoadMore
          hasMore={list.hasMore}
          isFetching={list.isFetchingNextPage}
          label={t("tracking.recallCreate.identitiesMore")}
          onLoadMore={list.loadMore}
        />
      </>
    );
  }
  return (
    <fieldset className="tracking__fieldset" aria-invalid={error ? true : undefined}>
      <legend>{t("tracking.recallCreate.identities")}</legend>
      <p className="tracking__muted">
        {t("tracking.recallCreate.identitiesHelp", {
          max: MAX_RECALL_IDENTITIES,
          count: chosen.length,
        })}
      </p>
      {body}
      <InlineError message={error ? t(error) : undefined} />
    </fieldset>
  );
}

export function RecallCreateDrawer({
  scope,
  onClose,
}: Readonly<{ scope: InventoryScope; onClose: () => void }>): React.JSX.Element {
  const t = useT();
  const write = useCreateRecall();
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [identityIds, setIdentityIds] = useState<string[]>([]);
  const [reason, setReason] = useState<SafetyReasonCodeInput | "">("");
  const [reference, setReference] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<WriteErrors>({});
  const recorded = write.outcome?.kind === "recorded";

  function choose(next: CatalogProduct): void {
    setProduct(next);
    setIdentityIds([]);
    write.reset();
  }

  function toggle(id: string): void {
    setIdentityIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!product) return;
    const draft = {
      productId: product.productId,
      identityIds,
      reason,
      reference,
      effectiveAt,
      note,
    };
    const found = validateRecall(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    await write.submit(buildRecallCommand(draft));
  }

  return (
    <Drawer
      title={t("tracking.recallCreate.title")}
      scope={t("tracking.recall.scope")}
      onClose={onClose}
      dismissible={!write.pending}
    >
      <div className="tracking__drawer-body" data-testid="tracking-recall-create">
        {product ? (
          <p>
            {t("tracking.col.product")}: <bdi className="tracking__name">{product.name}</bdi>{" "}
            {recorded ? null : (
              <button type="button" className="btn-ghost" onClick={() => setProduct(null)}>
                {t("tracking.recallCreate.changeProduct")}
              </button>
            )}
          </p>
        ) : (
          <>
            <p className="tracking__muted">{t("tracking.recallCreate.pickProduct")}</p>
            <ProductPicker tenantId={scope.tenantId} onSelect={choose} selectedId={null} />
          </>
        )}
        {product ? (
          <form className="surface__form" onSubmit={submit} noValidate>
            {/* Once recorded, the form is evidence of what was sent: read-only. */}
            <fieldset className="tracking__plain" disabled={recorded}>
              <IdentityChoices
                scope={scope}
                productId={product.productId}
                chosen={identityIds}
                onToggle={toggle}
                error={errors.identities}
              />
              <ReasonFields
                idPrefix="recall"
                reason={reason}
                note={note}
                errors={errors}
                onReason={setReason}
                onNote={setNote}
              />
              <div className="field">
                <label htmlFor="recall-reference">{t("tracking.col.reference")}</label>
                <input
                  id="recall-reference"
                  className="input"
                  dir="auto"
                  maxLength={REFERENCE_MAX_LENGTH}
                  value={reference}
                  aria-invalid={errors.reference ? true : undefined}
                  aria-describedby="recall-reference-help"
                  onChange={(e) => setReference(e.target.value)}
                />
                <p id="recall-reference-help" className="tracking__muted">
                  {t("tracking.recallCreate.referenceHelp")}
                </p>
                <InlineError message={errors.reference ? t(errors.reference) : undefined} />
              </div>
              <div className="field">
                <label htmlFor="recall-effective">{t("tracking.col.effectiveAt")}</label>
                <input
                  id="recall-effective"
                  type="datetime-local"
                  className="input"
                  dir="ltr"
                  value={effectiveAt}
                  aria-invalid={errors.effectiveAt ? true : undefined}
                  aria-describedby="recall-effective-help"
                  onChange={(e) => setEffectiveAt(e.target.value)}
                />
                <p id="recall-effective-help" className="tracking__muted">
                  {t("tracking.recallCreate.effectiveHelp")}
                </p>
                <InlineError message={errors.effectiveAt ? t(errors.effectiveAt) : undefined} />
              </div>
            </fieldset>
            <p className="tracking__muted">{t("tracking.recallCreate.effect")}</p>
            <WriteResult
              outcome={write.outcome}
              recorded={t("tracking.recallCreate.recorded", { count: identityIds.length })}
            />
            <div className="tracking__actions">
              {recorded ? (
                <button type="button" className="btn-secondary" onClick={onClose}>
                  {t("tracking.write.close")}
                </button>
              ) : (
                <>
                  <GatedButton type="submit" className="btn-primary" disabled={write.pending}>
                    {write.pending ? t("common.loading") : t("tracking.recallCreate.submit")}
                  </GatedButton>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={onClose}
                    disabled={write.pending}
                  >
                    {t("tracking.write.cancel")}
                  </button>
                </>
              )}
            </div>
          </form>
        ) : null}
      </div>
    </Drawer>
  );
}
