import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { AccessLimitedBanner } from "@/shell/AccessLimitedBanner";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-1350 slice 5a: the "limited until activated" banner. The server decides the
 * state (RT-1353); the Console only shows it. Roles without the read (store_staff,
 * cashiers) never send the request. Any failure is silence, never a false banner.
 */
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
let role: string | undefined = "owner";
let activeTenant: string | undefined = TENANT_ID;
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: { active_tenant: { id: activeTenant }, active_role_code: role },
  }),
}));

const read = vi.fn();
vi.mock("@/lib/tenant-access-queries", () => ({
  consoleGetTenantAccessEntitlement: (...a: unknown[]) => read(...a),
}));

const state = (over: Record<string, unknown> = {}) => ({
  status: 200,
  data: {
    tenant_id: TENANT_ID,
    state: "restricted",
    unlock_requested_at: null,
    provisioned_at: null,
    ...over,
  },
});

function renderBanner() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AccessLimitedBanner />
    </QueryClientProvider>,
  );
}

/**
 * Wait until the read was made AND its query settled and re-rendered, so a "shows
 * nothing" assertion runs after the banner could have appeared (a bare
 * `waitFor(read called)` returns as soon as queryFn starts, before any state update).
 */
async function settled(): Promise<void> {
  await waitFor(() => expect(read).toHaveBeenCalled());
  await act(async () => {
    await Promise.allSettled(read.mock.results.map((r) => r.value));
    await new Promise((done) => setTimeout(done, 0));
  });
}

function expectNoBanner(container: HTMLElement): void {
  expect(screen.queryByRole("status")).toBeNull();
  expect(container.textContent).toBe("");
}

beforeEach(() => {
  role = "owner";
  activeTenant = TENANT_ID;
  read.mockReset();
  setLocale("en");
});
afterEach(cleanup);

describe("AccessLimitedBanner", () => {
  test("restricted tenant shows the limited banner", async () => {
    read.mockResolvedValue(state());
    renderBanner();
    expect(await screen.findByText(/limited until it is activated/i)).toBeTruthy();
    expect(read).toHaveBeenCalledWith(TENANT_ID);
  });

  test("restricted with an unlock requested says activation is under way", async () => {
    read.mockResolvedValue(state({ unlock_requested_at: "2026-11-13T10:00:00Z" }));
    renderBanner();
    expect(await screen.findByText(/activation has been requested/i)).toBeTruthy();
  });

  test("unrestricted tenant shows nothing", async () => {
    read.mockResolvedValue(state({ state: "unrestricted" }));
    const { container } = renderBanner();
    await settled();
    expectNoBanner(container);
  });

  test.each([404, 429, 500, 0])("a %i answer shows nothing", async (status) => {
    read.mockResolvedValue({ status, data: undefined });
    const { container } = renderBanner();
    await settled();
    expectNoBanner(container);
  });

  test("a thrown read shows nothing", async () => {
    read.mockRejectedValue(new Error("offline"));
    const { container } = renderBanner();
    await settled();
    expectNoBanner(container);
  });

  test("a body that is not the contract shape shows nothing", async () => {
    read.mockResolvedValue({ status: 200, data: { state: "weird" } });
    const { container } = renderBanner();
    await settled();
    expectNoBanner(container);
  });

  test.each(["store_staff", "cashier", undefined])("role %s never asks", (r) => {
    role = r;
    const { container } = renderBanner();
    expect(read).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  test("no active tenant never asks", () => {
    activeTenant = undefined;
    renderBanner();
    expect(read).not.toHaveBeenCalled();
  });

  test.each(["owner", "tenant_admin", "store_manager"])("role %s asks", async (r) => {
    role = r;
    read.mockResolvedValue(state());
    renderBanner();
    await waitFor(() => expect(read).toHaveBeenCalledWith(TENANT_ID));
  });

  test("Arabic copy", async () => {
    setLocale("ar");
    read.mockResolvedValue(state());
    renderBanner();
    expect(await screen.findByText(/محدودة/)).toBeTruthy();
  });
});
