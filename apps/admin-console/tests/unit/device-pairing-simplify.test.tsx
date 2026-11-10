import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DUBAI_STORE, NEW_YORK_STORE, ctx, stores } from "./device-fixtures";
import { SECRET_CODE, SECRET_CODE_SHOWN, issued, pending } from "./device-pairing-fixtures";

/**
 * RT-1316 Phase 1 (Console): the issued code reads in groups of four, with a
 * barcode, Copy, Print for installer and the expiry; a plain pairing code can be
 * cancelled and replaced in one action. The code is still shown once and kept
 * nowhere else.
 */
const consoleListPairingCodes = vi.fn();
const consoleCancelPairingCode = vi.fn();
const consoleIssuePairingCode = vi.fn();
vi.mock("@/lib/device-queries", () => ({
  consoleListDevices: vi.fn(),
  consoleGetDevice: vi.fn(),
  consoleGetDeviceImpact: vi.fn(),
  consoleRevokeDevice: vi.fn(),
  consoleRetireDevice: vi.fn(),
  consoleListPairingCodes: (...a: unknown[]) => consoleListPairingCodes(...a),
  consoleCancelPairingCode: (...a: unknown[]) => consoleCancelPairingCode(...a),
  consoleIssuePairingCode: (...a: unknown[]) => consoleIssuePairingCode(...a),
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

import { PairingCodes } from "@/devices/PairingCodes";
import { createQueryClient } from "@/lib/query";

function renderPage(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/devices/pairing-codes"]}>
        <Routes>
          <Route path="/devices/pairing-codes" element={<PairingCodes />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const page = (items: unknown[]) => ({ status: 200, data: { items, nextCursor: null } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const drawer = () => screen.getByRole("dialog", { name: "Issue pairing code" });
const PLAIN = { kind: "pair", replacesDeviceId: null, storeId: DUBAI_STORE };

/** Fill the receipt details and issue: the drawer then shows the code. */
async function issueCode(): Promise<void> {
  const dialog = drawer();
  await within(dialog).findByRole("option", { name: "Dubai Mall" });
  fireEvent.change(within(dialog).getByLabelText("Store"), { target: { value: DUBAI_STORE } });
  for (const [label, value] of Object.entries({
    "Store name on receipts": "Receipt Branch",
    "Store address on receipts": "Level 1, Downtown",
    "Tax registration id": "TRN-100200300",
  })) {
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
  }
  fireEvent.click(within(dialog).getByRole("button", { name: "Issue pairing code" }));
  await within(dialog).findByText(SECRET_CODE_SHOWN);
}

beforeEach(() => {
  for (const fn of [
    consoleListPairingCodes,
    consoleCancelPairingCode,
    consoleIssuePairingCode,
    listStores,
    activeContext,
  ]) {
    fn.mockReset();
  }
  activeContext.mockReturnValue(ctx());
  listStores.mockResolvedValue({ status: 200, data: stores });
  consoleListPairingCodes.mockResolvedValue(page([pending(PLAIN)]));
  consoleIssuePairingCode.mockResolvedValue({ status: 201, data: issued(PLAIN) });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("the issue form (RT-1316 AC1)", () => {
  test("has no time-to-live field, and the issue sends none", async () => {
    renderPage();
    await screen.findByText("Counter 2");
    click("Issue pairing code");
    expect(within(drawer()).queryByLabelText(/Valid for/)).toBeNull();
    await issueCode();
    expect(consoleIssuePairingCode.mock.calls[0][0]).not.toHaveProperty("ttlMinutes");
  });
});

describe("the issued code (RT-1316 AC1, AC7)", () => {
  test("reads in groups of four, LTR and mono, with a barcode of the code as issued", async () => {
    renderPage();
    await screen.findByText("Counter 2");
    click("Issue pairing code");
    await issueCode();
    const shown = within(drawer()).getByText(SECRET_CODE_SHOWN);
    expect(shown.tagName).toBe("CODE");
    expect(shown.getAttribute("dir")).toBe("ltr");
    const barcode = within(drawer()).getByRole("img", { name: "Barcode of the pairing code" });
    // 16 characters: start, 16 data, check and stop symbols.
    expect(barcode.getAttribute("data-modules")).toBe(String(11 * 18 + 13));
    expect(barcode.querySelectorAll("rect").length).toBeGreaterThan(0);
    // The code is never in an accessible name.
    expect(barcode.getAttribute("aria-label")).not.toContain("FAKE");
  });

  test("whole hours read as hours", async () => {
    consoleIssuePairingCode.mockResolvedValue({
      status: 201,
      data: issued({
        ...PLAIN,
        createdAt: "2026-10-17T10:00:00Z",
        expiresAt: "2026-10-18T10:00:00Z",
      }),
    });
    renderPage();
    await screen.findByText("Counter 2");
    click("Issue pairing code");
    await issueCode();
    expect(within(drawer()).getByText(/Valid for 24 hours, until/)).toBeDefined();
  });

  test("Copy puts the code as issued on the clipboard and says so only after it is accepted", async () => {
    let accept: () => void = () => {};
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPage();
    await screen.findByText("Counter 2");
    click("Issue pairing code");
    await issueCode();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith(SECRET_CODE);
    expect(within(drawer()).queryByText("Code copied.")).toBeNull();
    accept();
    expect(await within(drawer()).findByText("Code copied.")).toBeDefined();
  });

  test("a refused or missing clipboard says the code was not copied", async () => {
    renderPage();
    await screen.findByText("Counter 2");
    click("Issue pairing code");
    await issueCode();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Copy code" }));
    expect(await within(drawer()).findByText(/could not be copied/)).toBeDefined();
    expect(within(drawer()).queryByText("Code copied.")).toBeNull();
  });

  test("Print for installer prints in place: the code, barcode, store, label and expiry only", async () => {
    let printed: Element | null = null;
    let sheetText = "";
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      printed = document.querySelector(".device-print-sheet");
      sheetText = printed?.textContent ?? "";
    });
    const open = vi.spyOn(window, "open");
    renderPage();
    await screen.findByText("Counter 2");
    click("Issue pairing code");
    await issueCode();
    // Not in the page until printing.
    expect(document.querySelector(".device-print-sheet")).toBeNull();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Print for installer" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(open).not.toHaveBeenCalled();
    expect(printed).not.toBeNull();
    expect(sheetText).toContain(SECRET_CODE_SHOWN);
    expect(sheetText).toContain("Dubai Mall");
    expect(sheetText).toContain("Counter 2");
    expect(sheetText).toMatch(/The code expires at/);
    expect((printed as unknown as Element).querySelector("svg[role=img]")).not.toBeNull();
    expect((printed as unknown as Element).querySelector("time")).not.toBeNull();
    // No receipt details, no replace note.
    for (const absent of ["TRN-100200300", "Level 1, Downtown", "Receipt Branch", "REPLACEMENT"]) {
      expect(sheetText).not.toContain(absent);
    }
    // print() returning is not the end of printing in every browser: the sheet
    // stays until the browser says printing is over, then leaves the page.
    expect(document.querySelector(".device-print-sheet")).not.toBeNull();
    fireEvent(window, new Event("afterprint"));
    await waitFor(() => expect(document.querySelector(".device-print-sheet")).toBeNull());
  });

  test("nothing keeps the code once the drawer closes, in either form", async () => {
    renderPage();
    await screen.findByText("Counter 2");
    click("Issue pairing code");
    await issueCode();
    for (const form of [SECRET_CODE, SECRET_CODE_SHOWN]) {
      expect(document.title).not.toContain(form);
      expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(form);
      expect(window.location.href).not.toContain(form);
    }
    click("Done");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    for (const form of [SECRET_CODE, SECRET_CODE_SHOWN]) {
      expect(document.body.innerHTML).not.toContain(form);
    }
  });
});

describe("cancel and issue a new code (RT-1316 AC2)", () => {
  const cancelled = {
    status: 200,
    data: { outcome: "cancelled", pairingCode: pending({ ...PLAIN, status: "cancelled" }) },
  };

  test("a plain pairing code: one confirm cancels it, then the drawer opens for the same store and label", async () => {
    consoleCancelPairingCode.mockResolvedValue(cancelled);
    renderPage();
    await screen.findByText("Counter 2");
    click("Cancel and issue new code");
    const confirm = screen.getByRole("group", { name: "Cancel and issue new code" });
    expect(confirm.textContent).toMatch(/The old code stops working first/);
    expect(consoleCancelPairingCode).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel and issue new code" }));
    await waitFor(() =>
      expect(consoleCancelPairingCode).toHaveBeenCalledWith(pending().pairingCodeId),
    );
    const dialog = await screen.findByRole("dialog", { name: "Issue pairing code" });
    await within(dialog).findByRole("option", { name: "Dubai Mall" });
    expect((within(dialog).getByLabelText("Store") as HTMLSelectElement).value).toBe(DUBAI_STORE);
    expect(
      (within(dialog).getByLabelText("New terminal's label (optional)") as HTMLInputElement).value,
    ).toBe("Counter 2");
    // The receipt details are typed again: the list never carries them.
    expect(
      (within(dialog).getByLabelText("Store name on receipts") as HTMLInputElement).value,
    ).toBe("");
    expect(consoleIssuePairingCode).not.toHaveBeenCalled();
    // Focus is in the drawer, not left behind the modal on the page.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // Closing it lands on the codes region, never the page body (the confirm is gone).
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.classList.contains("device-codes-region")).toBe(true);
  });

  test("while the cancel is pending a new issue cannot be opened beside it", async () => {
    let answer: (value: unknown) => void = () => {};
    consoleCancelPairingCode.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderPage();
    await screen.findByText("Counter 2");
    click("Cancel and issue new code");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Cancel and issue new code" })).getByRole("button", {
        name: "Cancel and issue new code",
      }),
    );
    await waitFor(() => expect(consoleCancelPairingCode).toHaveBeenCalledTimes(1));
    const header = screen.getByRole("button", { name: "Issue pairing code" }) as HTMLButtonElement;
    expect(header.disabled).toBe(true);
    answer(cancelled);
    expect(await screen.findByRole("dialog", { name: "Issue pairing code" })).toBeDefined();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  test("already_cancelled also opens the new issue", async () => {
    consoleCancelPairingCode.mockResolvedValue({
      ...cancelled,
      data: { ...cancelled.data, outcome: "already_cancelled" },
    });
    renderPage();
    await screen.findByText("Counter 2");
    click("Cancel and issue new code");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Cancel and issue new code" })).getByRole("button", {
        name: "Cancel and issue new code",
      }),
    );
    expect(await screen.findByRole("dialog", { name: "Issue pairing code" })).toBeDefined();
  });

  test.each([
    [409, "pairing_code_used", /already used, so it can't be cancelled/],
    [500, "system_failure", /could not be cancelled/],
  ])(
    "a %s on the cancel (%s) is explained and no new issue opens",
    async (status, code, message) => {
      consoleCancelPairingCode.mockResolvedValue({
        status,
        error: { error: { code, message: "x", request_id: "req-c" } },
      });
      renderPage();
      await screen.findByText("Counter 2");
      click("Cancel and issue new code");
      fireEvent.click(
        within(screen.getByRole("group", { name: "Cancel and issue new code" })).getByRole(
          "button",
          { name: "Cancel and issue new code" },
        ),
      );
      await waitFor(() => expect(consoleCancelPairingCode).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(message)).toBeDefined();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  test("an unanswered cancel opens no new issue", async () => {
    consoleCancelPairingCode.mockRejectedValue(new TypeError("network"));
    renderPage();
    await screen.findByText("Counter 2");
    click("Cancel and issue new code");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Cancel and issue new code" })).getByRole("button", {
        name: "Cancel and issue new code",
      }),
    );
    expect(await screen.findByText(/could not be cancelled/)).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a replace or move code is not offered it: a plain reissue would no longer revoke the device", async () => {
    consoleListPairingCodes.mockResolvedValue(
      page([
        pending({ pairingCodeId: "c-replace", terminalLabel: "Counter 5" }),
        pending({
          pairingCodeId: "c-move",
          kind: "move",
          storeId: NEW_YORK_STORE,
          terminalLabel: "Counter 6",
        }),
      ]),
    );
    renderPage();
    await screen.findByText("Counter 6");
    expect(screen.queryByRole("button", { name: "Cancel and issue new code" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Cancel code" })).toHaveLength(2);
  });

  test("a plain cancel still only cancels", async () => {
    consoleCancelPairingCode.mockResolvedValue(cancelled);
    renderPage();
    await screen.findByText("Counter 2");
    click("Cancel code");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Cancel code" })).getByRole("button", {
        name: "Cancel code",
      }),
    );
    expect(await screen.findByText("The code is cancelled.")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
