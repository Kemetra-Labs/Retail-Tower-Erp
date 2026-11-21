/**
 * RT-1509 / RT-1536: the rows the server says conflict in the preview (two rows state different
 * values for one product, or would give it a second SKU). It renders exactly the list the server
 * named (`previewConflicts`), never one it inferred, and says so when the server's count is larger
 * than the bounded list. There is no exit inside the import (G3, D4): the merchant fixes the source
 * file and replaces it, or cancels and uploads again.
 */
import { Banner } from "@/components/Banner";
import { type MessageKey, formatNumber, useT } from "@/i18n";
import type { ImportConflict } from "@/lib/catalog-import-queries";

const CHANGE_FIELDS: readonly string[] = [
  "name",
  "description",
  "category",
  "brand",
  "tax_category",
  "is_active",
];

function ReasonText({ conflict }: Readonly<{ conflict: ImportConflict }>): React.JSX.Element {
  const t = useT();
  if (conflict.reason === "second_sku") {
    return <>{t("catalogImport.preview.conflict.secondSku")}</>;
  }
  const field = conflict.field ?? "";
  const label = CHANGE_FIELDS.includes(field)
    ? t(`catalogImport.changes.field.${field}` as MessageKey)
    : field;
  return <>{t("catalogImport.preview.conflict.field", { field: label })}</>;
}

export function ConflictList({
  conflicts,
  total,
}: Readonly<{ conflicts: readonly ImportConflict[]; total: number }>): React.JSX.Element {
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
            {t("catalogImport.preview.conflict.caption", { count: formatNumber(total) })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("catalogImport.preview.conflict.product")}</th>
              <th scope="col">{t("catalogImport.preview.conflict.rows")}</th>
              <th scope="col">{t("catalogImport.preview.conflict.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map((c) => {
              const sku = c.product.identifiers.find((i) => i.type === "sku")?.value;
              return (
                <tr key={`${c.product.productId}-${c.reason}-${c.field ?? ""}`}>
                  <th scope="row">
                    {c.product.name}
                    {sku ? (
                      <>
                        <br />
                        <span className="import-step__why">
                          <bdi dir="ltr">{sku}</bdi>
                        </span>
                      </>
                    ) : null}
                  </th>
                  <td className="is-num">
                    <bdi dir="ltr">{c.rowNumbers.join(", ")}</bdi>
                  </td>
                  <td>
                    <ReasonText conflict={c} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total > conflicts.length ? (
        <p className="import-step__why">
          {t("catalogImport.preview.conflict.more", {
            shown: formatNumber(conflicts.length),
            total: formatNumber(total),
          })}
        </p>
      ) : null}
      <p>{t("catalogImport.preview.conflict.fix")}</p>
    </div>
  );
}
