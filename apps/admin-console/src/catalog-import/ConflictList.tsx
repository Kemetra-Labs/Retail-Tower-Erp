/**
 * RT-1509 / RT-1536: the rows the server says conflict in the preview (two rows state different
 * values for one product, or would give it a second SKU). It renders exactly the normalised list
 * `previewConflicts` returns, never one it inferred. There is no exit inside the import (G3, D4):
 * the merchant fixes the source file and replaces it, or cancels and uploads again.
 */
import { Banner } from "@/components/Banner";
import { type MessageKey, formatNumber, useT } from "@/i18n";
import type { CanonicalField } from "@/lib/catalog-import-queries";
import type { ImportConflict } from "./catalogImportLogic";
import { fieldLabelKey } from "./importParts";

export function ConflictList({
  conflicts,
}: Readonly<{ conflicts: readonly ImportConflict[] }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="import-step">
      <Banner
        variant="danger"
        title={t("catalogImport.preview.conflict.title")}
        message={t("catalogImport.preview.conflict.body")}
      />
      <div className="import-table-wrap">
        <table className="import-table">
          <caption>
            {t("catalogImport.preview.conflict.caption", { count: formatNumber(conflicts.length) })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("catalogImport.preview.conflict.product")}</th>
              <th scope="col">{t("catalogImport.preview.conflict.rows")}</th>
              <th scope="col">{t("catalogImport.preview.conflict.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map((c) => (
              <tr key={`${c.productName}-${c.rowNumbers.join(",")}`}>
                <th scope="row">
                  {c.productName}
                  {c.sku ? (
                    <>
                      <br />
                      <span className="import-step__why">
                        <bdi dir="ltr">{c.sku}</bdi>
                      </span>
                    </>
                  ) : null}
                </th>
                <td className="is-num">
                  <bdi dir="ltr">{c.rowNumbers.join(", ")}</bdi>
                </td>
                <td>
                  {c.reason.kind === "second_sku"
                    ? t("catalogImport.preview.conflict.secondSku")
                    : t("catalogImport.preview.conflict.field", {
                        field: t(
                          (c.reason.field in FIELD_SET
                            ? fieldLabelKey(c.reason.field as CanonicalField)
                            : "catalogImport.issue.unknown") as MessageKey,
                        ),
                      })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>{t("catalogImport.preview.conflict.fix")}</p>
    </div>
  );
}

const FIELD_SET: Record<string, true> = {
  sku: true,
  barcode: true,
  plu: true,
  name: true,
  description: true,
  category: true,
  brand: true,
  tax_category: true,
  is_active: true,
  price: true,
  currency: true,
};
