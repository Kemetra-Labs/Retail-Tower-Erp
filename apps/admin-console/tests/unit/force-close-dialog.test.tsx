import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consoleGetForceClosePreview = vi.fn();
const consoleForceCloseShift = vi.fn();
const consoleListOpenShifts = vi.fn();
vi.mock("@/lib/force-action-queries", () => ({
  consoleGetForceClosePreview: (...a: unknown[]) => consoleGetForceClosePreview(...a),
  consoleForceCloseShift: (...a: unknown[]) => consoleForceCloseShift(...a),
  consoleListOpenShifts: (...a: unknown[]) => consoleListOpenShifts(...a),
}));
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: { active_tenant: { id: "t1", name: "Northstar" }, active_role_code: "owner" },
  }),
}));

import { ForceCloseDialog } from "@/force-actions/ForceCloseDialog";
import { createQueryClient } from "@/lib/query";

/**
 * RT-1440 (U1) AC1: the close-without-a-count dialog states: loading, eligible, blocked with its
 * reason, stale preview (409), rate limited (429), success and error. The server's verdict is the
 * only verdict; the dialog starts on «Cancel» and commits only after the reason and the
 * acknowledgement.
 */

const SHIFT = "0198a0c4-0000-7000-8000-000000000b01";
const FINGERPRINT = "3f0c8a5e1b7d4c2a9e6f0b1d8c7a5e4f2b3d9c6a1e8f7b0d5c4a3e2f1b9d8c7a";

function preview(over: { eligible?: boolean; blockers?: string[]; fingerprint?: string } = {}) {
  const eligible = over.eligible ?? true;
  return {
    status: 200,
    data: {
      shift: {
        shiftId: SHIFT,
        storeId: "0198a0c4-0000-7000-8000-000000000a01",
        source: "cash_up",
        lifecycleState: "open",
        openedAt: "2026-11-16T08:00:00Z",
        ageMinutes: 880,
        cashier: { userId: "0198a0c4-0000-7000-8000-000000000c01", displayName: null },
        terminal: {
          deviceId: "0198a0c4-0000-7000-8000-000000000d01",
          label: "till-A",
          lastSeenAt: "2026-11-16T08:20:00Z",
          trustState: "active",
        },
        verdict: {
          eligible,
          stale: true,
          liveOperatorSession: !eligible,
          liveCashierAdmission: false,
          blockers: over.blockers ?? (eligible ? [] : ["live_operator_session"]),
        },
      },
      recorded: {
        currencyCode: "EGP",
        openingFloat: "500.00",
        cashMovementCount: 3,
        lastCashMovementReceivedAt: "2026-11-16T09:12:00Z",
        saleCount: 41,
        refundExecutionCount: 1,
      },
      effects: {
        willChange: ["shift_closed_not_counted", "device_retire_replace_move_unblocked"],
        willNotChange: ["sales_unchanged", "erp_documents_unchanged"],
      },
      reversible: false,
      drawerCashUnaccounted: true,
      caveats: ["offline_facts_not_visible", "terminal_not_notified"],
      previewFingerprint: over.fingerprint ?? FINGERPRINT,
      evaluatedAt: "2026-11-16T22:40:00Z",
    },
  };
}

const err = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "server words never show", request_id: "req-9", ...extra },
});

let queryClient: ReturnType<typeof createQueryClient>;
const onClose = vi.fn();

function renderDialog(): void {
  queryClient = createQueryClient();
  function Tree({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  render(
    <Tree>
      <ForceCloseDialog shiftId={SHIFT} onClose={onClose} />
    </Tree>,
  );
}

async function fillAndAcknowledge(reason = "  Till A died; the cashier left  "): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/Reason for closing/), {
    target: { value: reason },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I understand that this drawer's cash will not be counted/,
    }),
  );
}

const commitButton = () =>
  screen.getByRole("button", { name: /Confirm closing the shift without a count/ });

