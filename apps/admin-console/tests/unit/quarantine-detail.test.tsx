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
  consoleRepairQuarantinedSale: vi.fn(),
};
vi.mock("@/lib/sale-quarantine-queries", () => ({
  consoleListQuarantinedSales: (...a: unknown[]) => api.consoleListQuarantinedSales(...a),
  consoleGetQuarantinedSale: (...a: unknown[]) => api.consoleGetQuarantinedSale(...a),
  consoleWriteOffQuarantinedSale: (...a: unknown[]) => api.consoleWriteOffQuarantinedSale(...a),
  consoleRepairQuarantinedSale: (...a: unknown[]) => api.consoleRepairQuarantinedSale(...a),
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
const REPAIR_OPEN = { name: "Record the sale" };

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

async function openRepair(): Promise<HTMLElement> {
  await loaded();
  const opener = screen.getByRole("button", REPAIR_OPEN);
  opener.focus();
  fireEvent.click(opener);
  return screen.findByRole("dialog", { name: "Record this sale" });
}

/** The item as the server returns it after a repair that resolved it. */
const repaired = (outcome: "captured" | "already-captured") =>
  quarantined({
    state: outcome,
    saleRef: SALE,
    repairCount: 1,
    lastRepair: { at: "2026-11-19T11:00:00Z", outcome, httpStatus: null, errorCode: null },
  });

/** The item as the server returns it after a repair the capture rules refused. */
const refusedRepair = (errorCode: string, httpStatus: number | null) =>
  quarantined({
    repairCount: 1,
    lastRepair: { at: "2026-11-19T11:00:00Z", outcome: "refused", httpStatus, errorCode },
  });

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

  // --- Repair (slice C) --------------------------------------------------------------------

  test("an open item offers both actions; nothing is called until a confirmation", async () => {
    renderDetail();
    await loaded();
    expect(screen.getByRole("button", REPAIR_OPEN)).toBeDefined();
    expect(screen.getByRole("button", OPEN_BUTTON)).toBeDefined();
    expect(api.consoleRepairQuarantinedSale).not.toHaveBeenCalled();
    expect(api.consoleWriteOffQuarantinedSale).not.toHaveBeenCalled();
  });

  test("a closed item offers neither action", async () => {
    api.consoleGetQuarantinedSale.mockResolvedValue(ok(repaired("captured")));
    renderDetail();
    await loaded();
    expect(screen.queryByRole("button", REPAIR_OPEN)).toBeNull();
    expect(screen.queryByRole("button", OPEN_BUTTON)).toBeNull();
  });

  test("the repair dialog opens on the safe choice and names the item and the consequence", async () => {
    renderDetail();
    const dialog = await openRepair();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dialog.textContent).toContain("POS-CAI-0042");
    expect(dialog.textContent).toContain("no second sale is created");
    expect(api.consoleRepairQuarantinedSale).not.toHaveBeenCalled();
  });

  test("Escape leaves nothing sent and focus returns to the opener", async () => {
    renderDetail();
    const dialog = await openRepair();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.consoleRepairQuarantinedSale).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", REPAIR_OPEN));
  });

  test("a confirmed repair sends one POST with a key of its own, and the page shows the recorded sale", async () => {
    api.consoleRepairQuarantinedSale.mockResolvedValue(ok(repaired("captured")));
    renderDetail();
    const dialog = await openRepair();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the sale" }));
    await within(dialog).findByText(/The sale was recorded and the item is closed/);
    expect(api.consoleRepairQuarantinedSale).toHaveBeenCalledTimes(1);
    const [ref, key] = api.consoleRepairQuarantinedSale.mock.calls[0];
    expect(ref).toBe(QUARANTINE_REF);
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
    expect(api.consoleWriteOffQuarantinedSale).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Record the sale" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(region("Item")).getByText("Recorded by a repair")).toBeDefined();
    expect(screen.getByRole("link", { name: "Open the sale" }).getAttribute("href")).toBe(
      `/sales/${SALE}`,
    );
    expect(screen.queryByRole("button", REPAIR_OPEN)).toBeNull();
  });

  test("the list is read again after a repair", async () => {
    api.consoleRepairQuarantinedSale.mockResolvedValue(ok(repaired("captured")));
    const client = createQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderDetail(QUARANTINE_REF, client);
    const dialog = await openRepair();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the sale" }));
    await within(dialog).findByText(/The sale was recorded/);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["sale-quarantine", "list"]) }),
    );
  });

  test("an already recorded sale says no second sale was created", async () => {
    api.consoleRepairQuarantinedSale.mockResolvedValue(ok(repaired("already-captured")));
    renderDetail();
    const dialog = await openRepair();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the sale" }));
    await within(dialog).findByText(/already recorded, so no second sale was created/);
  });

  test.each([
    ["repair_operator_unproven", null, /could not be confirmed as a member/],
    ["idempotency_key_conflict", 409, /already recorded with different details/],
    ["not_found", 404, /already recorded in another store/],
    ["sale_line_pricing_invalid", 422, /refused to record this sale again/],
  ])(
    "a refused repair (%s) says nothing was recorded, and the item stays open",
    async (code, status, text) => {
      api.consoleRepairQuarantinedSale.mockResolvedValue(ok(refusedRepair(code, status)));
      renderDetail();
      const dialog = await openRepair();
      fireEvent.click(within(dialog).getByRole("button", { name: "Record the sale" }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toMatch(text);
      expect(alert.textContent).toContain("nothing was recorded");
      // The commit is gone for this answer; the item is still open, with the refusal on the page.
      expect(within(dialog).queryByRole("button", { name: "Record the sale" })).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("button", REPAIR_OPEN)).toBeDefined();
      expect(within(region("Handling")).getByText("Last refusal (status and code)")).toBeDefined();
      expect(within(region("Handling")).getByText(new RegExp(code))).toBeDefined();
    },
  );

  test("a 409 says the item is no longer open, refreshes it and offers no resend", async () => {
    api.consoleRepairQuarantinedSale.mockResolvedValue(failure(409, "repair_conflict"));
    renderDetail();
    const dialog = await openRepair();
    api.consoleGetQuarantinedSale.mockResolvedValue(ok(repaired("captured")));
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the sale" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("The item is no longer open");
    expect(alert.textContent).toContain(REQUEST_ID);
    expect(within(dialog).queryByRole("button", { name: "Record the sale" })).toBeNull();
    await waitFor(() => expect(api.consoleGetQuarantinedSale).toHaveBeenCalledTimes(2));
  });

  test("a 404 says it is not available and changed nothing", async () => {
    api.consoleRepairQuarantinedSale.mockResolvedValue(failure(404, "not_found"));
    renderDetail();
    const dialog = await openRepair();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the sale" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("not found or is not available to you. Nothing changed.");
  });

  test("an unconfirmed answer keeps the key for the retry; an answered refusal ends it", async () => {
    api.consoleRepairQuarantinedSale
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 0 })
      .mockResolvedValueOnce(failure(400, "validation_error"))
      .mockResolvedValue(ok(repaired("captured")));
    renderDetail();
    const dialog = await openRepair();
    const commit = () =>
      fireEvent.click(within(dialog).getByRole("button", { name: "Record the sale" }));
    commit();
    await within(dialog).findByText(/did not confirm the result and may have acted/);
    commit();
    await waitFor(() => expect(api.consoleRepairQuarantinedSale).toHaveBeenCalledTimes(2));
    const keys = () => api.consoleRepairQuarantinedSale.mock.calls.map((c) => c[1]);
    // An unconfirmed attempt replays under the same key: the sale is never recorded twice.
    expect(keys()[1]).toBe(keys()[0]);
    await within(dialog).findByText(/did not confirm the result/);
    commit();
    await waitFor(() => expect(api.consoleRepairQuarantinedSale).toHaveBeenCalledTimes(3));
    expect(keys()[2]).toBe(keys()[0]);
    await within(dialog).findByText(/The server rejected the request. Nothing changed./);
    // The 400 was an answer: the next confirmation is a new request with a new key.
    commit();
    await waitFor(() => expect(api.consoleRepairQuarantinedSale).toHaveBeenCalledTimes(4));
    expect(keys()[3]).not.toBe(keys()[0]);
  });

  test("a 200 with no readable outcome is not confirmed, never recorded", async () => {
    api.consoleRepairQuarantinedSale.mockResolvedValue(ok(quarantined({ lastRepair: null })));
    renderDetail();
    const dialog = await openRepair();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record the sale" }));
    await within(dialog).findByText(/did not confirm the result and may have acted/);
    expect(within(dialog).queryByText(/The sale was recorded/)).toBeNull();
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
    // What the operator sees: the page is the not-found view, with no item and no action.
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(
      await screen.findByText("This item was not found or is not available to you."),
    ).toBeDefined();
    expect(screen.queryByRole("button", OPEN_BUTTON)).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: /POS-CAI-0042/ })).toBeNull();
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
