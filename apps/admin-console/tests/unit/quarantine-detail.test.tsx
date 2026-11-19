import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEVICE,
  QUARANTINE_REF,
  REQUEST_ID,
  SALE,
  STORE,
  ctx,
  failure,
  ok,
  quarantined,
} from "./sale-quarantine-fixtures";

const api = {
  consoleListQuarantinedSales: vi.fn(),
  consoleGetQuarantinedSale: vi.fn(),
  consoleWriteOffQuarantinedSale: vi.fn(),
};
vi.mock("@/lib/sale-quarantine-queries", () => ({
  consoleListQuarantinedSales: (...a: unknown[]) => api.consoleListQuarantinedSales(...a),
  consoleGetQuarantinedSale: (...a: unknown[]) => api.consoleGetQuarantinedSale(...a),
  consoleWriteOffQuarantinedSale: (...a: unknown[]) => api.consoleWriteOffQuarantinedSale(...a),
}));
const readStore = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, readStore: (...a: unknown[]) => readStore(...a) };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";
import { QuarantineDetail } from "@/sale-quarantine/QuarantineDetail";

function renderDetail(ref = QUARANTINE_REF, client = createQueryClient()): void {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/quarantined-sales/${ref}`]}>
        <Routes>
          <Route path="/quarantined-sales/:quarantineRef" element={<QuarantineDetail />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function field(scope: HTMLElement, label: string): HTMLElement {
  const term = within(scope).getByText(label, { selector: "dt" });
  return term.nextElementSibling as HTMLElement;
}

const region = (name: string) => screen.getByRole("region", { name });
const OPEN_BUTTON = { name: "Close without recording" };

async function loaded(): Promise<void> {
  await screen.findByRole("heading", { level: 1, name: /POS-CAI-0042/ });
}

async function openDialog(): Promise<HTMLElement> {
  await loaded();
  const opener = screen.getByRole("button", OPEN_BUTTON);
  // A real click focuses the button first; the dialog gives focus back to it on close.
  opener.focus();
  fireEvent.click(opener);
  return screen.findByRole("dialog", { name: "Close the item without recording the sale" });
}

function typeNote(dialog: HTMLElement, value: string): void {
  fireEvent.change(within(dialog).getByLabelText(/Reason for closing/), { target: { value } });
}

const writtenOff = (note = "Refunded in cash") =>
  quarantined({
    state: "written-off",
    writeOff: { at: "2026-11-19T11:00:00Z", note },
  });

describe("QuarantineDetail (RT-1312)", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    readStore.mockReset();
    activeContext.mockReset();
    resetRateLimit();
    activeContext.mockReturnValue(ctx("owner"));
    readStore.mockResolvedValue({
      status: 200,
      data: { id: STORE, code: "CAI", name: "Cairo Festival", timezone: "Africa/Cairo" },
    });
    api.consoleGetQuarantinedSale.mockResolvedValue(ok(quarantined()));
  });

  // --- Gate and states -------------------------------------------------------------------

  test.each(["store_manager", "store_staff", "cashier", "auditor"])(
    "%s gets NoAccess and nothing is requested",
    async (role) => {
      activeContext.mockReturnValue(ctx(role));
      renderDetail();
      expect(await screen.findByRole("heading", { level: 1 })).toBeDefined();
      expect(api.consoleGetQuarantinedSale).not.toHaveBeenCalled();
    },
  );

  test("without a tenant it asks for one and requests nothing", () => {
    activeContext.mockReturnValue(ctx("owner", false));
    renderDetail();
    expect(screen.getByText("Select a tenant to view this item.")).toBeDefined();
    expect(api.consoleGetQuarantinedSale).not.toHaveBeenCalled();
  });

  test("a malformed reference reads as not found and is never sent", async () => {
    renderDetail("not-a-uuid");
    expect(
      await screen.findByText("This item was not found or is not available to you."),
    ).toBeDefined();
    expect(api.consoleGetQuarantinedSale).not.toHaveBeenCalled();
  });

  test("the API's non-disclosing 404 reads as not found or not available", async () => {
    api.consoleGetQuarantinedSale.mockResolvedValue(failure(404, "not_found"));
    renderDetail();
    expect(
      await screen.findByText("This item was not found or is not available to you."),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: /Back to sales the till could not send/ }),
    ).toBeDefined();
  });

  test.each([
    [401, "Your session has ended. Sign in again.", false],
    [429, "Too many requests in a short time. Wait a moment, then retry.", true],
    [500, "This item could not be loaded.", true],
  ])("a %i on the read is its own state", async (status, message, retry) => {
    api.consoleGetQuarantinedSale.mockResolvedValue(failure(status));
    renderDetail();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain(REQUEST_ID);
    expect(within(alert).queryByRole("button", { name: "Retry" }) !== null).toBe(retry);
  });

  // --- What it shows ---------------------------------------------------------------------

  test("it shows the item, what the till recorded and the sale summary, never a body", async () => {
    renderDetail();
    await loaded();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const item = region("Item");
    expect(within(item).getByText("Open")).toBeDefined();
    expect(field(item, "Source reference").querySelector("bdi")?.getAttribute("dir")).toBe("ltr");
    await waitFor(() => expect(within(item).getByText("Cairo Festival")).toBeDefined());
    const device = within(item).getByRole("link", { name: DEVICE });
    expect(device.getAttribute("href")).toBe(`/devices/${DEVICE}`);

    const till = region("What the till recorded");
    expect(field(till, "Why it is stuck (the till's claim)").textContent).toBe(
      "The server refused the sale for good",
    );
    expect(field(till, "Refusal status at the till").textContent).toBe("422");
    expect(field(till, "Error code at the till").textContent).toBe("sale_tender_mismatch");

    const sale = region("The sale as the till recorded it");
    expect(field(sale, "Total on the till").textContent).toBe("1,250.50 EGP");
    expect(field(sale, "Lines").textContent).toBe("3");
    expect(screen.getByText(/The sale body and its lines are not shown/)).toBeDefined();
    // The server never sends a body; the page never invents one.
    expect(document.body.textContent).not.toMatch(/saleBody|payload/i);
  });

  test("a summary field the stored sale lacks says not recorded", async () => {
    api.consoleGetQuarantinedSale.mockResolvedValue(
      ok(
        quarantined({
          tillHttpStatus: null,
          tillErrorCode: null,
          summary: { occurredAt: null, posTotal: null, currencyCode: null, lineCount: null },
        }),
      ),
    );
    renderDetail();
    await loaded();
    const sale = region("The sale as the till recorded it");
    expect(field(sale, "Total on the till").textContent).toBe("Not recorded");
    expect(field(sale, "Lines").textContent).toBe("Not recorded");
    expect(field(sale, "Sale time").textContent).toBe("Not recorded");
    expect(field(region("What the till recorded"), "Refusal status at the till").textContent).toBe(
      "Not recorded",
    );
  });

  test("it never calls an item of the ERP sync queue 'quarantined'", async () => {
    renderDetail();
    await loaded();
    expect(document.body.textContent).not.toMatch(/quarantin/i);
  });

  test("an earlier pairing's device is named for a held sale", async () => {
    api.consoleGetQuarantinedSale.mockResolvedValue(
      ok(quarantined({ reasonKind: "held_previous_pairing", previousTerminalId: DEVICE })),
    );
    renderDetail();
    await loaded();
    expect(field(region("What the till recorded"), "Device of the earlier pairing")).toBeDefined();
  });

  test("an upload conflict is a warning that the till holds a different sale", async () => {
    api.consoleGetQuarantinedSale.mockResolvedValue(ok(quarantined({ uploadConflictCount: 2 })));
    renderDetail();
    await loaded();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("with different facts");
    expect(alert.textContent).toContain("2 more times");
  });

  test("no conflict, no warning", async () => {
    renderDetail();
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a captured item links to its sale", async () => {
    api.consoleGetQuarantinedSale.mockResolvedValue(
      ok(quarantined({ state: "captured", saleRef: SALE })),
    );
    renderDetail();
    await loaded();
    const link = screen.getByRole("link", { name: "Open the sale" });
    expect(link.getAttribute("href")).toBe(`/sales/${SALE}`);
    expect(screen.queryByRole("button", OPEN_BUTTON)).toBeNull();
    expect(
      screen.getByText("This item is no longer open, so no action is offered on it."),
    ).toBeDefined();
  });

  test("a written-off item shows its note as typed, in its own direction, and no action", async () => {
    api.consoleGetQuarantinedSale.mockResolvedValue(ok(writtenOff("تم رد المبلغ نقدًا")));
    renderDetail();
    await loaded();
    const handling = region("Handling");
    expect(
      within(handling).getByText("تم رد المبلغ نقدًا").closest("[dir]")?.getAttribute("dir"),
    ).toBe("auto");
    expect(within(handling).getByText("Closing note", { selector: "dt" })).toBeDefined();
    expect(within(region("Item")).getByText("Closed without recording")).toBeDefined();
    expect(screen.queryByRole("button", OPEN_BUTTON)).toBeNull();
  });

  test("an unknown state offers no action and is not read as open", async () => {
    api.consoleGetQuarantinedSale.mockResolvedValue(
      ok(quarantined({ state: "held-for-review" as never })),
    );
    renderDetail();
    await loaded();
    expect(screen.getAllByText("Unknown state").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", OPEN_BUTTON)).toBeNull();
    expect(screen.getByText(/state is not known to this version/)).toBeDefined();
  });

  test("repair is not offered and not called: the page says it is not available yet", async () => {
    renderDetail();
    await loaded();
    expect(screen.queryByRole("button", { name: /repair|re-?ingest|record the sale/i })).toBeNull();
    expect(screen.getByText(/Recording the sale from here is not available yet/)).toBeDefined();
  });

  // --- Write-off ---------------------------------------------------------------------------

  test("the dialog opens on the safe choice, names the item and what is irreversible", async () => {
    renderDetail();
    const dialog = await openDialog();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dialog.textContent).toContain("POS-CAI-0042");
    expect(dialog.textContent).toContain("This cannot be undone.");
    expect(api.consoleWriteOffQuarantinedSale).not.toHaveBeenCalled();
  });

  test("the commit needs a note: blank and whitespace keep it disabled", async () => {
    renderDetail();
    const dialog = await openDialog();
    const commit = within(dialog).getByRole("button", { name: "Close without recording" });
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    typeNote(dialog, "   \n ");
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    typeNote(dialog, "Refunded in cash");
    expect((commit as HTMLButtonElement).disabled).toBe(false);
  });

  test("Escape and Cancel leave nothing sent", async () => {
    renderDetail();
    const dialog = await openDialog();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.consoleWriteOffQuarantinedSale).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", OPEN_BUTTON));
  });

  test("a confirmed write-off sends the trimmed note once, with a key of its own", async () => {
    api.consoleWriteOffQuarantinedSale.mockResolvedValue(ok(writtenOff("Refunded in cash")));
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "  Refunded in cash  ");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await within(dialog).findByText(/The item was closed without recording the sale/);
    expect(api.consoleWriteOffQuarantinedSale).toHaveBeenCalledTimes(1);
    const [ref, note, key] = api.consoleWriteOffQuarantinedSale.mock.calls[0];
    expect(ref).toBe(QUARANTINE_REF);
    expect(note).toBe("Refunded in cash");
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
    // The commit is gone, the way out reads Done, and the page shows the server's answer.
    expect(within(dialog).queryByRole("button", { name: "Close without recording" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(region("Item")).getByText("Closed without recording")).toBeDefined();
    expect(screen.queryByRole("button", OPEN_BUTTON)).toBeNull();
  });

  test("the list is read again after a write-off", async () => {
    api.consoleWriteOffQuarantinedSale.mockResolvedValue(ok(writtenOff()));
    const client = createQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderDetail(QUARANTINE_REF, client);
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await within(dialog).findByText(/The item was closed/);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["sale-quarantine", "list"]) }),
    );
  });

  test("a 409 says the item is no longer open, refreshes it and offers no resend", async () => {
    api.consoleWriteOffQuarantinedSale.mockResolvedValue(failure(409, "repair_conflict"));
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    api.consoleGetQuarantinedSale.mockResolvedValue(ok(writtenOff("Someone else's note")));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("The item is no longer open");
    expect(alert.textContent).toContain(REQUEST_ID);
    expect(within(dialog).queryByRole("button", { name: "Close without recording" })).toBeNull();
    await waitFor(() => expect(api.consoleGetQuarantinedSale).toHaveBeenCalledTimes(2));
  });

  test("a 404 says it is not available and changed nothing", async () => {
    api.consoleWriteOffQuarantinedSale.mockResolvedValue(failure(404, "not_found"));
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("not found or is not available to you. Nothing changed.");
  });

  test("an unconfirmed answer keeps the key for the same note and takes a new one for an edited note", async () => {
    api.consoleWriteOffQuarantinedSale
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 0 })
      .mockResolvedValueOnce(failure(400, "validation_error"))
      .mockResolvedValue(ok(writtenOff("Edited note")));
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    const commit = () =>
      fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));

    commit();
    await within(dialog).findByText(/did not confirm the result and may have acted/);
    commit();
    await waitFor(() => expect(api.consoleWriteOffQuarantinedSale).toHaveBeenCalledTimes(2));
    const keys = () => api.consoleWriteOffQuarantinedSale.mock.calls.map((c) => c[2]);
    // The same note replays under the same key.
    expect(keys()[1]).toBe(keys()[0]);

    // An edited note is a different request: the same key would be a 409, so it takes a new one.
    await within(dialog).findByText(/did not confirm the result/);
    typeNote(dialog, "Edited note");
    commit();
    await waitFor(() => expect(api.consoleWriteOffQuarantinedSale).toHaveBeenCalledTimes(3));
    expect(keys()[2]).not.toBe(keys()[0]);
    expect(api.consoleWriteOffQuarantinedSale.mock.calls[2][1]).toBe("Edited note");
  });

  test("an answered refusal ends the key: the next confirmation is a new request", async () => {
    api.consoleWriteOffQuarantinedSale
      .mockResolvedValueOnce(failure(400, "validation_error"))
      .mockResolvedValue(ok(writtenOff()));
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await within(dialog).findByText(/The server rejected the request. Nothing changed./);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await waitFor(() => expect(api.consoleWriteOffQuarantinedSale).toHaveBeenCalledTimes(2));
    const [first, second] = api.consoleWriteOffQuarantinedSale.mock.calls;
    expect(second[2]).not.toBe(first[2]);
  });

  test("a rate-limited answer holds the commit for the server's wait and keeps the key", async () => {
    api.consoleWriteOffQuarantinedSale.mockResolvedValueOnce(failure(429, "rate_limited", 30));
    const { reportRateLimited } = await import("@/lib/rate-limit");
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "The item was not closed; you can ask again in 30 seconds.",
    );
    act(() => reportRateLimited(30));
    const held = within(dialog).getByRole("button", { name: /Close without recording/ });
    expect((held as HTMLButtonElement).disabled).toBe(true);
    // Once the wait is over the same note replays under the same key.
    act(() => resetRateLimit());
    fireEvent.click(within(dialog).getByRole("button", { name: /Close without recording/ }));
    await waitFor(() => expect(api.consoleWriteOffQuarantinedSale).toHaveBeenCalledTimes(2));
    const [first, second] = api.consoleWriteOffQuarantinedSale.mock.calls;
    expect(second[2]).toBe(first[2]);
  });

  test("a 404 on the write-off reads the item again, so the page reaches its own 404", async () => {
    api.consoleWriteOffQuarantinedSale.mockResolvedValue(failure(404, "not_found"));
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    api.consoleGetQuarantinedSale.mockResolvedValue(failure(404, "not_found"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await within(dialog).findByText(/not found or is not available to you. Nothing changed./);
    await waitFor(() => expect(api.consoleGetQuarantinedSale).toHaveBeenCalledTimes(2));
  });

  test("a failed re-read keeps the item on screen and says so, with a retry", async () => {
    api.consoleWriteOffQuarantinedSale.mockResolvedValue({ status: 503 });
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    api.consoleGetQuarantinedSale.mockResolvedValue(failure(500));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await within(dialog).findByText(/did not confirm the result/);
    const stale = await screen.findByText(/could not be refreshed/);
    expect(
      within(stale.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Retry" }),
    ).toBeDefined();
    expect(screen.getByRole("heading", { level: 1, name: /POS-CAI-0042/ })).toBeDefined();
  });

  test("a 409 key conflict and a 403 origin refusal each say nothing changed", async () => {
    api.consoleWriteOffQuarantinedSale
      .mockResolvedValueOnce(failure(409, "idempotency_key_conflict"))
      .mockResolvedValueOnce(failure(403, "origin_rejected"));
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await within(dialog).findByText(/does not match an earlier request with the same key/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await within(dialog).findByText(/refused where this request came from, and nothing changed/);
  });

  test("when the write-off closes the item, focus lands on the page title, not the body", async () => {
    api.consoleWriteOffQuarantinedSale.mockResolvedValue(ok(writtenOff()));
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close without recording" }));
    await within(dialog).findByText(/The item was closed without recording the sale/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  test("a second click while one is in flight sends nothing more", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    api.consoleWriteOffQuarantinedSale.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderDetail();
    const dialog = await openDialog();
    typeNote(dialog, "Refunded in cash");
    const button = within(dialog).getByRole("button", { name: "Close without recording" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.consoleWriteOffQuarantinedSale).toHaveBeenCalledTimes(1);
    await act(async () => resolve(ok(writtenOff())));
  });
});
