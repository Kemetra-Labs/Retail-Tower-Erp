import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEVICE_1,
  DEVICE_2,
  DEVICE_3,
  DUBAI_STORE,
  ctx,
  detail,
  failure,
  page,
  stores,
  summary,
} from "./device-fixtures";
import {
  HEARTBEAT_AT,
  OLDEST_PENDING_AT,
  health,
  healthPage,
  neverBeat,
  saleQueue,
} from "./device-health-fixtures";

const consoleListDevices = vi.fn();
const consoleGetDevice = vi.fn();
vi.mock("@/lib/device-queries", () => ({
  consoleListDevices: (...a: unknown[]) => consoleListDevices(...a),
  consoleGetDevice: (...a: unknown[]) => consoleGetDevice(...a),
}));
const consoleListDeviceHealth = vi.fn();
const consoleGetDeviceHealth = vi.fn();
vi.mock("@/lib/device-health-queries", () => ({
  consoleListDeviceHealth: (...a: unknown[]) => consoleListDeviceHealth(...a),
  consoleGetDeviceHealth: (...a: unknown[]) => consoleGetDeviceHealth(...a),
}));
const listStores = vi.fn();
const readStore = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return {
    ...actual,
    listStores: (...a: unknown[]) => listStores(...a),
    readStore: (...a: unknown[]) => readStore(...a),
  };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { DeviceDetail } from "@/devices/DeviceDetail";
import { DeviceList } from "@/devices/DeviceList";
import { createQueryClient } from "@/lib/query";

function renderAt(entry: string): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/devices" element={<DeviceList />} />
          <Route path="/devices/:deviceId" element={<DeviceDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function tableReady(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getByRole("table").getAttribute("aria-busy")).not.toBe("true");
  });
  return screen.getByRole("table");
}

/** The row's cell under a column header, by the header's name. */
function cell(row: HTMLElement, header: string): HTMLElement {
  const headers = within(screen.getByRole("table")).getAllByRole("columnheader");
  const index = headers.findIndex((h) => h.textContent === header);
  return within(row).getAllByRole("cell")[index];
}

function bodyRow(label: string): HTMLElement {
  return screen.getByText(label).closest("tr") as HTMLElement;
}

