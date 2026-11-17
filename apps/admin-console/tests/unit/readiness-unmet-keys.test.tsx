import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/inventory/useInventory", () => ({
  useInventoryScope: () => ({ tenantId: "t1" }),
  useStoreName: () => undefined,
}));

import { UnmetList } from "@/count-sessions/CountParts";

/**
 * RT-1440 (U1) A3: the readiness response can hold several `store_barrier_unprovable` entries for one
 * store, one per offending device or warehouse. Each row links to its own subject, so each needs its
 * own React key (a shared key reuses one row for two different links).
 */

const STORE = "0190f000-0000-7000-8000-0000000000a1";
const D1 = "0198a0c4-0000-7000-8000-000000000d01";
const D2 = "0198a0c4-0000-7000-8000-000000000d02";

describe("UnmetList keys", () => {
  afterEach(() => vi.restoreAllMocks());

  test("sibling boundaries with the same code and store but different subjects keep their own links and warn about no duplicate key", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <MemoryRouter>
        <UnmetList
          unmet={[
            {
              code: "store_barrier_unprovable",
              storeId: STORE,
              message: "x",
              subject: { deviceId: D1 },
            },
            {
              code: "store_barrier_unprovable",
              storeId: STORE,
              message: "x",
              subject: { deviceId: D2 },
            },
            {
              code: "store_barrier_unprovable",
              storeId: STORE,
              message: "x",
              subject: { warehouseRef: "Stores - RT" },
            },
          ]}
        />
      </MemoryRouter>,
    );
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([`/devices/${D1}`, `/devices/${D2}`, "/erp-connection/mappings"]);
    const keyWarnings = error.mock.calls.filter((c) => String(c[0]).includes("same key"));
    expect(keyWarnings).toEqual([]);
  });
});
