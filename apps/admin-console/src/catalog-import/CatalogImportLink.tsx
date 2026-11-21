import type { CatalogScope } from "@/catalog/useCatalog";
/**
 * RT-1509: Products → «استيراد المنتجات». Shown to an owner or tenant_admin only (store roles never
 * see the entry, spec 049 §8.6); the server stays authoritative (the import routes answer the
 * non-disclosing 404 to anyone else).
 */
import { useT } from "@/i18n";
import { Link } from "react-router";
import { canImportCatalog } from "./catalogImportLogic";

export function CatalogImportLink({
  scope,
}: Readonly<{ scope: Pick<CatalogScope, "role"> }>): React.JSX.Element | null {
  const t = useT();
  if (!canImportCatalog(scope.role)) return null;
  return (
    <Link to="/catalog/import" className="btn-secondary">
      {t("catalogImport.nav.link")}
    </Link>
  );
}
