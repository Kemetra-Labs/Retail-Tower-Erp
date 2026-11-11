import { NoAccess } from "@/auth/NoAccess";
import { Banner } from "@/components/Banner";
import { BusyButton } from "@/components/BusyButton";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { FilterBar, FilterField } from "@/components/FilterBar";
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { type MessageKey, useT } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { usePayerStores } from "@/payers/usePayerStores";
import { useSignOut } from "@/shell/useSignOut";
/**
 * RT-1109 vouchers page (RT-1098 slice I-4), for owner / tenant_admin only
 * (decision 2A). The list of the active tenant's vouchers, newest first, with
 * status and store filters, a detail drawer with cancel, and the issue drawer.
 *
 * The page calls Backend-Core only, through the generated client. It never
 * shows a voucher code: no read response has one. Codes appear only inside the
 * issue drawer, right after a 201, and are gone when it closes (VoucherIssue).
 *
 * Gate first: any other role gets NoAccess and nothing is requested. No active
 * tenant → a scope prompt. Errors show catalog copy and the request id, never
 * the server's words. A failed "Load more" keeps the rows already shown.
 *
 * The store roster is the caller's own (`usePayerStores`: `GET /stores`
 * narrowed by the membership, the scope menu's rule). Store scope bounds every
 * voucher operation server-side; the roster only names stores and fills the
 * pickers.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { VoucherDetail } from "./VoucherDetail";
import { VoucherIssue } from "./VoucherIssue";
import { VoucherEligibilityText, VoucherStatusBadge } from "./VoucherParts";
import {
  type VoucherFilters,
  type VoucherReadError,
  useVoucherList,
  voucherQueryKeys,
} from "./useVouchers";
import {
  VOUCHER_STATUSES,
  type VoucherRow,
  type VoucherStatus,
  canReadVouchers,
  formatVoucherAmount,
  voucherStatusKey,
} from "./voucherLogic";
import "../shell/surface.css";
import "./vouchers.css";

const ERROR_COPY: Record<VoucherReadError["kind"], MessageKey> = {
  session: "vouchers.errors.session",
  forbidden: "vouchers.errors.forbidden",
  notFound: "vouchers.list.loadFailed",
  generic: "vouchers.list.loadFailed",
};

type Store = { id: string; name?: string };

function VoucherFilterBar({
  stores,
  onApply,
}: Readonly<{ stores: readonly Store[]; onApply: (filters: VoucherFilters) => void }>) {
  const t = useT();
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <FilterBar
      label={t("vouchers.filters.label")}
      formRef={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const status = String(form.get("status") ?? "");
        const store = String(form.get("store") ?? "");
        onApply({
          status: status ? (status as VoucherStatus) : undefined,
          eligible_store_id: store || undefined,
        });
      }}
      onClear={() => {
        formRef.current?.reset();
        onApply({});
      }}
    >
      <FilterField id="voucher-f-status" label={t("vouchers.filters.status")}>
        <select id="voucher-f-status" name="status" className="input" defaultValue="">
          <option value="">{t("vouchers.filters.statusAny")}</option>
          {VOUCHER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(voucherStatusKey(status))}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField id="voucher-f-store" label={t("vouchers.filters.store")}>
        <select id="voucher-f-store" name="store" className="input" defaultValue="">
          <option value="">{t("vouchers.filters.storeAny")}</option>
          {stores.map((store) => (
            <option key={store.id} value={store.id}>
              {store.name ?? store.id}
            </option>
          ))}
        </select>
      </FilterField>
    </FilterBar>
  );
}

function VoucherRowView({
  row,
  stores,
  onOpen,
}: Readonly<{ row: VoucherRow; stores: readonly Store[]; onOpen: () => void }>) {
  const t = useT();
  const amount = formatVoucherAmount(row.amount_minor, row.currency_code);
  const issued = formatDateTime(row.created_at);
  return (
    <tr className="data-table__row">
      <td className="data-table__cell--num">
        <bdi dir="ltr">{amount}</bdi>
      </td>
      <td>
        <VoucherStatusBadge status={row.status} />
      </td>
      <td>
        <VoucherEligibilityText row={row} stores={stores} />
      </td>
      <td>{row.expires_at ? formatDateTime(row.expires_at) : t("vouchers.list.noExpiry")}</td>
      <td>{issued}</td>
      <td>
        <button
          type="button"
          className="btn-secondary"
          onClick={onOpen}
          aria-label={t("vouchers.list.openLabel", { amount, issued })}
        >
          {t("vouchers.list.open")}
        </button>
      </td>
    </tr>
  );
}

function VoucherListBody({
  list,
  stores,
  filtered,
  issueButton,
  onOpen,
}: Readonly<{
  list: ReturnType<typeof useVoucherList>;
  stores: readonly Store[];
  filtered: boolean;
  issueButton: React.ReactNode;
  onOpen: (voucherId: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const { rows, hasMore, isLoading, isFetchingNextPage, error, loadMore } = list;
  const settled = !isLoading;
  const emptyAll = settled && !error && rows.length === 0 && !hasMore;

  let empty: React.ReactNode = null;
  if (emptyAll) {
    empty = filtered ? (
      <ListState state="empty" emptyMessage={t("vouchers.list.emptyFiltered")} />
    ) : (
      <ListState state="empty" emptyMessage={t("vouchers.list.empty")} action={issueButton} />
    );
  }

  return (
    <>
      {error ? (
        <Banner variant="danger" message={t(ERROR_COPY[error.kind])} requestId={error.requestId} />
      ) : null}
      {isLoading ? <ListState state="loading" label={t("vouchers.list.loadingNoun")} /> : null}
      {empty}
      {settled && !error && rows.length === 0 && hasMore ? (
        <p className="content__sub">{t("vouchers.list.emptyPage")}</p>
      ) : null}
      {settled && rows.length > 0 ? (
        <TableScrollRegion>
          {(captionId) => (
            <table className="data-table">
              <caption id={captionId} className="data-table__caption">
                {t("vouchers.list.caption")}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="data-table__cell--num">
                    {t("vouchers.list.col.value")}
                  </th>
                  <th scope="col">{t("vouchers.list.col.status")}</th>
                  <th scope="col">{t("vouchers.list.col.validIn")}</th>
                  <th scope="col">{t("vouchers.list.col.expires")}</th>
                  <th scope="col">{t("vouchers.list.col.issued")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("vouchers.list.col.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <VoucherRowView
                    key={row.voucher_id}
                    row={row}
                    stores={stores}
                    onOpen={() => onOpen(row.voucher_id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </TableScrollRegion>
      ) : null}
      {settled && hasMore ? (
        <div className="surface__actions">
          <BusyButton
            type="button"
            className="btn-secondary"
            onClick={loadMore}
            busy={isFetchingNextPage}
          >
            {t("vouchers.list.loadMore")}
          </BusyButton>
        </div>
      ) : null}
    </>
  );
}

export function VoucherList(): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const queryClient = useQueryClient();
  const { context } = useActiveContextValue();
  const rawTenant = context?.active_tenant ?? null;
  const allowed = canReadVouchers(context?.active_role_code);
  const tenantId = allowed ? (rawTenant?.id ?? null) : null;
  const [filters, setFilters] = useState<VoucherFilters>({});
  const list = useVoucherList(tenantId, filters);
  const stores = usePayerStores(rawTenant?.id ?? null, allowed);
  const [issuing, setIssuing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  if (!rawTenant?.id) {
    return (
      <div className="surface">
        <p className="content__sub">{t("vouchers.list.scopePrompt")}</p>
      </div>
    );
  }
  if (!allowed) return <NoAccess onSignOut={signOut} />;

  const tenantName = rawTenant.name ?? rawTenant.id;
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: voucherQueryKeys.all(tenantId) });
  };
  const issueButton = (
    <button type="button" className="btn-primary" onClick={() => setIssuing(true)}>
      {t("vouchers.list.issue")}
    </button>
  );

  return (
    <div className="surface">
      <ListHeaderBand
        group={t("shell.nav.section.management")}
        title={t("vouchers.list.title")}
        subtitle={t.rich("vouchers.list.subtitle", { tenant: <bdi>{tenantName}</bdi> })}
        actions={issueButton}
      />

      <VoucherFilterBar stores={stores} onApply={setFilters} />

      <VoucherListBody
        list={list}
        stores={stores}
        filtered={Boolean(filters.status || filters.eligible_store_id)}
        issueButton={issueButton}
        onOpen={setOpenId}
      />

      {issuing ? (
        <VoucherIssue
          activeTenant={{ id: rawTenant.id, name: tenantName }}
          stores={stores}
          onClose={() => {
            setIssuing(false);
            refresh();
          }}
        />
      ) : null}

      {openId ? (
        <VoucherDetail
          tenantId={rawTenant.id}
          voucherId={openId}
          stores={stores}
          onClose={() => setOpenId(null)}
          onCancelled={refresh}
        />
      ) : null}
    </div>
  );
}
