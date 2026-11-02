/**
 * RT-1074 «حدود المخزون» section of the catalog product detail: the product's
 * low-stock thresholds through `consoleGetProductStockLevels`, and the editor
 * for the four writes of `catalog/stock-levels.yaml` (RT-1064 TH-1 to TH-5).
 *
 * - The tenant level (the default) and the store levels of the caller's scope,
 *   each value shown exactly as the server holds it (an exact decimal string,
 *   never reformatted or rounded). A store level replaces the tenant level for
 *   that store as a pair (TH-3).
 * - Controls follow the role (TH-4): `owner` / `tenant_admin` set or remove the
 *   tenant level; they and `store_manager` set or remove the level of a store
 *   in scope (every listed store is in scope; the active store can get one).
 *   Nothing is offered on a retired item. The API stays the authority.
 * - Thresholds are Retail Tower data owned by Backend-Core: nothing here reads
 *   or writes ERPNext (TH-1).
 */
import { useStoreLabels } from "@/catalog/useCatalogProduct";
import { Banner } from "@/components/Banner";
import { DetailPanel, LedgerField, PanelBody } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import type { StoreStockLevel, TenantStockLevel } from "@/lib/stock-level-queries";
import { useState } from "react";
import { type LevelOutcome, StockLevelDrawer } from "./StockLevelDrawer";
import {
  type LevelTarget,
  canReadStockLevels,
  canWriteStoreLevel,
  canWriteTenantLevel,
} from "./stockLevelLogic";
import { type StockLevelsState, useStockLevels } from "./useStockLevels";

export interface ProductStockLevelsProps {
  productId: string;
  /** A retired item shows its levels with no control. */
  retired: boolean;
  tenantId: string | null;
  role: string | null;
  activeStoreId: string | null;
  activeStoreName: string | null;
  /** The section's position on the page («04»). */
  index?: number;
}

const SECTION_ID = "catalog-detail-stock-levels";

function nameOf(label: { id: string; name: string | null }): string {
  return label.name ?? label.id;
}

/** A level (an exact decimal string) or a store id: LTR-isolated, exactly as stored. */
function LtrValue({ value }: Readonly<{ value: string }>): React.JSX.Element {
  return (
    <bdi dir="ltr" className="catalog-code">
      {value}
    </bdi>
  );
}

function LevelRows({
  level,
}: Readonly<{ level: TenantStockLevel | StoreStockLevel }>): React.JSX.Element {
  const t = useT();
  return (
    <dl className="surface__detail">
      <LedgerField label={t("catalog.stockLevels.field.reorder")}>
        <LtrValue value={level.reorderLevel} />
      </LedgerField>
      <LedgerField label={t("catalog.stockLevels.field.critical")}>
        {level.criticalLevel === null ? (
          t("catalog.stockLevels.value.noCritical")
        ) : (
          <LtrValue value={level.criticalLevel} />
        )}
      </LedgerField>
    </dl>
  );
}

type Done = { outcome: LevelOutcome; target: LevelTarget; store: string };

function doneMessage(t: ReturnType<typeof useT>, done: Done): string {
  if (done.outcome === "gone") return t("catalog.stockLevels.gone");
  if (done.target.kind === "tenant") {
    return t(
      done.outcome === "saved"
        ? "catalog.stockLevels.tenantSaved"
        : "catalog.stockLevels.tenantRemoved",
    );
  }
  return t(
    done.outcome === "saved"
      ? "catalog.stockLevels.storeSaved"
      : "catalog.stockLevels.storeRemoved",
    { store: done.store },
  );
}

function ReadFailure({ state }: Readonly<{ state: StockLevelsState }>): React.JSX.Element {
  const t = useT();
  const error = state.error;
  if (error?.kind === "not-found") {
    return <p className="catalog-detail__empty">{t("catalog.stockLevels.unavailable")}</p>;
  }
  if (error?.kind === "session") {
    return (
      <Banner
        variant="danger"
        message={t("catalog.write.error.session")}
        requestId={error.requestId}
      />
    );
  }
  return (
    <Banner
      variant={error?.kind === "rate-limited" ? "warning" : "danger"}
      message={t(
        error?.kind === "rate-limited"
          ? "catalog.write.error.rateLimited"
          : "catalog.stockLevels.loadFailed",
      )}
      requestId={error?.requestId}
      action={
        <GatedButton type="button" className="btn-secondary" onClick={state.retry}>
          {t("catalog.stockLevels.retry")}
        </GatedButton>
      }
    />
  );
}