/** A field row's value by its label (the detail ledger). */
function field(label: string): HTMLElement {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

const timeOf = (el: HTMLElement, iso: string) => el.querySelector(`time[datetime="${iso}"]`);

describe("Devices list: the till's unsent sales (RT-1312)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeContext.mockReturnValue(ctx());
    listStores.mockResolvedValue({ status: 200, data: stores });
    consoleListDevices.mockResolvedValue(page([summary()]));
    consoleListDeviceHealth.mockResolvedValue(healthPage([health()]));
  });

  test("a device whose sale queue is null reads Unknown, never 0", async () => {
    consoleListDeviceHealth.mockResolvedValue(healthPage([health({ saleQueue: null })]));
    renderAt("/devices");
    await tableReady();
    const value = cell(bodyRow("Till 1"), "Unsent sales");
    await waitFor(() => expect(within(value).getByText("Unknown")).toBeDefined());
    expect(within(value).getByText("Unknown").className).toContain("device-flag--danger");
    expect(value.textContent).not.toMatch(/\b0\b/);
  });

  test("a device that never beat reads Unknown with no as-of time", async () => {
    consoleListDeviceHealth.mockResolvedValue(healthPage([neverBeat()]));
    renderAt("/devices");
    await tableReady();
    const value = cell(bodyRow("Till 1"), "Unsent sales");
    await waitFor(() => expect(within(value).getByText("Unknown")).toBeDefined());
    expect(value.querySelector("time")).toBeNull();
  });

  test("the counts render with the oldest pending time and the as-of heartbeat time", async () => {
    consoleListDeviceHealth.mockResolvedValue(
      healthPage([
        health({
          saleQueue: saleQueue({
            pending: 3,
            deadLetter: 1,
            heldPreviousPairing: 2,
            oldestPendingAt: OLDEST_PENDING_AT,
          }),
        }),
      ]),
    );
    renderAt("/devices");
    await tableReady();
    const value = cell(bodyRow("Till 1"), "Unsent sales");
    await waitFor(() => expect(within(value).getByText("Pending: 3")).toBeDefined());
    expect(within(value).getByText("Refused: 1")).toBeDefined();
    expect(within(value).getByText("Held from an earlier pairing: 2")).toBeDefined();
    expect(within(value).getByText(/Oldest pending:/)).toBeDefined();
    expect(timeOf(value, OLDEST_PENDING_AT)).not.toBeNull();
    expect(within(value).getByText(/As of last heartbeat:/)).toBeDefined();
    expect(timeOf(value, HEARTBEAT_AT)).not.toBeNull();
  });

  test("an empty queue shows zero counts (a known zero) and no oldest pending time", async () => {
    renderAt("/devices");
    await tableReady();
    const value = cell(bodyRow("Till 1"), "Unsent sales");
    await waitFor(() => expect(within(value).getByText("Pending: 0")).toBeDefined());
    expect(within(value).queryByText(/Oldest pending:/)).toBeNull();
  });

  test("dead letter > 0 flags the row for attention, in the danger role", async () => {
    consoleListDeviceHealth.mockResolvedValue(
      healthPage([health({ saleQueue: saleQueue({ deadLetter: 1 }) })]),
    );
    renderAt("/devices");
    await tableReady();
    const row = bodyRow("Till 1");
    const attention = cell(row, "Needs attention");
    await waitFor(() =>
      expect(within(attention).getByText("Stranded sales on the till")).toBeDefined(),
    );
    expect(within(attention).getByText("Stranded sales on the till").className).toContain(
      "device-flag--danger",
    );
    expect(within(attention).queryByText("No recorded exception")).toBeNull();
    expect(within(cell(row, "Unsent sales")).getByText("Refused: 1").className).toContain(
      "device-flag--danger",
    );
  });

  test("held from an earlier pairing > 0 flags the row for attention", async () => {
    consoleListDeviceHealth.mockResolvedValue(
      healthPage([health({ saleQueue: saleQueue({ heldPreviousPairing: 4 }) })]),
    );
    renderAt("/devices");
    await tableReady();
    const attention = cell(bodyRow("Till 1"), "Needs attention");
    await waitFor(() =>
      expect(within(attention).getByText("Stranded sales on the till")).toBeDefined(),
    );
  });

  test("pending only is not flagged for attention", async () => {
    consoleListDeviceHealth.mockResolvedValue(
      healthPage([health({ saleQueue: saleQueue({ pending: 7 }) })]),
    );
    renderAt("/devices");
    await tableReady();
    const row = bodyRow("Till 1");
    await waitFor(() =>
      expect(within(cell(row, "Unsent sales")).getByText("Pending: 7")).toBeDefined(),
    );
    expect(within(cell(row, "Needs attention")).getByText("No recorded exception")).toBeDefined();
  });

  test.each([404, 403])(
    "a %i on the health read keeps the page and shows the counts as unavailable",
    async (status) => {
      consoleListDeviceHealth.mockResolvedValue(failure(status));
      renderAt("/devices");
      await tableReady();
      const value = cell(bodyRow("Till 1"), "Unsent sales");
      await waitFor(() => expect(within(value).getByText("Unavailable")).toBeDefined());
      expect(within(value).queryByText("Unknown")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("Till 1")).toBeDefined();
    },
  );

  test("any other health failure keeps the rows and offers a retry in a warning", async () => {
    consoleListDeviceHealth.mockResolvedValueOnce(failure(500, "req-h"));
    renderAt("/devices");
    await tableReady();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Could not load the unsent sale counts/)).toBeDefined();
    expect(within(cell(bodyRow("Till 1"), "Unsent sales")).getByText("Unavailable")).toBeDefined();
    within(alert).getByRole("button", { name: "Retry" }).click();
    await waitFor(() =>
      expect(within(cell(bodyRow("Till 1"), "Unsent sales")).getByText("Pending: 0")).toBeDefined(),
    );
  });

  test.each([400, 401, 500])(
    "a list failure (%i) shows only the list's own banner, not a second health banner",
    async (status) => {
      consoleListDevices.mockResolvedValue(failure(status, "req-list"));
      consoleListDeviceHealth.mockResolvedValue(failure(status, "req-h"));
      renderAt("/devices");
      await waitFor(() => expect(consoleListDeviceHealth).toHaveBeenCalled());
      expect(await screen.findByRole("alert")).toBeDefined();
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByText(/Could not load the unsent sale counts/)).toBeNull();
    },
  );

  test("joins by deviceId across health pages, whatever the order", async () => {
    consoleListDevices.mockResolvedValue(
      page([
        summary({ deviceId: DEVICE_2, label: "Till 2" }),
        summary({ deviceId: DEVICE_1, label: "Till 1" }),
        summary({ deviceId: DEVICE_3, label: "Till 3" }),
      ]),
    );
    consoleListDeviceHealth
      .mockResolvedValueOnce(
        healthPage(
          [
            health({ deviceId: DEVICE_1, saleQueue: saleQueue({ pending: 1 }) }),
            health({ deviceId: DEVICE_2, saleQueue: saleQueue({ pending: 2 }) }),
          ],
          "next-1",
        ),
      )
      .mockResolvedValueOnce(
        healthPage([health({ deviceId: DEVICE_3, saleQueue: saleQueue({ pending: 3 }) })]),
      );
    renderAt(`/devices?store=${DUBAI_STORE}&state=active`);
    await tableReady();
    await waitFor(() =>
      expect(within(cell(bodyRow("Till 3"), "Unsent sales")).getByText("Pending: 3")).toBeDefined(),
    );
    expect(within(cell(bodyRow("Till 1"), "Unsent sales")).getByText("Pending: 1")).toBeDefined();
    expect(within(cell(bodyRow("Till 2"), "Unsent sales")).getByText("Pending: 2")).toBeDefined();
    // The health read carries the list's own filters, so both answer the same scope.
    expect(consoleListDeviceHealth).toHaveBeenNthCalledWith(1, {
      store_id: DUBAI_STORE,
      trust_state: "active",
      page_size: 200,
    });
    expect(consoleListDeviceHealth).toHaveBeenNthCalledWith(2, {
      store_id: DUBAI_STORE,
      trust_state: "active",
      page_size: 200,
      cursor: "next-1",
    });
  });

  test("a device with no health row reads unavailable, not Unknown", async () => {
    consoleListDeviceHealth.mockResolvedValue(healthPage([health({ deviceId: DEVICE_3 })]));
    renderAt("/devices");
    await tableReady();
    const value = cell(bodyRow("Till 1"), "Unsent sales");
    await waitFor(() => expect(within(value).getByText("Unavailable")).toBeDefined());
  });
});

