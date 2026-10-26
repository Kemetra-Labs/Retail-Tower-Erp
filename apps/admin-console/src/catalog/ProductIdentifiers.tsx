/**
 * RT-769 the item's identifiers section with its writes (CAT-C2b, RT-752 AC 2:
 * "identifiers are edited from detail sections in drawer forms, one write
 * each"). Owner and tenant_admin on an item that is not retired get an Add
 * control and, per row, a Retire control; everyone else (store_manager, any
 * role on a retired item) gets the read-only table of RT-766 unchanged. The
 * controls mirror the API's write roles; the server stays the authority.
 *
 * After a write the page shows the detail the server returned (no extra read)
 * and a polite status says what happened. Focus returns to the Add control: the
 * Retire control it came from is gone with its row. When a drawer learned that
 * the item changed under it (retired, or the identifier no longer active), the
 * item is read again as the drawer closes.
 */
import { type MessageKey, useT } from "@/i18n";
import type { CatalogIdentifier, CatalogProductDetail } from "@/lib/catalog-queries";
import { useEffect, useRef, useState } from "react";
import { Identifiers } from "./CatalogDetailSections";
import { IdentifierAdd } from "./IdentifierAdd";
import { IdentifierRetire } from "./IdentifierRetire";
import { identifierTypeKey } from "./catalogDetailLogic";
import { isIdentifierType } from "./identifierFormLogic";
import type { StoreLabel } from "./useCatalogProduct";
import { useIdentifierStores } from "./useIdentifierWrites";

export interface ProductIdentifiersProps {
  product: CatalogProductDetail;
  /** Set only for a writer on an item that is not retired; null reads only. */
  writableTenantId: string | null;
  storeLabel: (id: string) => StoreLabel;
  /** Read the item again; `undefined` when it could not be read. */
  reload: () => Promise<CatalogProductDetail | undefined>;
}

const OUTCOME_KEY: Record<"added" | "retired", MessageKey> = {
  added: "catalog.identifier.added",
  retired: "catalog.identifier.retiredDone",
};

type Open = { kind: "add" } | { kind: "retire"; identifier: CatalogIdentifier } | null;

function IdentifierEditor({
  product,
  tenantId,
  storeLabel,
  reload,
}: Readonly<{
  product: CatalogProductDetail;
  tenantId: string;
  storeLabel: (id: string) => StoreLabel;
  reload: () => Promise<CatalogProductDetail | undefined>;
}>): React.JSX.Element {
  const t = useT();
  const { productId } = product.summary;
  const [open, setOpen] = useState<Open>(null);
  const [outcome, setOutcome] = useState<"added" | "retired" | null>(null);
  const [focusAdd, setFocusAdd] = useState(0);
  const stale = useRef(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const stores = useIdentifierStores(tenantId, open?.kind === "add");

  useEffect(() => {
    if (focusAdd > 0) addRef.current?.focus();
  }, [focusAdd]);

  function start(next: Open): void {
    stale.current = false;
    setOutcome(null);
    setOpen(next);
  }

  function close(): void {
    setOpen(null);
    if (stale.current) {
      stale.current = false;
      void reload();
    }
  }

  function done(what: "added" | "retired"): void {
    setOpen(null);
    setOutcome(what);
    setFocusAdd((n) => n + 1);
  }

  const markStale = () => {
    stale.current = true;
  };

  const actions = (
    <div className="catalog-identifiers__actions">
      <button
        ref={addRef}
        type="button"
        className="btn-secondary"
        onClick={() => start({ kind: "add" })}
      >
        {t("catalog.identifier.add.start")}
      </button>
      <output className="catalog-identifiers__status">
        {outcome ? t(OUTCOME_KEY[outcome]) : ""}
      </output>
    </div>
  );

  const rowAction = (identifier: CatalogIdentifier): React.ReactNode =>
    isIdentifierType(identifier.identifierType) ? (
      <button
        type="button"
        className="btn-danger-quiet"
        aria-label={t("catalog.identifier.retire.rowLabel", {
          type: t(identifierTypeKey(identifier.identifierType)),
          value: identifier.value,
        })}
        onClick={() => start({ kind: "retire", identifier })}
      >
        {t("catalog.identifier.retire.start")}
      </button>
    ) : null;

  return (
    <>
      <Identifiers
        identifiers={product.identifiers}
        storeLabel={storeLabel}
        actions={actions}
        rowAction={rowAction}
      />
      {open?.kind === "add" ? (
        <IdentifierAdd
          productId={productId}
          tenantId={tenantId}
          stores={stores}
          onClose={close}
          onAdded={() => done("added")}
          onStale={markStale}
        />
      ) : null}
      {open?.kind === "retire" ? (
        <IdentifierRetire
          identifier={open.identifier}
          productId={productId}
          tenantId={tenantId}
          storeLabel={storeLabel}
          onClose={close}
          onRetired={() => done("retired")}
          onStale={markStale}
        />
      ) : null}
    </>
  );
}

export function ProductIdentifiers({
  product,
  writableTenantId,
  storeLabel,
  reload,
}: Readonly<ProductIdentifiersProps>): React.JSX.Element {
  if (writableTenantId === null) {
    return <Identifiers identifiers={product.identifiers} storeLabel={storeLabel} />;
  }
  return (
    <IdentifierEditor
      product={product}
      tenantId={writableTenantId}
      storeLabel={storeLabel}
      reload={reload}
    />
  );
}
