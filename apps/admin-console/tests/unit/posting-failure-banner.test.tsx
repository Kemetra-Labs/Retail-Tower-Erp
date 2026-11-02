import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  REASON,
  REQUEST_ID,
  REVERSAL_ITEM,
  WORK_ITEM,
  answered,
  categoryOnly,
  failedDetail,
  failureDetail,
  full,
  recorded,
  refused,
} from "./posting-failure-fixtures";
import { SALE_1, ctx } from "./sale-fixtures";

const repairPosting = vi.fn();
vi.mock("@/lib/erp-posting-repair-queries", () => ({
  IDEMPOTENCY_IN_PROGRESS_STATUS: 425,
  repairPosting: (...a: unknown[]) => repairPosting(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";
import type { SaleDetail } from "@/lib/sale-queries";
import { postingRepairTiming } from "@/posting-repair/usePostingRepair";
import { ErpFailureBanner } from "@/sales/ErpFailureBanner";
import { saleQueryKeys } from "@/sales/useSales";

/**
 * RT-1072 (RT-977 §7, §10 slice 2): the posting-failure banner and its repair.
 * Each disclosure tier; each repair outcome; `reconciliation_required` never
 * offered; one Idempotency-Key per confirmation; single-flight; the detail is
 * read again after any answer.
 */
type Client = ReturnType<typeof createQueryClient>;
const OWNER = "owner";

function renderBanner(sale: unknown, role = "owner", client: Client = createQueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ErpFailureBanner detail={sale as SaleDetail} role={role} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const banner = () => screen.getAllByRole("alert")[0];
const sendButton = () => within(banner()).getByRole("button", { name: "Send to ERPNext again" });
const confirmRegion = () =>
  screen.getByRole("region", { name: "Confirm sending to ERPNext again" });

async function confirmSend(): Promise<void> {
  fireEvent.click(sendButton());
  fireEvent.click(within(confirmRegion()).getByRole("button", { name: "Send again" }));
  await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
}

const lastOutcome = () => document.querySelector(".sale-erp-failure__outcome") as HTMLElement;

describe("ERPNext posting-failure banner (RT-977 slice 2)", () => {
  beforeEach(() => {
    repairPosting.mockReset();
    activeContext.mockReturnValue(ctx("owner"));
    resetRateLimit();
  });

  // --- Disclosure tiers -----------------------------------------------------------

  test("full: What → Safety → Action → Evidence, with the reason as plain text", () => {
    renderBanner(failedDetail(full()));
    const alert = banner();
    expect(within(alert).getByText("This sale was not posted to ERPNext.")).toBeDefined();
    const text = alert.textContent ?? "";
    const cause = text.indexOf("ERPNext refused the document as invalid.");
    const safety = text.indexOf(
      "The sale stays recorded in Retail Tower. Repair does not change it.",
    );
    const action = text.indexOf("Send to ERPNext again");
    expect(cause).toBeGreaterThan(-1);
    expect(safety).toBeGreaterThan(cause);
    expect(action).toBeGreaterThan(safety);
    // Evidence follows the banner: the time, and the reason isolated in <bdi>.
    const evidence = document.querySelector(".sale-erp-failure__evidence") as HTMLElement;
    expect(alert.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(evidence.textContent).toMatch(/^Stopped at .+\./);
    const reason = within(evidence).getByText(REASON);
    expect(reason.tagName).toBe("BDI");
    expect(reason.getAttribute("dir")).toBe("auto");
    expect(within(alert).getByRole("link", { name: "Connection & sync" })).toBeDefined();
  });

  test("full: the reason is text, never HTML", () => {
    renderBanner(failedDetail(full(failureDetail({ reason: "<img src=x onerror=alert(1)>" }))));
    expect(document.querySelector(".sale-erp-failure img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeDefined();
  });

  test("category_only (store_manager): the category and time; who can repair; no reason, document or button", () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderBanner(
      failedDetail(
        categoryOnly(
          failureDetail({
            rejectionCategory: "reconciliation_required",
            reconciliationDocumentRef: { doctype: "Sales Invoice", name: "ACC-SINV-1" },
          }),
        ),
      ),
      "store_manager",
    );
    const alert = banner();
    expect(alert.textContent).toContain(
      "ERPNext already has a document for this sale that does not match.",
    );
    expect(alert.textContent).toContain("An owner or a tenant admin can repair this posting.");
    expect(document.body.textContent).not.toContain("ACC-SINV-1");
    expect(document.body.textContent).not.toContain(REASON);
    expect(document.body.textContent).toContain("Stopped at");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("category_only never shows a reason or a button, even if the server sent them", () => {
    renderBanner(failedDetail(categoryOnly()), "store_manager");
    expect(document.body.textContent).not.toContain(REASON);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("reconciliation_required under full: the document and the ERP link, never a repair", () => {
    renderBanner(
      failedDetail(
        full(
          failureDetail({
            rejectionCategory: "reconciliation_required",
            reconciliationDocumentRef: { doctype: "Sales Invoice", name: "ACC-SINV-1" },
            repair: { workItemRef: WORK_ITEM },
          }),
        ),
      ),
    );
    expect(banner().textContent).toContain(
      "ERPNext already has a document for this sale (Sales Invoice ACC-SINV-1) that does not match.",
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(within(banner()).getByRole("link", { name: "Connection & sync" })).toBeDefined();
  });

  test("unmapped_item: fix the mapping first, then send again", () => {
    renderBanner(failedDetail(full(failureDetail({ rejectionCategory: "unmapped_item" }))));
    expect(banner().textContent).toContain(
      "An item in this sale has no confirmed ERPNext item mapping.",
    );
    expect(banner().textContent).toContain("Fix the mapping first, then send again.");
    expect(sendButton()).toBeDefined();
  });

  test("full with no handle (a deleted store): no button and no extra copy", () => {
    renderBanner(failedDetail(full(failureDetail({ repair: null }))));
    expect(screen.queryByRole("button")).toBeNull();
    expect(banner().textContent).not.toContain("Fix the mapping");
  });

  test("an absent field (older server): the RT-974 state-only banner, unchanged", () => {
    renderBanner(failedDetail(undefined));
    const alert = banner();
    expect(alert.textContent).toContain("This sale was not posted to ERPNext.");
    expect(alert.textContent).toContain("Sale posting: ERPNext posting failed");
    expect(alert.textContent).not.toMatch(/stays recorded|changed/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a failed side the probe did not find: the state and 'changed, refresh'", () => {
    renderBanner(failedDetail(full(null)));
    expect(banner().textContent).toContain("This posting changed. Refresh to see its state.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("the void reversal has its own banner and repair", async () => {
    repairPosting.mockResolvedValue(answered(201, recorded()));
    renderBanner(
      failedDetail(full(null, failureDetail({ repair: { workItemRef: REVERSAL_ITEM } })), {
        sale: "posted",
        reversal: "failed",
      }),
    );
    expect(banner().textContent).toContain(
      "The void reversal of this sale was not posted to ERPNext.",
    );
    fireEvent.click(sendButton());
    expect(confirmRegion().textContent).toContain("Send the void reversal of this sale");
    fireEvent.click(within(confirmRegion()).getByRole("button", { name: "Send again" }));
    await waitFor(() =>
      expect(repairPosting).toHaveBeenCalledWith(REVERSAL_ITEM, expect.any(String)),
    );
  });

  // --- Repair: confirmation, key, outcomes -----------------------------------------

  test("the confirmation says what repair does; cancel sends nothing and returns focus", () => {
    renderBanner(failedDetail(full()));
    fireEvent.click(sendButton());
    const region = confirmRegion();
    expect(region.textContent).toContain(
      "Send this sale to ERPNext again? Retail Tower checks the cause again. If it is fixed, ERPNext receives the sale once; it is never posted twice.",
    );
    expect(document.activeElement?.textContent).toContain("Send again");
    fireEvent.click(within(region).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(repairPosting).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(sendButton());
  });

  test.each([
    [201, recorded(), "Sent again. The ERPNext posting is pending."],
    [
      201,
      recorded({ outcome: "still_failing" }),
      "Nothing was sent. The cause is still there; fix it, then try again.",
    ],
    [
      200,
      recorded({ outcome: "no_op_echo", resolvedDocumentRef: "ACC-SINV-2026-00042" }),
      "Already posted to ERPNext as ACC-SINV-2026-00042. Nothing was sent again.",
    ],
    [
      200,
      recorded({ outcome: "no_op_echo" }),
      "Already sent again and waiting for ERPNext. Nothing changed.",
    ],
  ])("%i %o is shown as its outcome", async (status, body, message) => {
    repairPosting.mockResolvedValue(answered(status, body));
    renderBanner(failedDetail(full()));
    await confirmSend();
    await waitFor(() => expect(lastOutcome().textContent).toContain(message));
    expect(within(lastOutcome()).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  test.each([
    [404, "x", "This posting can no longer be repaired here. Refresh the sale."],
    [409, "idempotency_key_conflict", "does not match an earlier request with the same key"],
    [403, "origin_rejected", "The request was refused. Reload the page, then try again."],
  ])("%i %s is shown with its request id", async (status, code, message) => {
    repairPosting.mockResolvedValue(refused(status, code));
    renderBanner(failedDetail(full()));
    await confirmSend();
    await waitFor(() => expect(lastOutcome().textContent).toContain(message));
    await waitFor(() => expect(lastOutcome().textContent).toContain(REQUEST_ID));
  });

  test("sends the handle with a v4 Idempotency-Key; a new confirmation mints a new key", async () => {
    repairPosting.mockResolvedValue(answered(201, recorded({ outcome: "still_failing" })));
    renderBanner(failedDetail(full()));
    await confirmSend();
    await confirmSend();
    expect(repairPosting).toHaveBeenCalledTimes(2);
    const [[ref1, key1], [ref2, key2]] = repairPosting.mock.calls;
    expect(ref1).toBe(WORK_ITEM);
    expect(ref2).toBe(WORK_ITEM);
    expect(key1).toMatch(/^[0-9a-f-]{36}$/);
    expect(key2).not.toBe(key1);
  });

  test("a transport failure or 5xx is 'not confirmed'; Try again reuses the same key", async () => {
    repairPosting
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(refused(503))
      .mockResolvedValueOnce(answered(200, recorded()));
    renderBanner(failedDetail(full()));
    await confirmSend();
    await waitFor(() =>
      expect(lastOutcome().textContent).toContain("We could not confirm the result. Try again."),
    );
    fireEvent.click(within(lastOutcome()).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(repairPosting).toHaveBeenCalledTimes(2));
    await within(lastOutcome()).findByRole("button", { name: "Try again" });
    fireEvent.click(within(lastOutcome()).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(lastOutcome().textContent).toContain("Sent again. The ERPNext posting is pending."),
    );
    const keys = repairPosting.mock.calls.map(([, key]) => key);
    expect(new Set(keys).size).toBe(1);
  });

  test("a 425 waits its Retry-After and is sent once more with the same key", async () => {
    const wait = vi.spyOn(postingRepairTiming, "wait").mockResolvedValue();
    repairPosting
      .mockResolvedValueOnce(refused(425, "idempotency_in_progress", 2))
      .mockResolvedValueOnce(answered(201, recorded()));
    renderBanner(failedDetail(full()));
    await confirmSend();
    expect(wait).toHaveBeenCalledWith(2000);
    expect(repairPosting).toHaveBeenCalledTimes(2);
    expect(repairPosting.mock.calls[0][1]).toBe(repairPosting.mock.calls[1][1]);
    await waitFor(() => expect(lastOutcome().textContent).toContain("Sent again."));
    wait.mockRestore();
  });

  test("a second 425 is 'not confirmed', with the key kept; never a third send on its own", async () => {
    const wait = vi.spyOn(postingRepairTiming, "wait").mockResolvedValue();
    repairPosting.mockResolvedValue(refused(425, "idempotency_in_progress", 2));
    renderBanner(failedDetail(full()));
    await confirmSend();
    expect(repairPosting).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(lastOutcome().textContent).toContain("We could not confirm the result."),
    );
    expect(within(lastOutcome()).getByRole("button", { name: "Try again" })).toBeDefined();
    wait.mockRestore();
  });

  test("single-flight: a double click on confirm sends one request", async () => {
    let finish: (value: unknown) => void = () => {};
    repairPosting.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderBanner(failedDetail(full()));
    fireEvent.click(sendButton());
    const submit = within(confirmRegion()).getByRole("button", { name: "Send again" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(screen.getByText("Sending…")).toBeDefined();
    await act(async () => finish(answered(201, recorded())));
    expect(repairPosting).toHaveBeenCalledTimes(1);
  });

  test("after any answer the sale detail is read again, and the outcome stays when the failure is gone", async () => {
    repairPosting.mockResolvedValue(answered(201, recorded()));
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const sale = failedDetail(full());
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ErpFailureBanner detail={sale as unknown as SaleDetail} role={OWNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await confirmSend();
    const key = saleQueryKeys.detail({ tenantId: "t1", activeStoreId: null }, SALE_1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true });
    // The re-read shows the posting pending: no failure banner, the outcome stays.
    const pending = failedDetail(null, { sale: "pending" });
    rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ErpFailureBanner detail={pending as unknown as SaleDetail} role={OWNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() =>
      expect(lastOutcome().textContent).toContain("Sent again. The ERPNext posting is pending."),
    );
  });

  test("nothing failed and no outcome: nothing rendered, nothing requested", () => {
    renderBanner(failedDetail(full(), { sale: "posted" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(repairPosting).not.toHaveBeenCalled();
  });
});
