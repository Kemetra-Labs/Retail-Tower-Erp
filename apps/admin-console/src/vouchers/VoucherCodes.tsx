import { Banner } from "@/components/Banner";
import { TableScrollRegion } from "@/components/DataTableScroll";
import { useT } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
/**
 * RT-1109: the issued codes, shown once (contract: a code appears only in the
 * issue 201 and can never be shown again).
 *
 * The batch lives in the issue drawer's React state and nowhere else: not in
 * the query cache, not in browser storage, not in the URL, not in a log. The
 * codes file is built from that state in memory (`buildCodesCsv`) and handed to
 * the browser as a download; its object URL is revoked at once. When the drawer
 * closes the state is gone, so a reload cannot show the codes again.
 */
import { useState } from "react";
import { type VoucherIssueResponse, buildCodesCsv, formatVoucherAmount } from "./voucherLogic";

function downloadCodes(batch: VoucherIssueResponse): void {
  const blob = new Blob([buildCodesCsv(batch)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vouchers-${batch.batch_id}.csv`;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

type CopyState = "idle" | "copied" | "failed";

export function VoucherCodes({
  batch,
  onDone,
}: Readonly<{ batch: VoucherIssueResponse; onDone: () => void }>): React.JSX.Element {
  const t = useT();
  const [copy, setCopy] = useState<CopyState>("idle");

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(batch.vouchers.map((v) => v.code).join("\n"));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <>
      <Banner
        variant="success"
        message={t("vouchers.codes.issued", { count: batch.vouchers.length })}
      />
      <Banner variant="warning" message={t("vouchers.codes.warning")} />

      <div className="vouchers__actions">
        <button type="button" className="btn-primary" onClick={() => downloadCodes(batch)}>
          {t("vouchers.codes.download")}
        </button>
        <button type="button" className="btn-secondary" onClick={() => void copyAll()}>
          {t("vouchers.codes.copy")}
        </button>
      </div>
      <output className="content__sub">
        {copy === "copied" ? t("vouchers.codes.copied") : null}
        {copy === "failed" ? t("vouchers.codes.copyFailed") : null}
      </output>

      <TableScrollRegion>
        {(captionId) => (
          <table className="data-table">
            <caption id={captionId} className="data-table__caption">
              {t("vouchers.codes.caption")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("vouchers.codes.col.code")}</th>
                <th scope="col" className="data-table__cell--num">
                  {t("vouchers.codes.col.value")}
                </th>
                <th scope="col">{t("vouchers.codes.col.expires")}</th>
              </tr>
            </thead>
            <tbody>
              {batch.vouchers.map((v) => (
                <tr key={v.voucher_id}>
                  <th scope="row">
                    <bdi dir="ltr" className="vouchers__code">
                      {v.code}
                    </bdi>
                  </th>
                  <td className="data-table__cell--num">
                    <bdi dir="ltr">{formatVoucherAmount(v.amount_minor, v.currency_code)}</bdi>
                  </td>
                  <td>
                    {v.expires_at ? formatDateTime(v.expires_at) : t("vouchers.list.noExpiry")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableScrollRegion>

      <div className="vouchers__actions">
        <button type="button" className="btn-secondary" onClick={onDone}>
          {t("vouchers.codes.done")}
        </button>
      </div>
    </>
  );
}
