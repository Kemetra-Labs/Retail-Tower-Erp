/**
 * RT-455 tab panels built from the computed safety findings
 * (`listInventorySafetyFindings`, not paged: the whole set in the caller's
 * scope): active holds, expired lots still sellable, the stopped «قريبة
 * الانتهاء» tab, and the critical `tracking_consistency` band (OD-8).
 *
 * A store_manager reads findings for its own stores only; `getTrackingHold` and
 * the identity reads are owner / tenant_admin, so for it the rows carry no
 * «عرض» action and no identity link (the board's state 6).
 */
import { TableScrollRegion } from "@/components/DataTableScroll";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import type {
  ActiveHoldFinding,
  ConsistencyFinding,
  ExpiredSellableFinding,
} from "@/lib/tracking-queries";
import { Link } from "react-router";
import { trackingKindKey } from "../inventory/inventoryLogic";
import { Machine, Quantity } from "../inventory/parts";
import { DateValue, HoldKindBadge, ProductName, StoreList, StoreName, When } from "./parts";
import { checkKey } from "./trackingLogic";

/** An identity's code, linked to its detail for a role that may read it. */
export function IdentityCode({
  id,
  code,
  linked,
}: Readonly<{ id: string; code: string; linked: boolean }>): React.JSX.Element {
  if (!linked) return <Machine value={code} />;
  return (
    <Link to={`/tracking/identities/${id}`}>
      <Machine value={code} />
    </Link>
  );
}

