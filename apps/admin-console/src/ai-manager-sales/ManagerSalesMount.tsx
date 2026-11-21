/**
 * RT-1541: where the Manager Sales Ask/Explain panel is mounted (the Overview and the
 * sales-by-store report, beside the KPIs).
 *
 * The panel is OPTIONAL_DEGRADE (RT-1526 §4.2): when it is off, unavailable or crashing, the base
 * KPI pages must be unaffected. So:
 *  - the default-OFF flag and the role gate decide first; when either says no, this renders
 *    nothing and makes no request (not even the store list);
 *  - everything the panel does sits inside an error boundary that shows one quiet line and never
 *    reaches the page around it. The boundary reports a fixed, value-free error: the original
 *    error is not forwarded, so no question or figure can leave with it.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { reportError } from "@/observability/report";
import { type ScopeMembership, scopeMenuStores } from "@/shell/scope-stores";
import { useStoreDirectory } from "@/shift-closes/useShiftCloses";
import { Component, type ReactNode } from "react";
import { ManagerSalesPanel } from "./ManagerSalesPanel";
import { isManagerSalesFlagOn, managerSalesRoleOf } from "./managerSalesAccess";
import type { StoreOption } from "./managerSalesLogic";
import "./manager-sales.css";

function Crashed(): React.JSX.Element {
  const t = useT();
  return <output className="ams-crashed">{t("aiManagerSales.crashed")}</output>;
}

interface BoundaryState {
  failed: boolean;
}

class PanelBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(): void {
    reportError(new Error("ai-manager-sales panel failed to render"));
  }

  override render(): ReactNode {
    return this.state.failed ? <Crashed /> : this.props.children;
  }
}

function PanelBody({
  tenantId,
  role,
}: Readonly<{ tenantId: string; role: string }>): React.JSX.Element | null {
  const { context } = useActiveContextValue();
  const directory = useStoreDirectory(tenantId);
  if (!directory.ready) return null;
  const membership = context?.memberships?.find((m) => m.tenant_id === tenantId) as
    | (ScopeMembership & { tenant_id?: string })
    | undefined;
  const stores: StoreOption[] = scopeMenuStores(directory.stores, membership, null).map((s) => ({
    id: s.id,
    name: s.name,
    timezone: "timezone" in s ? (s.timezone as string | null | undefined) : undefined,
  }));
  return (
    <ManagerSalesPanel
      stores={stores}
      tenantWide={membership?.store_access_kind !== "specific"}
      role={role}
    />
  );
}

export function ManagerSalesMount({
  enabled = isManagerSalesFlagOn(),
}: Readonly<{ enabled?: boolean }>): React.JSX.Element | null {
  const { context } = useActiveContextValue();
  const role = managerSalesRoleOf(context);
  const tenantId = context?.active_tenant?.id ?? null;
  if (!enabled || role === null || tenantId === null) return null;
  return (
    <PanelBoundary>
      <PanelBody tenantId={tenantId} role={role} />
    </PanelBoundary>
  );
}
