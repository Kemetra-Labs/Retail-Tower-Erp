/**
 * The gate every sale sync-ops page starts with (RT-726 sales needing repair, RT-1312 sale
 * quarantine): only the roles the API serves (owner / tenant_admin) get the page, any other role
 * gets NoAccess and nothing is requested, and without an active tenant the page asks for one.
 */
import { NoAccess } from "@/auth/NoAccess";
import { type MessageKey, useT } from "@/i18n";
import { type SaleScope, useSaleScope } from "@/sales/useSales";
import { useSignOut } from "@/shell/useSignOut";
import { canUseSaleSyncOps } from "./saleSyncLogic";

export function SyncOpsGate({
  promptKey,
  children,
}: Readonly<{
  /** The line that asks for a tenant. */
  promptKey: MessageKey;
  children: (scope: SaleScope) => React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const scope = useSaleScope();
  const signOut = useSignOut();
  if (!canUseSaleSyncOps(scope.role)) return <NoAccess onSignOut={signOut} />;
  if (!scope.tenantId) {
    return (
      <div className="surface">
        <p className="content__sub">{t(promptKey)}</p>
      </div>
    );
  }
  return <>{children(scope)}</>;
}
