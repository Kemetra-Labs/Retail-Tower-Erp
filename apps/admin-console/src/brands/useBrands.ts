/**
 * RT-1338 brand reads and writes (react-query). The list is the tenant's whole non-retired set
 * (not paginated), keyed by tenant so a tenant switch re-queries. The same list feeds the product
 * form's brand select, the catalog's brand filter and the offer editor's brand picker.
 */
import {
  type CatalogBrand,
  consoleCreateCatalogBrand,
  consoleListCatalogBrands,
  consoleRenameCatalogBrand,
} from "@/lib/brand-queries";
import { KeyedAttempt } from "@/lib/write-outcome";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { type BrandWriteOutcome, classifyBrandWrite } from "./brandLogic";

export const brandQueryKeys = {
  list: (tenantId: string | null) => ["catalog", "brands", tenantId] as const,
};

export interface BrandListState {
  brands: readonly CatalogBrand[];
  isLoading: boolean;
  /** The list could not be read: forms keep working without it. */
  failed: boolean;
  retry: () => void;
}

class BrandReadFailure extends Error {
  constructor(readonly status: number) {
    super("brand-read");
  }
}

export function useCatalogBrands(tenantId: string | null, enabled = true): BrandListState {
  const result = useQuery<readonly CatalogBrand[]>({
    queryKey: brandQueryKeys.list(tenantId),
    enabled: enabled && Boolean(tenantId),
    queryFn: async () => {
      const res = await consoleListCatalogBrands();
      if (res.status >= 400 || !res.data) throw new BrandReadFailure(res.status);
      return res.data.items;
    },
    retry: false,
  });
  return {
    brands: result.data ?? [],
    isLoading: result.isLoading && Boolean(tenantId),
    failed: result.isError,
    retry: () => void result.refetch(),
  };
}

/** Create: one key per name; a retry after a lost answer replays the stored 201. */
export function useCreateBrand(tenantId: string | null) {
  const qc = useQueryClient();
  const attempt = useRef(new KeyedAttempt());
  return useMutation({
    mutationFn: async (name: string): Promise<BrandWriteOutcome> => {
      const res = await consoleCreateCatalogBrand(name, attempt.current.keyFor(name));
      const outcome = classifyBrandWrite(res, "create");
      if (outcome.kind !== "uncertain") attempt.current.settle();
      return outcome;
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "ok") {
        void qc.invalidateQueries({ queryKey: brandQueryKeys.list(tenantId) });
      }
    },
  });
}

export interface RenameInput {
  brandId: string;
  name: string;
  expectedUpdatedAt: string;
}

export function useRenameBrand(tenantId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RenameInput): Promise<BrandWriteOutcome> =>
      classifyBrandWrite(
        await consoleRenameCatalogBrand(input.brandId, input.name, input.expectedUpdatedAt),
        "rename",
      ),
    onSuccess: (outcome) => {
      if (outcome.kind === "ok" || outcome.kind === "stale" || outcome.kind === "gone") {
        void qc.invalidateQueries({ queryKey: brandQueryKeys.list(tenantId) });
      }
      // A rename also changes the brand name shown on products.
      if (outcome.kind === "ok") void qc.invalidateQueries({ queryKey: ["catalog", "products"] });
    },
  });
}
