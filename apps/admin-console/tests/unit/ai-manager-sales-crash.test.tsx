import { ManagerSalesMount } from "@/ai-manager-sales/ManagerSalesMount";
import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { STORES, TENANT_ID } from "./ai-manager-sales-fixtures";

/**
 * RT-1541: the panel is OPTIONAL_DEGRADE. When it crashes while rendering, the page around it
 * (the base KPIs) is unaffected and the person sees one quiet line, never the error.
 */
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: { active_tenant: { id: TENANT_ID }, active_role_code: "owner" },
  }),
}));
vi.mock("@/shift-closes/useShiftCloses", () => ({
  useStoreDirectory: () => ({ stores: STORES, ready: true }),
}));
vi.mock("@/ai-manager-sales/ManagerSalesPanel", () => ({
  ManagerSalesPanel: () => {
    throw new Error("render boom 1250.5000");
  },
}));
const report = vi.fn();
vi.mock("@/observability/report", () => ({ reportError: (...a: unknown[]) => report(...a) }));

beforeEach(() => {
  setLocale("en");
  report.mockReset();
});
afterEach(() => cleanup());

test("a throwing panel renders one quiet line, leaves its siblings alone and reports no figure", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <QueryClientProvider client={createQueryClient()}>
      <p>base KPI</p>
      <ManagerSalesMount enabled />
    </QueryClientProvider>,
  );
  expect(
    screen.getByText("The assistant is paused for now. Sales reports work as usual."),
  ).toBeTruthy();
  expect(screen.getByText("base KPI")).toBeTruthy();
  expect(document.body.textContent).not.toContain("render boom");
  // The original error (which could carry a figure) is never forwarded.
  expect(report).toHaveBeenCalledTimes(1);
  expect(String(report.mock.calls[0][0])).not.toContain("1250.5000");
  spy.mockRestore();
});