describe("ForceCloseDialog", () => {
  beforeEach(() => {
    for (const fn of [
      consoleGetForceClosePreview,
      consoleForceCloseShift,
      consoleListOpenShifts,
      onClose,
    ]) {
      fn.mockReset();
    }
  });

  test("loading: says it is checking, and focus starts on Cancel (UX-05.11)", async () => {
    consoleGetForceClosePreview.mockReturnValue(new Promise(() => undefined));
    renderDialog();
    expect(await screen.findByText(/Checking the shift/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Close the shift without a count" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: /Confirm closing/ })).toBeNull();
  });

  test("eligible: states the consequence and the preview, and commits only with a reason and the acknowledgement", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    renderDialog();
    expect(
      await screen.findByText("The shift is closed without counting the drawer."),
    ).toBeTruthy();
    expect(screen.getByText(/This cannot be undone/)).toBeTruthy();
    expect(screen.getByText("Recorded sales stay as they are.")).toBeTruthy();
    expect(screen.getByText(/The drawer's real cash stays unaccounted for/)).toBeTruthy();
    expect(screen.getByText("Cashier with no name")).toBeTruthy();
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Write the reason and confirm you understand/)).toBeTruthy();
    await fillAndAcknowledge();
    expect((commitButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test("blocked: the server's blocker is persistent text, with no reason field and no commit", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview({ eligible: false }));
    renderDialog();
    expect(await screen.findByText(/It cannot be closed from here now/)).toBeTruthy();
    expect(
      screen.getByText(
        /still in use \(an active cashier session\)\. Close the shift from the terminal itself/,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/Reason for closing/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Confirm closing/ })).toBeNull();
  });

  test("success: sends the trimmed reason and the preview's fingerprint with one key, then offers Done", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    consoleForceCloseShift.mockResolvedValue({ status: 201, data: {} });
    renderDialog();
    await fillAndAcknowledge();
    fireEvent.click(commitButton());
    expect(await screen.findByText(/The shift was closed without a count/)).toBeTruthy();
    expect(consoleForceCloseShift).toHaveBeenCalledTimes(1);
    const [shiftId, body, key] = consoleForceCloseShift.mock.calls[0];
    expect(shiftId).toBe(SHIFT);
    expect(body).toEqual({
      forcedReason: "Till A died; the cashier left",
      previewFingerprint: FINGERPRINT,
    });
    expect(typeof key).toBe("string");
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm closing/ })).toBeNull();
  });

  test("a 200 replay is a success too", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    consoleForceCloseShift.mockResolvedValue({ status: 200, data: {} });
    renderDialog();
    await fillAndAcknowledge();
    fireEvent.click(commitButton());
    expect(await screen.findByText(/This shift is already closed without a count/)).toBeTruthy();
  });

  test("stale preview (409): asks to review, reads the preview again, drops the acknowledgement and keeps the reason", async () => {
    consoleGetForceClosePreview
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(preview({ fingerprint: `${"a".repeat(64)}` }));
    consoleForceCloseShift.mockResolvedValue({ status: 409, error: err("preview_stale") });
    renderDialog();
    await fillAndAcknowledge("Till A died");
    fireEvent.click(commitButton());
    expect(await screen.findByText(/The shift changed since the check/)).toBeTruthy();
    await waitFor(() => expect(consoleGetForceClosePreview).toHaveBeenCalledTimes(2));
    expect(
      (screen.getByRole("checkbox", { name: /I understand/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect((screen.getByLabelText(/Reason for closing/) as HTMLTextAreaElement).value).toBe(
      "Till A died",
    );
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  test("not stuck (409): shows the server's blockers as persistent text and offers no commit", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    consoleForceCloseShift.mockResolvedValue({
      status: 409,
      error: err("shift_not_stuck", { details: { blockers: ["live_cashier_admission"] } }),
    });
    renderDialog();
    await fillAndAcknowledge();
    fireEvent.click(commitButton());
    expect(await screen.findByText(/an active cashier sign-in/)).toBeTruthy();
  });

  test("rate limited (429): says the hourly limit was reached, and a retry keeps the same Idempotency-Key", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    consoleForceCloseShift
      .mockResolvedValueOnce({ status: 429, error: err("force_action_rate_limited") })
      .mockResolvedValueOnce({ status: 201, data: {} });
    renderDialog();
    await fillAndAcknowledge();
    fireEvent.click(commitButton());
    expect(await screen.findByText(/reached the hourly limit/)).toBeTruthy();
    fireEvent.click(commitButton());
    expect(await screen.findByText(/The shift was closed without a count/)).toBeTruthy();
    expect(consoleForceCloseShift.mock.calls[0][2]).toBe(consoleForceCloseShift.mock.calls[1][2]);
  });

  test("error: a refusal is a banner with the request id, and nothing is shown as closed", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    consoleForceCloseShift.mockResolvedValue({
      status: 403,
      error: err("support_session_required"),
    });
    renderDialog();
    await fillAndAcknowledge();
    fireEvent.click(commitButton());
    expect(
      await screen.findByText(/no longer available, so the shift was not closed/),
    ).toBeTruthy();
    expect(screen.getByText(/req-9/)).toBeTruthy();
    expect(screen.queryByText(/The shift was closed without a count/)).toBeNull();
  });

  test("a preview that cannot load is an error with a retry, never an empty dialog", async () => {
    consoleGetForceClosePreview.mockResolvedValue({ status: 500, error: err("internal") });
    renderDialog();
    expect(await screen.findByText(/Could not check the shift/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("a 404 preview reads as not available for the caller's access", async () => {
    consoleGetForceClosePreview.mockResolvedValue({ status: 404, error: err("shift_not_found") });
    renderDialog();
    expect(await screen.findByText(/not available for your access/)).toBeTruthy();
  });

  test("Escape cancels while nothing is in flight", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    renderDialog();
    await screen.findByText("The shift is closed without counting the drawer.");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  test("after a successful close the re-read preview (shift no longer open) is not shown as a blocker, and focus lands on Done", async () => {
    consoleGetForceClosePreview
      .mockResolvedValueOnce(preview())
      .mockResolvedValue(preview({ eligible: false, blockers: ["shift_not_open"] }));
    consoleForceCloseShift.mockResolvedValue({ status: 201, data: {} });
    renderDialog();
    await fillAndAcknowledge();
    fireEvent.click(commitButton());
    expect(await screen.findByText(/The shift was closed without a count/)).toBeTruthy();
    await waitFor(() => expect(consoleGetForceClosePreview.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByText(/It cannot be closed from here now/)).toBeNull();
    expect(screen.queryByText("The shift is closed without counting the drawer.")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
  });

  test("an effect, caveat or blocker code this build does not know never crashes the dialog", async () => {
    const p = preview();
    (p.data as { caveats: string[] }).caveats = ["offline_facts_not_visible", "something_new"];
    (p.data.effects as { willChange: string[] }).willChange = [
      "shift_closed_not_counted",
      "brand_new_change",
    ];
    consoleGetForceClosePreview.mockResolvedValue(p);
    renderDialog();
    expect(
      await screen.findByText("The shift is closed without counting the drawer."),
    ).toBeTruthy();
    expect(screen.getByText(/The server cannot see everything/)).toBeTruthy();
    expect(screen.getByText(/Other changes the server reports/)).toBeTruthy();
    expect(screen.queryByText(/something_new|brand_new_change/)).toBeNull();
  });

  test("Try again never sends the close with the acknowledgement unticked", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    consoleForceCloseShift.mockResolvedValue({ status: 503, error: err("system_failure") });
    renderDialog();
    await fillAndAcknowledge();
    fireEvent.click(commitButton());
    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ })); // untick
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull(); // the unclear answer is cleared
    expect(consoleForceCloseShift).toHaveBeenCalledTimes(1);
    expect(retry).toBeTruthy();
  });

  test("an unclear answer (503) is retried with the same Idempotency-Key, and a changed reason is a new action", async () => {
    consoleGetForceClosePreview.mockResolvedValue(preview());
    consoleForceCloseShift
      .mockResolvedValueOnce({ status: 503, error: err("system_failure") })
      .mockResolvedValueOnce({ status: 503, error: err("system_failure") })
      .mockResolvedValueOnce({ status: 201, data: {} });
    renderDialog();
    await fillAndAcknowledge("Till A died");
    fireEvent.click(commitButton());
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(consoleForceCloseShift).toHaveBeenCalledTimes(2));
    expect(consoleForceCloseShift.mock.calls[1][2]).toBe(consoleForceCloseShift.mock.calls[0][2]);
    // The operator edits the reason: a different body is a different action.
    fireEvent.change(screen.getByLabelText(/Reason for closing/), {
      target: { value: "Till A died, cashier left" },
    });
    fireEvent.click(commitButton());
    await waitFor(() => expect(consoleForceCloseShift).toHaveBeenCalledTimes(3));
    expect(consoleForceCloseShift.mock.calls[2][2]).not.toBe(
      consoleForceCloseShift.mock.calls[0][2],
    );
  });

  test("after a stale answer the next commit carries the NEW fingerprint, and commit waits for the re-read", async () => {
    const fresh = "b".repeat(64);
    let release: (v: unknown) => void = () => undefined;
    consoleGetForceClosePreview.mockResolvedValueOnce(preview()).mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    consoleForceCloseShift
      .mockResolvedValueOnce({ status: 409, error: err("preview_stale") })
      .mockResolvedValueOnce({ status: 201, data: {} });
    renderDialog();
    await fillAndAcknowledge("Till A died");
    fireEvent.click(commitButton());
    await screen.findByText(/The shift changed since the check/);
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    // The re-read has not landed: the commit stays disabled, so it cannot go out against the old preview.
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    release(preview({ fingerprint: fresh }));
    await waitFor(() => expect((commitButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(commitButton());
    await waitFor(() => expect(consoleForceCloseShift).toHaveBeenCalledTimes(2));
    expect(consoleForceCloseShift.mock.calls[1][1]).toEqual({
      forcedReason: "Till A died",
      previewFingerprint: fresh,
    });
  });
  test("focus moves to Done once the close is recorded AND the dialog has finished refreshing (Done is disabled until then)", async () => {
    let release: (v: unknown) => void = () => undefined;
    consoleGetForceClosePreview.mockResolvedValueOnce(preview()).mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    consoleForceCloseShift.mockResolvedValue({ status: 201, data: {} });
    renderDialog();
    await fillAndAcknowledge();
    commitButton().focus(); // a real click moves focus to the commit button, which leaves when the close is recorded
    fireEvent.click(commitButton());
    expect(await screen.findByText(/The shift was closed without a count/)).toBeTruthy();
    // The re-read is still running: Done is disabled and cannot take focus yet.
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Done" }));
    release(preview({ eligible: false, blockers: ["shift_not_open"] }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" })),
    );
  });

  test("Try again after a lost answer resends the SAME body and key even if the re-read preview now says the shift is no longer open", async () => {
    consoleGetForceClosePreview.mockResolvedValueOnce(preview());
    consoleForceCloseShift
      .mockResolvedValueOnce({ status: 503, error: err("system_failure") })
      .mockResolvedValueOnce({ status: 200, data: {} });
    renderDialog();
    await fillAndAcknowledge("Till A died");
    fireEvent.click(commitButton());
    const retry = await screen.findByRole("button", { name: "Try again" });
    // The reconnect re-read lands: the first attempt may have been recorded, so the shift is not open.
    consoleGetForceClosePreview.mockResolvedValue(
      preview({ eligible: false, blockers: ["shift_not_open"] }),
    );
    await queryClient.refetchQueries({ queryKey: ["force-actions", "preview"] });
    await waitFor(() => expect(screen.getByText(/The shift is no longer open/)).toBeTruthy());
    fireEvent.click(retry);
    expect(await screen.findByText(/This shift is already closed without a count/)).toBeTruthy();
    expect(consoleForceCloseShift).toHaveBeenCalledTimes(2);
    expect(consoleForceCloseShift.mock.calls[1][1]).toEqual(
      consoleForceCloseShift.mock.calls[0][1],
    );
    expect(consoleForceCloseShift.mock.calls[1][2]).toBe(consoleForceCloseShift.mock.calls[0][2]);
  });

  test("a 429 on the retry of a lost answer keeps Try again, so the held attempt is still recoverable once the preview says the shift is no longer open", async () => {
    consoleGetForceClosePreview.mockResolvedValueOnce(preview());
    consoleForceCloseShift
      .mockResolvedValueOnce({ status: 503, error: err("system_failure") })
      .mockResolvedValueOnce({ status: 429, error: err("force_action_rate_limited") })
      .mockResolvedValueOnce({ status: 200, data: {} });
    renderDialog();
    await fillAndAcknowledge("Till A died");
    fireEvent.click(commitButton());
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/reached the hourly limit/)).toBeTruthy();
    // The first attempt may have been recorded: the re-read now says the shift is not open.
    consoleGetForceClosePreview.mockResolvedValue(
      preview({ eligible: false, blockers: ["shift_not_open"] }),
    );
    await queryClient.refetchQueries({ queryKey: ["force-actions", "preview"] });
    await waitFor(() => expect(screen.getByText(/The shift is no longer open/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/This shift is already closed without a count/)).toBeTruthy();
    expect(consoleForceCloseShift).toHaveBeenCalledTimes(3);
    expect(consoleForceCloseShift.mock.calls[2][1]).toEqual(
      consoleForceCloseShift.mock.calls[0][1],
    );
    expect(consoleForceCloseShift.mock.calls[2][2]).toBe(consoleForceCloseShift.mock.calls[0][2]);
  });
});
