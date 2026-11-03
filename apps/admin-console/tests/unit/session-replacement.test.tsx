import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/client", () => ({
  getActiveContext: vi.fn(),
  switchActiveTenant: vi.fn(),
  switchActiveStore: vi.fn(),
  clearActiveStore: vi.fn(),
  refreshSession: vi.fn(),
}));

import { ActiveContextProvider, useActiveContextValue } from "@/context/ActiveContextProvider";
import * as client from "@/lib/client";
import { createQueryClient } from "@/lib/query";

const user = (id: string) => ({
  status: 200,
  data: {
    user: { id, email: `${id}@b.co`, is_platform_admin: false },
    active_tenant: { id: "t1", name: "Northstar" },
    active_store: null,
    active_role_code: "tenant_admin",
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar" }],
  },
});

const readData = vi.fn();
const renderedData: Array<{ principal: string | undefined; value: string }> = [];

function DataScreen({ principal }: { principal: string | undefined }): React.JSX.Element {
  const q = useQuery({
    queryKey: ["sales", "list"],
    queryFn: async () => {
      readData();
      return "fresh";
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const value = q.data ?? "none";
  renderedData.push({ principal, value });
  return <div data-testid="data">{value}</div>;
}

let refreshCtx: () => Promise<void>;
function Probe(): React.JSX.Element {
  const { refresh, context } = useActiveContextValue();
  refreshCtx = refresh;
  return (
    <>
      <div data-testid="who">{context?.user?.id ?? "nobody"}</div>
      <DataScreen principal={context?.user?.id} />
    </>
  );
}

function setup() {
  const qc = createQueryClient();
  renderedData.length = 0;
  qc.setQueryData(["sales", "list"], "A-private");
  render(
    <QueryClientProvider client={qc}>
      <ActiveContextProvider>
        <Probe />
      </ActiveContextProvider>
    </QueryClientProvider>,
  );
  return qc;
}

describe("session replacement without sign-out (RT-1077)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("A expires, B signs in: none of A's cached reads reach B", async () => {
    vi.mocked(client.getActiveContext)
      .mockResolvedValueOnce(user("A") as never)
      .mockResolvedValueOnce({ status: 401 } as never)
      .mockResolvedValueOnce(user("B") as never);
    vi.mocked(client.refreshSession).mockResolvedValue({ status: 401 } as never);
    const qc = setup();
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("A"));
    expect(screen.getByTestId("data").textContent).toBe("A-private");
    renderedData.length = 0;

    await act(() => refreshCtx()); // A's session is gone (expiry)
    await act(() => refreshCtx()); // B signs in on the same tab

    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("fresh"));
    expect(renderedData).not.toContainEqual({ principal: "B", value: "A-private" });
    expect(readData).toHaveBeenCalled();
    expect(qc.getQueryData(["sales", "list"])).toBe("fresh");
  });

  test("the same user re-authenticating keeps the cache: no flash, no refetch", async () => {
    vi.mocked(client.getActiveContext)
      .mockResolvedValueOnce(user("A") as never)
      .mockResolvedValueOnce({ status: 401 } as never)
      .mockResolvedValueOnce(user("A") as never);
    vi.mocked(client.refreshSession).mockResolvedValue({ status: 401 } as never);
    setup();
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("A"));
    expect(screen.getByTestId("data").textContent).toBe("A-private");

    await act(() => refreshCtx());
    await act(() => refreshCtx());

    expect(screen.getByTestId("data").textContent).toBe("A-private");
    expect(readData).not.toHaveBeenCalled();
  });
});
