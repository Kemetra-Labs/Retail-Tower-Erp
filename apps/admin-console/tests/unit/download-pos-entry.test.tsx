import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ctx, stores } from "./device-fixtures";

vi.mock("@/lib/device-queries", () => ({
  consoleListDevices: vi
    .fn()
    .mockResolvedValue({ status: 200, data: { items: [], nextCursor: null } }),
  consoleGetDevice: vi.fn(),
}));
// RT-1312: the sale-queue read has its own suite (device-sale-queue.test.tsx); here it is
// refused (404), which reads as unavailable and adds no banner.
vi.mock("@/lib/device-health-queries", () => ({
  consoleListDeviceHealth: () => Promise.resolve({ status: 404 }),
  consoleGetDeviceHealth: () => Promise.resolve({ status: 404 }),
}));
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listStores: (...a: unknown[]) => listStores(...a) };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));
const consolePilotGetLatestPosRelease = vi.fn();
vi.mock("@/lib/pilot-release-queries", () => ({
  consolePilotGetLatestPosRelease: (...a: unknown[]) => consolePilotGetLatestPosRelease(...a),
}));

import { DeviceList } from "@/devices/DeviceList";
import { t } from "@/i18n";
import { createQueryClient } from "@/lib/query";
import { deviceRoutes } from "@/shell/deviceRoutes";

function renderList(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/devices"]}>
        <Routes>
          <Route path="/devices" element={<DeviceList />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Devices header entry to Download POS (RT-1304 D-2, AC 4)", () => {
  beforeEach(() => {
    activeContext.mockReset();
    consolePilotGetLatestPosRelease.mockReset();
    listStores.mockResolvedValue({ status: 200, data: stores });
  });

  test.each(["owner", "tenant_admin", "store_manager"])(
    "%s sees the link beside Pairing codes, and opening the list makes no resolver call",
    async (role) => {
      activeContext.mockReturnValue(ctx(role));
      renderList();
      const link = await screen.findByRole("link", { name: t("devices.download.title") });
      expect(link.getAttribute("href")).toBe("/devices/download-pos");
      expect(link.className).toContain("btn-secondary");
      expect(screen.getByRole("link", { name: t("devices.list.pairingCodes") })).toBeTruthy();
      expect(consolePilotGetLatestPosRelease).not.toHaveBeenCalled();
    },
  );

  test("the route is registered before the :deviceId catch, so it is never read as a device id", () => {
    const paths: string[] = [];
    const collect = (node: unknown): void => {
      const el = node as { props?: { path?: string; children?: unknown } } | null;
      if (!el || typeof el !== "object") return;
      if (el.props?.path) paths.push(el.props.path);
      for (const child of [el.props?.children].flat()) collect(child);
    };
    collect(deviceRoutes);
    expect(paths).toContain("devices/download-pos");
    expect(paths.indexOf("devices/download-pos")).toBeLessThan(paths.indexOf("devices/:deviceId"));
  });
});
