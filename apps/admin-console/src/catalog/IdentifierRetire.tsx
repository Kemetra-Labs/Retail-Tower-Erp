/**
 * RT-769 retire an identifier (CAT-C2b). A drawer over the item's detail, one
 * write: `consoleRetireProductIdentifier` with the identifier's FULL key exactly
 * as it was read (type, value, store, source system), byte for byte.
 *
 * The drawer names the identifier and the consequence: its value is freed and
 * can be bound again, to this item or another one; until then scanning it finds
 * nothing. A 404 is the API's non-disclosing "not active on this item": the
 * drawer says so, locks, and the page reads the item again when it closes.
 */
import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { GatedButton } from "@/components/GatedButton";
import { useT } from "@/i18n";
import type { CatalogIdentifier } from "@/lib/catalog-queries";
import { useState } from "react";
import { identifierTypeKey } from "./catalogDetailLogic";
import { type IdentifierWriteRender, retireKeyOf } from "./identifierFormLogic";
import type { StoreLabel } from "./useCatalogProduct";
import { useRetireIdentifier } from "./useIdentifierWrites";

export interface IdentifierRetireProps {
  identifier: CatalogIdentifier;
  productId: string;
  tenantId: string;
  storeLabel: (id: string) => StoreLabel;
  onClose: () => void;
  /** The identifier is retired; the page already holds the detail after the change. */
  onRetired: () => void;
  /** The identifier is no longer active here: the page reads the item again on close. */
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
      variant="warning"
      message={t(
        render.kind === "gone"
          ? "catalog.identifier.error.gone"
          : "catalog.identifier.error.retired",
      )}
      requestId={render.requestId}
    />
  );
}

function Row({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="field-row">
      <dt className="field-row__label">{label}</dt>
      <dd className="field-row__value">{children}</dd>
    </div>
  );
}

export function IdentifierRetire({
  identifier,
  productId,
  tenantId,
  storeLabel,
  onClose,
  onRetired,
  onStale,
}: Readonly<IdentifierRetireProps>): React.JSX.Element {
  const t = useT();
  const retire = useRetireIdentifier(tenantId, productId);
  const [failure, setFailure] = useState<BannerRender | undefined>();
  const [locked, setLocked] = useState(false);
  const pending = retire.isPending;
  const store = identifier.storeId ? storeLabel(identifier.storeId) : null;

  async function confirm(): Promise<void> {
    if (pending || locked) return;
    setFailure(undefined);
    try {
      const result = await retire.mutateAsync(retireKeyOf(identifier));
      if (result.ok) {
        onRetired();
        return;
      }
      const { render } = result;
      // Retire has no field to return to; a `field` render cannot come from it.
      if (render.kind === "field") return;
      if (render.kind === "gone" || render.kind === "retired") {
        setLocked(true);
        onStale();
      }
      setFailure(render);
    } catch {
      // A thrown request (offline, aborted) is still a visible failure, never silent.
      setFailure({ kind: "banner", variant: "danger", messageKey: "catalog.write.error.server" });
    }
  }

  return (
    <Drawer title={t("catalog.identifier.retire.title")} onClose={onClose} dismissible={!pending}>
      {failure ? <FailureBanner render={failure} /> : null}
      <dl className="surface__detail">
        <Row label={t("catalog.detail.identifiers.col.type")}>
          {t(identifierTypeKey(identifier.identifierType))}
        </Row>
        <Row label={t("catalog.detail.identifiers.col.value")}>
          <bdi dir="ltr" className="catalog-code">
            {identifier.value}
          </bdi>
        </Row>
        <Row label={t("catalog.detail.identifiers.col.scope")}>
          {store ? (
            <bdi dir="auto">{store.name ?? store.id}</bdi>
          ) : (
            t("catalog.detail.identifiers.scopeAll")
          )}
        </Row>
        {identifier.sourceSystem ? (
          <Row label={t("catalog.detail.identifiers.col.source")}>
            <bdi dir="ltr" className="catalog-code">
              {identifier.sourceSystem}
            </bdi>
          </Row>
        ) : null}
      </dl>
      <p className="content__sub">{t("catalog.identifier.retire.consequence")}</p>
      <div className="surface__actions">
        <GatedButton
          type="button"
          className="btn-destructive"
          onClick={() => void confirm()}
          busy={pending}
          disabled={locked}
        >
          {t("catalog.identifier.retire.confirm")}
        </GatedButton>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={pending}>
          {t("common.cancel")}
        </button>
      </div>
    </Drawer>
  );
}
