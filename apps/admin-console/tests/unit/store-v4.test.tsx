import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

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
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useParams: () => ({ storeId: "s1" }) };
});
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: { active_tenant: { id: "t1", name: "Northstar Retail" } },
  }),
}));

import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { StoreDetail } from "@/stores/StoreDetail";
import { storeInitial } from "@/stores/StoreInitials";
import { StoreList } from "@/stores/StoreList";
import { storeCounts } from "@/stores/storeCounts";

function renderWith(ui: ReactNode): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The band's facts as «label → figure», read from the served `dl`. */
function bandFacts(): Record<string, string> {
  const dl = document.querySelector("dl.list-band__facts");
  if (!dl) return {};
  return Object.fromEntries(
    [...dl.querySelectorAll("div")].map((d) => [
      d.querySelector("dt")?.textContent ?? "",
      d.querySelector("dd")?.textContent ?? "",
    ]),
  );
}

/**
 * RT-1012 (v4.0): the store list band shows the whole roster's counts (the
 * list is unpaged), the rows carry the initials tile as decoration, and the
 * detail page numbers its sections in the board's order.
 */
describe("storeCounts (RT-1012)", () => {
  test("counts the full roster; a store with no flag is active, as its badge reads", () => {
    expect(storeCounts([{ is_active: true }, { is_active: false }, {}])).toEqual({
      total: 3,
      active: 2,
      suspended: 1,
    });
    expect(storeCounts([])).toEqual({ total: 0, active: 0, suspended: 0 });
  });
});

describe("storeInitial (RT-1012)", () => {
  test("is the first grapheme of the name, not a stripped word or half a pair", () => {
    expect(storeInitial("cairo mall")).toBe("C");
    expect(storeInitial("فرع المعادي")).toBe("ف");
    expect(storeInitial("😀 Shop")).toBe("😀");
    expect(storeInitial("  ")).toBe("?");
    expect(storeInitial(undefined)).toBe("?");
  });
});

describe("StoreList band facts (RT-1012)", () => {
  beforeEach(() => {
    listStores.mockReset();
    readStore.mockReset();
    act(() => setLocale("en"));
  });

  test("the three facts equal the full roster, a missing flag counting as active", async () => {
    listStores.mockResolvedValue({
      status: 200,
      data: [
        { id: "s1", code: "A", name: "Alpha", is_active: true, timezone: "Africa/Cairo" },
        { id: "s2", code: "B", name: "Beta", is_active: false, timezone: "Africa/Cairo" },
        { id: "s3", code: "C", name: "Gamma", timezone: "Africa/Cairo" },
      ],
    });
    renderWith(<StoreList />);
    await screen.findByText("Alpha");
    expect(bandFacts()).toEqual({
      Stores: "3",
      "Active stores": "2",
      "Suspended stores": "1",
    });
    expect(document.querySelector("dl.list-band__facts")?.getAttribute("aria-label")).toBe(
      "Store list summary",
    );
  });

  test("a failed read shows no facts (never a zero)", async () => {
    listStores.mockResolvedValue({ status: 500, error: { error: { request_id: "req-500" } } });
    renderWith(<StoreList />);
    await screen.findByRole("alert");
    expect(document.querySelector("dl.list-band__facts")).toBeNull();
  });

  test("while the read is pending there are no facts", () => {
    listStores.mockReturnValue(new Promise(() => {}));
    renderWith(<StoreList />);
    expect(document.querySelector("dl.list-band__facts")).toBeNull();
  });

  test("the initials tile is decoration: hidden from assistive tech, not text of the row", async () => {
    listStores.mockResolvedValue({
      status: 200,
      data: [{ id: "s1", code: "A", name: "Alpha", is_active: true }],
    });
    renderWith(<StoreList />);
    const name = await screen.findByText("Alpha");
    const tile = name.closest("td")?.querySelector(".store-initials");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    expect(tile?.textContent).toBe("");
    expect(tile?.getAttribute("data-initial")).toBe("A");
    expect(name.closest("td")?.textContent).toBe("Alpha");
  });

  test("Arabic: the facts are named in Arabic", async () => {
    act(() => setLocale("ar"));
    listStores.mockResolvedValue({
      status: 200,
      data: [{ id: "s1", code: "A", name: "Alpha", is_active: false }],
    });
    renderWith(<StoreList />);
    await screen.findByText("Alpha");
    expect(Object.keys(bandFacts())).toEqual(["متاجر", "متاجر نشطة", "متاجر موقوفة"]);
    act(() => setLocale("en"));
  });
});

