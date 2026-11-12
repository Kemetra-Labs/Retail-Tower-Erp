import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-455 part 2 (item 4): the tracking profile on the product page, read only.
 * It shows for a tracked product only, only while the tenant's tracked-selling
 * switch is on (OD-T4), and a failed read says so instead of showing a default.
 */
const getProfile = vi.fn();
vi.mock("@/lib/tracking-queries", () => ({
  getTrackingProfile: (...a: unknown[]) => getProfile(...a),
}));
const getTrackedSelling = vi.fn();
vi.mock("@/lib/tracked-selling-queries", () => ({
  getTrackedSellingSetting: (...a: unknown[]) => getTrackedSelling(...a),
}));

import { TrackingProfileSection } from "@/catalog/TrackingProfileSection";
import { createQueryClient } from "@/lib/query";

const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const ON = {
  status: 200,
  data: {
    enabled: true,
    changedAt: null,
    changedBy: null,
    preconditionsMet: true,
    unmetPreconditions: [],
  },
};
const profile = (locked: boolean) => ({
  status: 200,
  data: {
    product_id: PRODUCT,
    tracking_mode: "batch",
    expiry_required: true,
    profile_locked: locked,
  },
});

function renderSection(mode: string, role = "owner"): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TrackingProfileSection productId={PRODUCT} trackingMode={mode} tenantId="t1" role={role} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getProfile.mockReset();
  getTrackedSelling.mockReset();
  getTrackedSelling.mockResolvedValue(ON);
});
afterEach(cleanup);

describe("tracking profile section", () => {
  test("shows the server's values read only, with the locked note", async () => {
    getProfile.mockResolvedValue(profile(true));
    renderSection("batch");
    const fields = await screen.findByTestId("catalog-tracking-profile");
    expect(fields.textContent).toContain("By batch");
    expect(fields.textContent).toContain("Yes");
    expect(await screen.findByText(/no longer changes/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("an untracked product reads nothing and shows nothing", async () => {
    renderSection("none");
    await waitFor(() => expect(getTrackedSelling).not.toHaveBeenCalled());
    expect(getProfile).not.toHaveBeenCalled();
    expect(screen.queryByText("Tracking profile")).toBeNull();
  });

  test("with the switch off (or the gate's 404) nothing is read", async () => {
    getTrackedSelling.mockResolvedValue({ status: 404, error: { error: { code: "not_found" } } });
    renderSection("batch");
    await waitFor(() => expect(getTrackedSelling).toHaveBeenCalled());
    expect(getProfile).not.toHaveBeenCalled();
    expect(screen.queryByText("Tracking profile")).toBeNull();
  });

  test("a failed read says so, never a default, and retries", async () => {
    getProfile
      .mockResolvedValueOnce({ status: 500, error: {} })
      .mockResolvedValueOnce(profile(false));
    renderSection("serial");
    expect(await screen.findByText("The tracking profile could not be loaded.")).toBeTruthy();
    expect(screen.queryByTestId("catalog-tracking-profile")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("catalog-tracking-profile")).toBeTruthy();
  });
});
