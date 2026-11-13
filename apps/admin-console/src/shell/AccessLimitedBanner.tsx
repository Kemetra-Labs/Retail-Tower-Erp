/**
 * RT-1350 slice 5a: the "limited until activated" banner (design v6 D2). A tenant
 * created by self-signup is active but `restricted`: catalog, stores and members
 * work, while POS pairing and ERP posting stay off until a platform admin unlocks
 * it. The server owns the state (RT-1353); the Console shows it and nothing more.
 *
 * Asked only for the roles the server allows to read it. Every failure (404, 429,
 * 5xx, offline, a body outside the contract) renders nothing: a missing banner is
 * harmless, a false one would mislead the owner. No tenant, no request.
 */
import { Banner } from "@/components/Banner";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { consoleGetTenantAccessEntitlement } from "@/lib/tenant-access-queries";
import { useQuery } from "@tanstack/react-query";

const READER_ROLES: readonly string[] = ["owner", "tenant_admin", "store_manager"];

interface Access {
  restricted: boolean;
  unlockRequested: boolean;
}

async function fetchAccess(tenantId: string): Promise<Access | null> {
  try {
    const res = await consoleGetTenantAccessEntitlement(tenantId);
    const body = res.data;
    if (res.status !== 200 || !body) return null;
    if (body.state !== "restricted" && body.state !== "unrestricted") return null;
    return { restricted: body.state === "restricted", unlockRequested: !!body.unlock_requested_at };
  } catch {
    return null;
  }
}

export function AccessLimitedBanner(): React.JSX.Element | null {
  const t = useT();
  const { context } = useActiveContextValue();
  const tenantId = context?.active_tenant?.id;
  const role = context?.active_role_code;
  const enabled = !!tenantId && READER_ROLES.includes(role ?? "");
  const query = useQuery<Access | null>({
    queryKey: ["tenant-access-entitlement", tenantId],
    queryFn: () => fetchAccess(tenantId as string),
    enabled,
    retry: false,
  });
  if (!enabled || !query.data?.restricted) return null;
  return (
    <Banner
      variant="info"
      title={t("shell.access.limited.title")}
      message={t(
        query.data.unlockRequested
          ? "shell.access.limited.requested"
          : "shell.access.limited.message",
      )}
    />
  );
}
