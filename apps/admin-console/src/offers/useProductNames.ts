/**
 * RT-1338: names for the product ids an offer rule holds. A saved draft stores ids only, so the
 * editor reads each product it does not already know through `consoleGetCatalogProduct` (under its
 * own cache key, so the item detail's normalised cache is never touched). Only the first `MAX_LOOKUPS` unknown ids are read; the
 * rest show as "N more items" rather than flooding the API (a rule may hold up to 5000 products).
 * A failed read leaves the id unnamed: the chip says "Unavailable item", never a guess.
 */
import { consoleGetCatalogProduct } from "@/lib/catalog-queries";
import { useQueries } from "@tanstack/react-query";

export const MAX_LOOKUPS = 30;

export interface ProductNames {
  /** The name of a product when it is known; undefined while unread or when it could not be read. */
  nameOf: (productId: string) => string | undefined;
  /** Ids beyond the lookup cap: shown only as a count. */
  unreadCount: number;
}

export function useProductNames(
  tenantId: string | null,
  productIds: readonly string[],
  known: Readonly<Record<string, string>>,
): ProductNames {
  const unknown = productIds.filter((id) => known[id] === undefined);
  const lookups = unknown.slice(0, MAX_LOOKUPS);
  const results = useQueries({
    queries: lookups.map((id) => ({
      queryKey: ["offers", tenantId, "product-name", id] as const,
      enabled: Boolean(tenantId),
      staleTime: 60_000,
      retry: false,
      queryFn: async () => {
        const res = await consoleGetCatalogProduct(id);
        if (res.status >= 400 || !res.data) throw new Error("product-read");
        return res.data;
      },
    })),
  });
  const fetched = new Map<string, string>();
  lookups.forEach((id, index) => {
    const name = results[index]?.data?.summary.name;
    if (name) fetched.set(id, name);
  });
  return {
    nameOf: (id) => known[id] ?? fetched.get(id),
    unreadCount: Math.max(0, unknown.length - MAX_LOOKUPS),
  };
}
