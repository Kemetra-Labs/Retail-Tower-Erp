/**
 * RT-1440 (U1): the store page's entry to the store's open shifts (RT-1437 A1). Shown to an owner
 * or tenant_admin outside a support session only; the server stays authoritative (the open-shifts
 * read answers the uniform 404 to anyone else).
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { Link } from "react-router";
import { canForceClose } from "./forceCloseLogic";

export function OpenShiftsLink({
  storeId,
}: Readonly<{ storeId: string }>): React.JSX.Element | null {
  const t = useT();
  const { context } = useActiveContextValue();
  if (!canForceClose(context?.active_role_code, Boolean(context?.support_session))) return null;
  return (
    <p className="store-panel-row">
      <Link to={`/stores/${storeId}/open-shifts`} className="store-panel-link">
        {t("forceActions.storeLink")}
      </Link>
    </p>
  );
}
