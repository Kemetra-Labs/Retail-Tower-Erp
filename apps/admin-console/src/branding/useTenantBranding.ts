/**
 * RT-474 read: the tenant's branding (display name, `revision`, logo or null).
 * A refusal travels in the result, so the page branches on data. A request that
 * threw before any status is a load failure (status 0), never a crash.
 */
import { type TenantBranding, consoleGetTenantLogo } from "@/lib/tenant-branding-queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type BrandingOutcome, classifyBrandingWrite } from "./brandingLogic";

export const brandingKeys = {
  tenant: (tenantId: string) => ["tenant-branding", tenantId] as const,
};

export type BrandingRead = BrandingOutcome<TenantBranding>;

async function fetchBranding(tenantId: string): Promise<BrandingRead> {
  try {
    return classifyBrandingWrite(await consoleGetTenantLogo(tenantId));
  } catch {
    return { kind: "failed", status: 0 };
  }
}

export function useTenantBranding(tenantId: string, enabled: boolean) {
  const query = useQuery<BrandingRead>({
    queryKey: brandingKeys.tenant(tenantId),
    queryFn: () => fetchBranding(tenantId),
    enabled,
    retry: false,
  });
  return { result: query.data, isLoading: query.isLoading, refetch: () => query.refetch() };
}

/** Put a write's returned branding in the cache, so the next write chains its revision. */
export function useStoreBranding(tenantId: string): (branding: TenantBranding) => void {
  const qc = useQueryClient();
  return (branding) => {
    const next: BrandingRead = { kind: "ok", data: branding };
    qc.setQueryData(brandingKeys.tenant(tenantId), next);
  };
}
