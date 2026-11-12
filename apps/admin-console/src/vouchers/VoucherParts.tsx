import { useT } from "@/i18n";
/**
 * RT-1109: small read-only pieces shared by the list and the detail drawer.
 * Status is data, not decoration (UX-10.29): an active voucher stays quiet,
 * a used one reads as success, a cancelled or expired one as a muted warning.
 * The badge always carries its text.
 */
import { type VoucherRow, voucherEligibility, voucherStatusKey } from "./voucherLogic";

const STATUS_CLASS: Record<string, string> = {
  redeemed: "badge badge--success",
  cancelled: "badge badge--warning",
  expired: "badge badge--warning",
};

export function VoucherStatusBadge({ status }: Readonly<{ status: string }>): React.JSX.Element {
  const t = useT();
  return <span className={STATUS_CLASS[status] ?? "badge"}>{t(voucherStatusKey(status))}</span>;
}

export function VoucherEligibilityText({
  row,
  stores,
}: Readonly<{
  row: Pick<VoucherRow, "applies_to_all_stores" | "eligible_store_ids">;
  stores: readonly { id: string; name?: string }[];
}>): React.JSX.Element {
  const t = useT();
  const eligibility = voucherEligibility(row, stores);
  if (eligibility.kind === "all") return <>{t("vouchers.eligibility.all")}</>;
  return (
    <ul className="vouchers__stores">
      {eligibility.names.map((name) => (
        <li key={name}>
          <bdi>{name}</bdi>
        </li>
      ))}
      {eligibility.unnamed > 0 ? (
        <li>{t("vouchers.eligibility.unnamed", { count: eligibility.unnamed })}</li>
      ) : null}
    </ul>
  );
}