describe("StoreDetail sections (RT-1012)", () => {
  beforeEach(() => {
    readStore.mockReset();
    act(() => setLocale("en"));
  });

  test("sections 01-04 in the board's order, each linking where its flow lives", async () => {
    readStore.mockResolvedValue({
      status: 200,
      data: { id: "s1", code: "CFC", name: "Cairo Festival City", is_active: true },
    });
    renderWith(<StoreDetail />);
    await screen.findByRole("heading", { name: "Cairo Festival City", level: 1 });

    const sections = [...document.querySelectorAll("section.detail-panel")];
    const index = (s: Element) => s.querySelector(".section-index")?.textContent;
    expect(sections.map(index)).toEqual(["01", "02", "03", "04"]);
    expect(sections.map((s) => s.querySelector("h2")?.textContent)).toEqual([
      "Store details",
      "Timing",
      "This store's devices",
      "Store status",
    ]);
    // The number is decoration beside the heading, never part of its name.
    for (const s of sections) {
      expect(s.querySelector(".section-index")?.getAttribute("aria-hidden")).toBe("true");
      expect(s.querySelector("h2")?.textContent).not.toMatch(/^\d/);
    }

    const edit = "/stores/s1/edit";
    const timing = within(sections[1] as HTMLElement).getByRole("link", {
      name: "Change time zone",
    });
    const status = within(sections[3] as HTMLElement).getByRole("link", {
      name: "Suspend or activate this store",
    });
    expect(timing.getAttribute("href")).toBe(edit);
    expect(status.getAttribute("href")).toBe(edit);
    expect(
      within(sections[2] as HTMLElement)
        .getByRole("link", { name: "Devices in this store" })
        .getAttribute("href"),
    ).toBe("/devices?store=s1");
  });

  test("the entity band keeps the one h1 and the one primary; the ornament is hidden", async () => {
    readStore.mockResolvedValue({
      status: 200,
      data: { id: "s1", code: "CFC", name: "Cairo Festival City", is_active: false },
    });
    renderWith(<StoreDetail />);
    await screen.findByRole("heading", { name: "Cairo Festival City", level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const hero = document.querySelector(".store-hero") as HTMLElement;
    expect(within(hero).getByRole("link", { name: "Edit store" }).className).toBe("btn-primary");
    expect(hero.querySelector(".store-hero__art")?.getAttribute("aria-hidden")).toBe("true");
    expect(hero.querySelector(".store-initials")?.getAttribute("aria-hidden")).toBe("true");
    // No fact the server does not serve: no device or open-shift counts.
    expect(hero.querySelector("dl")).toBeNull();
  });
});

describe("StoreDetail section 04 follows the state (RT-1012)", () => {
  test("a suspended store offers to activate, not to suspend", async () => {
    readStore.mockResolvedValue({
      status: 200,
      data: { id: "s1", code: "CFC", name: "Cairo Festival City", is_active: false },
    });
    renderWith(<StoreDetail />);
    await screen.findByRole("heading", { name: "Cairo Festival City", level: 1 });
    const status = document.querySelector("section.store-section--status") as HTMLElement;
    expect(within(status).getByRole("link", { name: "Activate this store" })).toBeDefined();
    expect(status.textContent).not.toMatch(/Suspending a store/);
  });
});