describe("Device detail Overview: the till's unsent sales (RT-1312)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeContext.mockReturnValue(ctx());
    readStore.mockResolvedValue({ status: 200, data: stores[0] });
    consoleGetDevice.mockResolvedValue({ status: 200, data: detail() });
    consoleGetDeviceHealth.mockResolvedValue({
      status: 200,
      data: health({
        saleQueue: saleQueue({
          pending: 5,
          deadLetter: 2,
          heldPreviousPairing: 1,
          oldestPendingAt: OLDEST_PENDING_AT,
        }),
      }),
    });
  });

  test("shows each count, the oldest pending sale and the as-of heartbeat time", async () => {
    renderAt(`/devices/${DEVICE_1}`);
    await screen.findByRole("heading", { level: 1, name: "Till 1" });
    await waitFor(() => expect(field("Pending").textContent).toBe("5"));
    expect(field("Refused").textContent).toBe("2");
    expect(field("Refused").querySelector(".device-flag--danger")).not.toBeNull();
    expect(field("Held from an earlier pairing").textContent).toBe("1");
    expect(timeOf(field("Oldest pending sale"), OLDEST_PENDING_AT)).not.toBeNull();
    expect(timeOf(field("As of last heartbeat"), HEARTBEAT_AT)).not.toBeNull();
    expect(screen.getByText("Stranded sales on the till")).toBeDefined();
    expect(consoleGetDeviceHealth).toHaveBeenCalledWith(DEVICE_1);
  });

  test("a null sale queue reads Unknown, never 0", async () => {
    consoleGetDeviceHealth.mockResolvedValue({ status: 200, data: health({ saleQueue: null }) });
    renderAt(`/devices/${DEVICE_1}`);
    await screen.findByRole("heading", { level: 1, name: "Till 1" });
    await waitFor(() => expect(field("Unsent sales").textContent).toBe("Unknown"));
    expect(screen.queryByText("Pending", { selector: "dt" })).toBeNull();
  });

  test.each([404, 403])(
    "a %i on the health read keeps the device page and reads unavailable",
    async (status) => {
      consoleGetDeviceHealth.mockResolvedValue(failure(status));
      renderAt(`/devices/${DEVICE_1}`);
      await screen.findByRole("heading", { level: 1, name: "Till 1" });
      await waitFor(() => expect(field("Unsent sales").textContent).toBe("Unavailable"));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(field("Device ID").textContent).toBe(DEVICE_1);
    },
  );
});