function Body({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="inventory__panel-body inventory__panel-body--solo">{children}</div>;
}

// --- Active holds ---------------------------------------------------------------

export function ActiveHoldsPanel({
  holds,
  canOpen,
  onOpen,
}: Readonly<{
  holds: readonly ActiveHoldFinding[];
  canOpen: boolean;
  onOpen: (holdId: string) => void;
}>): React.JSX.Element {
  const t = useT();
  if (holds.length === 0) {
    return (
      <Body>
        <ListState state="empty" emptyMessage={t("tracking.active.empty")} />
        <p className="tracking__muted">{t("tracking.active.emptyHint")}</p>
      </Body>
    );
  }
  return (
    <>
      <TableScrollRegion>
        {(captionId) => (
          <table className="data-table data-table--strips" data-testid="tracking-active-table">
            <caption id={captionId} className="data-table__caption">
              {t("tracking.active.caption")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("tracking.col.status")}</th>
                <th scope="col">{t("tracking.col.product")}</th>
                <th scope="col">{t("tracking.col.identity")}</th>
                <th scope="col">{t("tracking.col.expiry")}</th>
                <th scope="col">{t("tracking.col.placedAt")}</th>
                <th scope="col">{t("tracking.col.stores")}</th>
                {canOpen ? <th scope="col">{t("tracking.col.action")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {holds.map((hold) => (
                <tr key={hold.holdId} className="data-table__row data-table__row--static">
                  <td>
                    <HoldKindBadge kind={hold.holdKind} />
                  </td>
                  <td>
                    <ProductName id={hold.tenantProductRef} />
                  </td>
                  <th scope="row">
                    <span className="tracking__identity">
                      <span className="tracking__muted">
                        {t(trackingKindKey(hold.identityKind))}
                      </span>
                      <IdentityCode
                        id={hold.trackingIdentityId}
                        code={hold.identityCode}
                        linked={canOpen}
                      />
                    </span>
                  </th>
                  <td>
                    <DateValue value={hold.expiryDate} />
                  </td>
                  <td>
                    <When iso={hold.placedAt} />
                  </td>
                  <td>
                    <StoreList ids={hold.storeIds} />
                  </td>
                  {canOpen ? (
                    <td>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onOpen(hold.holdId)}
                        aria-label={t("tracking.active.openLabel", { code: hold.identityCode })}
                      >
                        {t("tracking.action.open")}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableScrollRegion>
      <Body>
        <p className="tracking__muted">{t("tracking.findings.unpaged")}</p>
      </Body>
    </>
  );
}

// --- Expired lots still sellable --------------------------------------------------

export function ExpiredPanel({
  expired,
  canOpen,
}: Readonly<{ expired: readonly ExpiredSellableFinding[]; canOpen: boolean }>): React.JSX.Element {
  const t = useT();
  if (expired.length === 0) {
    return (
      <Body>
        <ListState state="empty" emptyMessage={t("tracking.expired.empty")} />
      </Body>
    );
  }
  return (
    <>
      <TableScrollRegion>
        {(captionId) => (
          <table className="data-table data-table--strips" data-testid="tracking-expired-table">
            <caption id={captionId} className="data-table__caption">
              {t("tracking.expired.caption")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("tracking.col.identity")}</th>
                <th scope="col">{t("tracking.col.product")}</th>
                <th scope="col">{t("tracking.col.store")}</th>
                <th scope="col">{t("tracking.col.expiredOn")}</th>
                <th scope="col">{t("tracking.col.businessDate")}</th>
                <th scope="col" className="num">
                  {t("tracking.col.sellable")}
                </th>
                <th scope="col">{t("tracking.col.action")}</th>
              </tr>
            </thead>
            <tbody>
              {expired.map((row) => (
                <tr
                  key={`${row.trackingIdentityId}:${row.storeId}:${row.stockingUnit}`}
                  className="data-table__row data-table__row--static"
                >
                  <th scope="row">
                    <IdentityCode
                      id={row.trackingIdentityId}
                      code={row.identityCode}
                      linked={canOpen}
                    />
                  </th>
                  <td>
                    <ProductName id={row.tenantProductRef} />
                  </td>
                  <td>
                    <StoreName id={row.storeId} />
                  </td>
                  <td>
                    <Machine value={row.expiryDate} />
                  </td>
                  <td>
                    <Machine value={row.storeBusinessDate} />
                  </td>
                  <td className="num">
                    <Quantity value={row.sellableQuantity} /> <Machine value={row.stockingUnit} />
                  </td>
                  <td>
                    {/* The governed sellable → expired move lives on the product page (RT-436). */}
                    <Link
                      to={`/inventory/stores/${row.storeId}/products/${row.tenantProductRef}`}
                      className="btn-ghost"
                    >
                      {t("tracking.expired.move")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableScrollRegion>
      <Body>
        <p className="tracking__muted">{t("tracking.expired.note")}</p>
      </Body>
    </>
  );
}

// --- Expiring (stopped) -------------------------------------------------------------

/** `expiring_lot` is reserved and never emitted (RT-50 B1): stopped, never zero. */
export function ExpiringPanel(): React.JSX.Element {
  const t = useT();
  return (
    <Body>
      <div className="tracking__soon" data-testid="tracking-expiring-stopped">
        <span className="badge">{t("tracking.expiring.tag")}</span>
        <p className="tracking__soon-title">{t("tracking.expiring.title")}</p>
        <p className="tracking__muted">{t("tracking.expiring.body")}</p>
      </div>
    </Body>
  );
}

// --- Tracking consistency (critical) ---------------------------------------------------

/**
 * OD-8: a critical band above the tabs, only while the server reports a finding.
 * No emitter of this kind is on `main` yet (RT-451 and RT-453 own them), so an
 * empty set is no evidence of consistency: it is never drawn as «0». The Health
 * view says it is unavailable instead (RT-455 part 2: nothing is faked).
 */
export function ConsistencyBand({
  findings,
}: Readonly<{ findings: readonly ConsistencyFinding[] }>): React.JSX.Element | null {
  const t = useT();
  if (findings.length === 0) {
    return (
      <section
        className="tracking__soon"
        aria-labelledby="tracking-consistency-unavailable-title"
        data-testid="tracking-consistency-unavailable"
      >
        <span className="badge">{t("tracking.expiring.tag")}</span>
        <h2 id="tracking-consistency-unavailable-title" className="tracking__soon-title">
          {t("tracking.consistency.unavailable.title")}
        </h2>
        <p className="tracking__muted">{t("tracking.consistency.unavailable.body")}</p>
      </section>
    );
  }
  return (
    <section
      className="tracking__consistency"
      aria-labelledby="tracking-consistency-title"
      data-testid="tracking-consistency"
    >
      <h2 id="tracking-consistency-title" className="tracking__consistency-title">
        {t("tracking.consistency.title", { count: findings.length })}
      </h2>
      <p className="tracking__muted">{t("tracking.consistency.body")}</p>
      <ul className="tracking__consistency-list">
        {findings.map((f, i) => (
          <li key={`${f.check}:${f.tenantProductRef}:${f.trackingIdentityId}:${f.storeId}:${i}`}>
            <span className="badge badge--danger">{t(checkKey(f.check))}</span>{" "}
            <ProductName id={f.tenantProductRef} />
            {f.storeId ? (
              <>
                {" · "}
                <StoreName id={f.storeId} />
              </>
            ) : null}
            {f.stockingUnit ? (
              <>
                {" · "}
                <Machine value={f.stockingUnit} />
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
