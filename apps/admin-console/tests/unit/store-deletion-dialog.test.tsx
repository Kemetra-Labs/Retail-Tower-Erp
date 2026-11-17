import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const previewStoreDeletion = vi.fn();
const consoleReauthenticate = vi.fn();
const consoleDeleteStore = vi.fn();
vi.mock("@/lib/store-deletion-queries", () => ({
  previewStoreDeletion: (...a: unknown[]) => previewStoreDeletion(...a),
  consoleReauthenticate: (...a: unknown[]) => consoleReauthenticate(...a),
  consoleDeleteStore: (...a: unknown[]) => consoleDeleteStore(...a),
}));
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: { active_tenant: { id: "t1", name: "Northstar" }, active_role_code: "owner" },
  }),
}));

import { createQueryClient } from "@/lib/query";
import { StoreDeletionDialog } from "@/store-deletion/StoreDeletionDialog";

/**
 * RT-1441 (U2) AC1: the store-deletion dialog states: loading, clean, blocked (each 409 code with
 * its link), re-auth failure, stale preview, success, and the errors. The server's verdict is the
 * only verdict; the dialog starts on «Cancel» and commits only after the reason and the password,
 * which it sends to the re-authentication and never keeps.
 */

const STORE = "0198a0c4-0000-7000-8000-000000000a01";
const DEV_A = "0198a0c4-0000-7000-8000-000000000d01";
const DEV_B = "0198a0c4-0000-7000-8000-000000000d02";
const COUNT = "0198a0c4-0000-7000-8000-000000000e01";
const FINGERPRINT = "3f0c8a5e1b7d4c2a9e6f0b1d8c7a5e4f2b3d9c6a1e8f7b0d5c4a3e2f1b9d8c7a";

type Blocker = { code: string; count: number };

function preview(over: { blockers?: Blocker[]; fingerprint?: string } = {}) {
  const blockers = over.blockers ?? [];
  return {
    status: 200,
    data: {
      store: { storeId: STORE, code: "DXB", name: "Dubai Mall", isActive: true },
      openShifts: blockers.some((b) => b.code === "store_has_open_shift")
        ? [
            {
              shiftId: "s1",
              openedAt: "2026-11-16T08:00:00Z",
              terminalLabel: "till-A",
              forceCloseEligible: true,
            },
          ]
        : [],
      devices: [
        {
          deviceId: DEV_A,
          label: "till-A",
          trustState: "active",
          lastSeenAt: "2026-11-16T09:00:00Z",
          queue: null,
        },
        {
          deviceId: DEV_B,
          label: null,
          trustState: "retired",
          lastSeenAt: null,
          queue: { pending: 0, deadLetter: 0, held: 0 },
        },
      ],
      openCountSessions: blockers.some((b) => b.code === "store_has_open_count_session")
        ? [{ sessionId: COUNT, status: "open" }]
        : [],
      warehouseMappings: [{ warehouseRef: "WH-1" }],
      singleStoreMembers: [],
      offersRebuiltCount: 2,
      effects: {
        willChange: ["store_hidden_from_lists", "devices_refused_immediately"],
        willNotChange: ["sales_unchanged", "warehouse_mapping_kept"],
      },
      blockers,
      canDelete: blockers.length === 0,
      reversible: false,
      reversibleAlternative: "suspend_store",
      caveats: ["offline_facts_not_visible", "queue_as_of_last_heartbeat"],
      previewFingerprint: over.fingerprint ?? FINGERPRINT,
      evaluatedAt: "2026-11-17T10:00:00Z",
    },
  };
}

const err = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "server words never show", request_id: "req-9", ...extra },
});

const grant = (token = "grant-1") => ({ status: 200, data: { reauthToken: token } });

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
      <StoreDeletionDialog storeId={STORE} onClose={onClose} />
    </Tree>,
  );
}

async function fillIn(reason = "  Closed for good  ", password = "correct horse"): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/Reason for deleting/), {
    target: { value: reason },
  });
  fireEvent.change(screen.getByLabelText("Your current password"), { target: { value: password } });
}

const commitButton = () => screen.getByRole("button", { name: "Confirm deleting the store" });
const passwordInput = () => screen.getByLabelText("Your current password") as HTMLInputElement;

async function commitClean(): Promise<void> {
  consoleReauthenticate.mockResolvedValue(grant());
  await fillIn();
  fireEvent.click(commitButton());
}

