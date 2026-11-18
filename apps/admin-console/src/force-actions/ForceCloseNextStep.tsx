/**
 * RT-1440 (U1): the next step on the device impact panel. A retire, replace or move blocked by an
 * open shift (`unresolved_cash_session`), or a retire of a revoked device blocked by its custody
 * exception (`unresolved_custody_exception`), both clear when the shift is closed. For an owner or
 * tenant_admin outside a support session this links to the store's open shifts, where the server's
 * verdict is shown and the close-without-a-count dialog opens. Anyone else sees nothing here: the
 * action is hidden, and the server would answer the uniform 404 anyway.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { roleCodeOf } from "@/context/effectiveRole";
import { useT } from "@/i18n";
import { Link } from "react-router";
import { canForceClose } from "./forceCloseLogic";

/** The impact block codes that clear when the shift is closed (the decision record, S2). */
const SHIFT_BLOCK_CODES: ReadonlySet<string> = new Set([
  "unresolved_cash_session",
  "unresolved_custody_exception",
]);

export function blockedByOpenShift(blockCode: string | null): boolean {
  return blockCode !== null && SHIFT_BLOCK_CODES.has(blockCode);
}

export function ForceCloseNextStep({
  storeId,
}: Readonly<{ storeId: string }>): React.JSX.Element | null {
  const t = useT();
  const { context } = useActiveContextValue();
  const inSupportSession = Boolean(context?.support_session);
  if (
    !canForceClose(roleCodeOf(context), inSupportSession, context?.user?.is_platform_admin === true)
  ) {
    return null;
  }
  return (
    <p>
      <Link className="btn-secondary" to={`/stores/${storeId}/open-shifts`}>
        {t("forceActions.deviceLink")}
      </Link>
    </p>
  );
}