export function ProductStockLevels({
  productId,
  retired,
  tenantId,
  role,
  activeStoreId,
  activeStoreName,
  index,
}: Readonly<ProductStockLevelsProps>): React.JSX.Element | null {
  const t = useT();
  const readable = canReadStockLevels(role) && tenantId !== null;
  const state = useStockLevels(tenantId, activeStoreId, productId, readable);
  // Names come from the stores read the page already shares; while it loads, the id is shown.
  const storeLabel = useStoreLabels(
    tenantId,
    { id: activeStoreId, name: activeStoreName },
    (state.levels?.storeLevels.length ?? 0) > 0,
  );
  const [editing, setEditing] = useState<LevelTarget | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  if (!readable) return null;

  const writable = !retired && tenantId !== null;
  const tenantWritable = writable && canWriteTenantLevel(role);
  const storeWritable = writable && canWriteStoreLevel(role);
  const levels = state.levels;

  function open(target: LevelTarget): void {
    setDone(null);
    setEditing(target);
  }

  const labelOf = (target: LevelTarget): string =>
    target.kind === "store" ? nameOf(storeLabel(target.storeId)) : "";

  let body: React.ReactNode;
  if (state.isLoading) {
    body = <ListState state="loading" label={t("catalog.stockLevels.loadingNoun")} />;
  } else if (!levels) {
    body = state.error ? <ReadFailure state={state} /> : null;
  } else {
    const activeHasLevel = levels.storeLevels.some((s) => s.storeId === activeStoreId);
    body = (
      <>
        {done ? <Banner variant="success" message={doneMessage(t, done)} /> : null}
        {retired ? (
          <p className="catalog-detail__note">{t("catalog.stockLevels.retiredNote")}</p>
        ) : null}

        <div className="catalog-detail__store">
          <div className="catalog-detail__store-head">
            <h3 className="catalog-detail__store-name">
              {t("catalog.stockLevels.tenant.heading")}
            </h3>
            {tenantWritable ? (
              <div className="catalog-detail__store-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  aria-haspopup="dialog"
                  onClick={() => open({ kind: "tenant" })}
                >
                  {t(
                    levels.tenantLevel
                      ? "catalog.stockLevels.action.changeTenant"
                      : "catalog.stockLevels.action.setTenant",
                  )}
                </button>
              </div>
            ) : null}
          </div>
          {levels.tenantLevel ? (
            <LevelRows level={levels.tenantLevel} />
          ) : (
            <p className="catalog-detail__empty">{t("catalog.stockLevels.tenant.none")}</p>
          )}
        </div>

        <h3 className="catalog-detail__store-name">{t("catalog.stockLevels.stores.heading")}</h3>
        {levels.storeLevels.length === 0 ? (
          <p className="catalog-detail__empty">{t("catalog.stockLevels.stores.empty")}</p>
        ) : (
          levels.storeLevels.map((level) => {
            const name = nameOf(storeLabel(level.storeId));
            return (
              <div key={level.storeId} className="catalog-detail__store">
                <div className="catalog-detail__store-head">
                  <h4 className="catalog-detail__store-name">
                    {storeLabel(level.storeId).name ? (
                      <bdi dir="auto">{name}</bdi>
                    ) : (
                      <LtrValue value={name} />
                    )}
                  </h4>
                  {storeWritable ? (
                    <div className="catalog-detail__store-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        aria-haspopup="dialog"
                        onClick={() => open({ kind: "store", storeId: level.storeId })}
                      >
                        {t("catalog.stockLevels.action.changeStore", { store: name })}
                      </button>
                    </div>
                  ) : null}
                </div>
                <LevelRows level={level} />
              </div>
            );
          })
        )}
        {storeWritable && activeStoreId && !activeHasLevel ? (
          <div className="surface__actions catalog-retire__actions">
            <button
              type="button"
              className="btn-secondary"
              aria-haspopup="dialog"
              onClick={() => open({ kind: "store", storeId: activeStoreId })}
            >
              {t("catalog.stockLevels.action.setStore", {
                store: nameOf(storeLabel(activeStoreId)),
              })}
            </button>
          </div>
        ) : null}
        {storeWritable && !activeStoreId ? (
          <p className="catalog-detail__note">{t("catalog.stockLevels.chooseStore")}</p>
        ) : null}
      </>
    );
  }

  return (
    <DetailPanel id={SECTION_ID} title={t("catalog.stockLevels.title")} index={index}>
      <PanelBody>
        <p className="catalog-detail__note">{t("catalog.stockLevels.sub")}</p>
        {body}
      </PanelBody>
      {editing && levels && tenantId ? (
        <StockLevelDrawer
          levels={levels}
          target={editing}
          storeName={labelOf(editing)}
          tenantId={tenantId}
          activeStoreId={activeStoreId}
          reload={state.reload}
          onClose={() => setEditing(null)}
          onDone={(outcome) => {
            setDone({ outcome, target: editing, store: labelOf(editing) });
            setEditing(null);
          }}
        />
      ) : null}
    </DetailPanel>
  );
}