describe("StoreDeletionDialog", () => {
  beforeEach(() => {
    for (const fn of [previewStoreDeletion, consoleReauthenticate, consoleDeleteStore, onClose]) {
      fn.mockReset();
    }
  });

  test("loading: says it is checking, and focus starts on Cancel (UX-05.11)", async () => {
    previewStoreDeletion.mockReturnValue(new Promise(() => undefined));
    renderDialog();
    expect(await screen.findByText(/Checking what deleting would change/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Delete the store" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: /Confirm deleting/ })).toBeNull();
  });

  test("clean: states the consequence, that it is irreversible, and the impact, then asks for the reason and the password", async () => {
    previewStoreDeletion.mockResolvedValue(preview());
    renderDialog();
    // The consequence is static; the effects come from the server's preview.
    expect(await screen.findByText("The store disappears from the lists.")).toBeTruthy();
    expect(screen.getByText(/There is no supported way to restore the store/)).toBeTruthy();
    expect(screen.getByText("Deleting is permanent and cannot be undone.")).toBeTruthy();
    expect(screen.getByText("Recorded sales stay as they are.")).toBeTruthy();
    expect(screen.getByText("The accounting warehouse mappings are kept.")).toBeTruthy();
    // A till that never reported its queue is unknown, never zero.
    expect(screen.getByText("Unsent sales: unknown")).toBeTruthy();
    expect(screen.getByText(/Unsent 0 · stuck 0 · held 0/)).toBeTruthy();
    expect(
      screen.getByText(/Unsent-sale counts are as of each terminal's last signal/),
    ).toBeTruthy();
    expect(screen.queryByText(/The store cannot be deleted now/)).toBeNull();
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(passwordInput().type).toBe("password");
    expect(passwordInput().autocomplete).toBe("current-password");
  });

  test("the commit enables only with a reason and the password", async () => {
    previewStoreDeletion.mockResolvedValue(preview());
    renderDialog();
    fireEvent.change(await screen.findByLabelText(/Reason for deleting/), {
      target: { value: "Closed" },
    });
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(passwordInput(), { target: { value: "pw" } });
    expect((commitButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/Reason for deleting/), {
      target: { value: "x".repeat(201) },
    });
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("The reason is longer than 200 characters.")).toBeTruthy();
  });

  test("success: re-authenticates with the password, deletes with the grant and the fingerprint, then leaves through the list", async () => {
    previewStoreDeletion.mockResolvedValue(preview());
    consoleDeleteStore.mockResolvedValue({
      status: 200,
      data: { storeId: STORE },
      replayed: false,
    });
    renderDialog();
    await commitClean();
    expect(await screen.findByText("The store is deleted.")).toBeTruthy();

    expect(consoleReauthenticate).toHaveBeenCalledTimes(1);
    expect(consoleReauthenticate).toHaveBeenCalledWith(STORE, "correct horse");
    expect(consoleDeleteStore).toHaveBeenCalledTimes(1);
    const [storeId, body, key] = consoleDeleteStore.mock.calls[0];
    expect(storeId).toBe(STORE);
    expect(body).toEqual({
      reason: "Closed for good",
      previewFingerprint: FINGERPRINT,
      reauthToken: "grant-1",
    });
    expect(String(key).length).toBeGreaterThanOrEqual(16);

    // The commit is gone; focus stays inside the modal on the way out.
    expect(screen.queryByRole("button", { name: /Confirm deleting/ })).toBeNull();
    const done = screen.getByRole("button", { name: "Back to stores" });
    await waitFor(() => expect(document.activeElement).toBe(done));
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalledWith(true);
  });

  test("a replayed delete says so and changes nothing", async () => {
    previewStoreDeletion.mockResolvedValue(preview());
    consoleDeleteStore.mockResolvedValue({ status: 200, data: { storeId: STORE }, replayed: true });
    renderDialog();
    await commitClean();
    expect(await screen.findByText("This store is already deleted. Nothing changed.")).toBeTruthy();
  });

  test("the password is cleared as soon as it is sent, whatever the answer", async () => {
    previewStoreDeletion.mockResolvedValue(preview());
    consoleDeleteStore.mockResolvedValue({ status: 500 });
    renderDialog();
    await commitClean();
    await screen.findByText(/We could not confirm the delete was recorded/);
    expect(passwordInput().value).toBe("");
  });

  describe("blocked", () => {
    test("the server's verdict blocks: each blocker reads as text with the link to its fix, and there is no commit", async () => {
      previewStoreDeletion.mockResolvedValue(
        preview({
          blockers: [
            { code: "store_has_open_shift", count: 1 },
            { code: "store_has_unretired_device", count: 1 },
            { code: "store_device_queue_unsynced", count: 1 },
            { code: "store_has_open_count_session", count: 2 },
          ],
        }),
      );
      renderDialog();
      expect(await screen.findByText("The store cannot be deleted now:")).toBeTruthy();
      expect(screen.getByText("The store has 1 open shift. Close it first.")).toBeTruthy();
      expect(
        screen.getByText("The store has 1 terminal that is not retired. Retire it first."),
      ).toBeTruthy();
      expect(screen.getByText(/1 terminal has sales that are not sent yet/)).toBeTruthy();
      expect(
        screen.getByText("The store has 2 open count sessions. Finish them first."),
      ).toBeTruthy();

      const href = (name: string | RegExp) =>
        screen.getAllByRole("link", { name })[0].getAttribute("href");
      expect(href("Open shifts in this store")).toBe(`/stores/${STORE}/open-shifts`);
      // The retired till is never linked: only the one that still holds the store.
      expect(screen.getAllByRole("link", { name: "Open the terminal till-A" })).toHaveLength(2);
      expect(href("Open the terminal till-A")).toBe(`/devices/${DEV_A}`);
      expect(href("Open count session 1")).toBe(`/inventory/stores/${STORE}/counts/${COUNT}`);

      expect(screen.queryByRole("button", { name: /Confirm deleting/ })).toBeNull();
      expect(screen.queryByLabelText("Your current password")).toBeNull();
      expect(consoleReauthenticate).not.toHaveBeenCalled();
    });

    test.each([
      ["store_has_open_shift", /The store has 1 open shift/],
      ["store_has_unretired_device", /1 terminal that is not retired/],
      ["store_device_queue_unsynced", /1 terminal has sales that are not sent yet/],
      ["store_has_open_count_session", /1 open count session/],
    ])(
      "a 409 %s after the confirm shows that blocker, reads the preview again and keeps the grant out of reach",
      async (code, text) => {
        previewStoreDeletion.mockResolvedValue(preview());
        consoleDeleteStore.mockResolvedValue({
          status: 409,
          error: err(code, { details: { blockers: [{ code, count: 1 }] } }),
        });
        renderDialog();
        await commitClean();
        expect(await screen.findByText(text)).toBeTruthy();
        expect(screen.getByText("The store cannot be deleted now:")).toBeTruthy();
        await waitFor(() => expect(previewStoreDeletion).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole("button", { name: /Confirm deleting/ })).toBeNull();
        expect(consoleDeleteStore).toHaveBeenCalledTimes(1);
      },
    );

    test("a code this build does not know reads as not deletable now and shows no raw code", async () => {
      previewStoreDeletion.mockResolvedValue(
        preview({ blockers: [{ code: "from_the_future", count: 1 }] }),
      );
      renderDialog();
      expect(await screen.findByText("This store cannot be deleted now.")).toBeTruthy();
      expect(screen.queryByText(/from_the_future/)).toBeNull();
    });
  });

  describe("re-authentication", () => {
    test("a refusal is one generic message: nothing is deleted and the password is gone", async () => {
      previewStoreDeletion.mockResolvedValue(preview());
      consoleReauthenticate.mockResolvedValue({ status: 403, error: err("reauth_failed") });
      renderDialog();
      await fillIn();
      fireEvent.click(commitButton());
      expect(
        await screen.findByText("Could not verify who you are. Check the password and try again."),
      ).toBeTruthy();
      expect(screen.getByText("req-9")).toBeTruthy();
      expect(consoleDeleteStore).not.toHaveBeenCalled();
      expect(passwordInput().value).toBe("");
      expect(screen.queryByText("server words never show")).toBeNull();
    });

    test("an identity provider outage says nothing was deleted", async () => {
      previewStoreDeletion.mockResolvedValue(preview());
      consoleReauthenticate.mockResolvedValue({
        status: 503,
        error: err("identity_provider_unavailable"),
      });
      renderDialog();
      await fillIn();
      fireEvent.click(commitButton());
      expect(await screen.findByText(/Nothing was deleted\. Try again later\./)).toBeTruthy();
      expect(consoleDeleteStore).not.toHaveBeenCalled();
    });

    test("a grant that is gone on the delete (403 reauth_required) asks for the password again", async () => {
      previewStoreDeletion.mockResolvedValue(preview());
      consoleDeleteStore.mockResolvedValue({ status: 403, error: err("reauth_required") });
      renderDialog();
      await commitClean();
      expect(await screen.findByText(/The password confirmation expired/)).toBeTruthy();
      // A new attempt re-authenticates and takes a new key.
      consoleReauthenticate.mockResolvedValue(grant("grant-2"));
      consoleDeleteStore.mockResolvedValue({ status: 200, data: {}, replayed: false });
      fireEvent.change(passwordInput(), { target: { value: "again" } });
      fireEvent.click(commitButton());
      await screen.findByText("The store is deleted.");
      expect(consoleReauthenticate).toHaveBeenCalledTimes(2);
      const [first, second] = consoleDeleteStore.mock.calls;
      expect(second[1].reauthToken).toBe("grant-2");
      expect(second[2]).not.toBe(first[2]);
    });
  });

  test("a stale preview (409) reads the preview again and sends nothing more", async () => {
    previewStoreDeletion
      .mockResolvedValueOnce(preview())
      .mockResolvedValue(preview({ fingerprint: "newer-fingerprint" }));
    consoleDeleteStore.mockResolvedValue({ status: 409, error: err("preview_stale") });
    renderDialog();
    await commitClean();
    expect(await screen.findByText(/The store changed since the check/)).toBeTruthy();
    await waitFor(() => expect(previewStoreDeletion).toHaveBeenCalledTimes(2));
    expect(consoleDeleteStore).toHaveBeenCalledTimes(1);
    // The next confirm carries the new fingerprint, with a fresh grant.
    consoleReauthenticate.mockResolvedValue(grant("grant-2"));
    consoleDeleteStore.mockResolvedValue({ status: 200, data: {}, replayed: false });
    await waitFor(() => expect(commitButton()).toBeTruthy());
    fireEvent.change(passwordInput(), { target: { value: "pw" } });
    await waitFor(() => expect((commitButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(commitButton());
    await screen.findByText("The store is deleted.");
    expect(consoleDeleteStore.mock.calls[1][1].previewFingerprint).toBe("newer-fingerprint");
  });

  describe("an unclear answer", () => {
    test.each([[503], [425], [0]])(
      "%i keeps the attempt: Try again resends the same body with the same grant and key, and never re-authenticates",
      async (status) => {
        previewStoreDeletion.mockResolvedValue(preview());
        consoleDeleteStore.mockResolvedValueOnce({ status, error: undefined });
        renderDialog();
        await commitClean();
        const retry = await screen.findByRole("button", { name: "Try again" });
        consoleDeleteStore.mockResolvedValue({ status: 200, data: {}, replayed: true });
        fireEvent.click(retry);
        await screen.findByText("This store is already deleted. Nothing changed.");
        expect(consoleReauthenticate).toHaveBeenCalledTimes(1);
        expect(consoleDeleteStore).toHaveBeenCalledTimes(2);
        const [a, b] = consoleDeleteStore.mock.calls;
        expect(b[1]).toEqual(a[1]);
        expect(b[2]).toBe(a[2]);
      },
    );

    test("a 429 offers the resend too, with the cap told apart from the rate limit", async () => {
      previewStoreDeletion.mockResolvedValue(preview());
      consoleDeleteStore.mockResolvedValue({
        status: 429,
        error: err("force_action_rate_limited"),
      });
      renderDialog();
      await commitClean();
      expect(await screen.findByText(/reached its hourly limit/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    });
  });

  test("a support session or a non-owner answer reads as itself and offers no resend", async () => {
    previewStoreDeletion.mockResolvedValue(preview());
    consoleDeleteStore.mockResolvedValue({ status: 403, error: err("store_deletion_owner_only") });
    renderDialog();
    await commitClean();
    expect(await screen.findByText("Only the account owner can delete a store.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  describe("the preview read fails", () => {
    test("403 reads as owner only, with no retry", async () => {
      previewStoreDeletion.mockResolvedValue({
        status: 403,
        error: err("store_deletion_owner_only"),
      });
      renderDialog();
      expect(await screen.findByText("Only the account owner can delete a store.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Confirm deleting/ })).toBeNull();
    });

    test("404 is the non-disclosing not-available, with no retry", async () => {
      previewStoreDeletion.mockResolvedValue({ status: 404 });
      renderDialog();
      expect(
        await screen.findByText(/not available for your access, or the store does not exist/),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    test("a failure offers Try again, which reads the preview again", async () => {
      previewStoreDeletion.mockResolvedValueOnce({ status: 500, error: err("boom") });
      renderDialog();
      const retry = await screen.findByRole("button", { name: "Try again" });
      expect(screen.getByText(/Nothing changed/)).toBeTruthy();
      previewStoreDeletion.mockResolvedValue(preview());
      fireEvent.click(retry);
      expect(await screen.findByText("The store disappears from the lists.")).toBeTruthy();
    });
  });

  test("Escape cancels without deleting, and Cancel closes it as not deleted", async () => {
    previewStoreDeletion.mockResolvedValue(preview());
    renderDialog();
    await screen.findByText("The store disappears from the lists.");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(consoleDeleteStore).not.toHaveBeenCalled();
  });

  test("Tab stays inside the panel", async () => {
    previewStoreDeletion.mockResolvedValue(preview());
    renderDialog();
    await fillIn();
    const dialog = screen.getByRole("dialog");
    const last = within(dialog).getByRole("button", { name: "Confirm deleting the store" });
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
