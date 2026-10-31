import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const listAuditEvents = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return { ...actual, listAuditEvents: (...a: unknown[]) => listAuditEvents(...a) };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { AuditSearch } from "@/audit/AuditSearch";
import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";

function renderSearch(): void {
  const qc = createQueryClient();
  function Tree({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  render(
    <Tree>
      <AuditSearch />
    </Tree>,
  );
}

const withTenant = {
  context: { active_tenant: { id: "t1", name: "Northstar Retail" }, active_store: null },
};

function row(id: string, action: string, metadata?: Record<string, unknown>) {
  return {
    id,
    occurred_at: "2026-06-01T09:30:00Z",
    action,
    actor_user_id: "c91e2a07-44b8-4d61-9f0a-7a3e15b2c8d4",
    request_id: "req_01JBX2R5K8VD",
    metadata,
  };
}

/** The one results panel, found by its heading: a group, not a landmark. */
function resultsPanel(): HTMLElement {
  const panel = screen.getByRole("heading", { name: "Audit events" }).closest(".audit-results");
  if (!(panel instanceof HTMLElement)) throw new Error("results panel not found");
  return panel;
}

function apply(): void {
  fireEvent.click(screen.getByRole("button", { name: /apply|تطبيق/i }));
}

/**
 * RT-1019 (v4.0): the audit search's band note, its one results panel for every
 * state, the refused-access edge and the drawer's scope line. The behaviour
 * (queries, keys, RT-269 keep-rows) is asserted by the neighbouring specs.
 */
describe("AuditSearch v4.0 (RT-1019)", () => {
  beforeEach(() => {
    setLocale("en");
    listAuditEvents.mockReset();
    activeContext.mockReset();
    activeContext.mockReturnValue(withTenant);
  });

  test("the band states that times are UTC as recorded, the zone isolated LTR", () => {
    renderSearch();
    const note = screen.getByText(/^Times are/, { selector: "p" });
    expect(note.textContent).toBe("Times are UTC as recorded");
    expect(within(note).getByText("UTC").closest("bdi")?.getAttribute("dir")).toBe("ltr");
    // The note sits in the band, which shows no total for a paged list.
    expect(note.closest("header")?.querySelector("h1")?.textContent).toBe("Audit");
    expect(note.closest("header")?.querySelector(".list-band__facts")).toBeNull();
  });

  test("Arabic: the same note and hint, with the zone in Latin", () => {
    setLocale("ar");
    renderSearch();
    const note = screen.getByText(/كما سُجّلت/);
    expect(note.textContent).toBe("الأوقات بتوقيت UTC كما سُجّلت");
    const hint = "كل صف دليل كما سُجّل: لا يُترجم الرمز ولا تُحوَّل الأوقات.";
    expect(screen.getByText(hint)).toBeDefined();
  });

  test("one named results panel holds the prompt, then the rows", async () => {
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: { items: [row("e1", "shift.forced_close")], next_cursor: null },
    });
    renderSearch();
    const panel = resultsPanel();
    expect(within(panel).getByText(/search audit activity/i)).toBeDefined();
    expect(within(panel).getByText(/not translated and times are not converted/i)).toBeDefined();

    apply();
    expect(await within(panel).findByText("shift.forced_close")).toBeDefined();
    expect(within(panel).getByText("Showing 1")).toBeDefined();
    // A single panel: no section index.
    expect(document.querySelector(".section-index")).toBeNull();
  });

  test("a refused search is a danger alert inside the panel", async () => {
    listAuditEvents.mockResolvedValue({ status: 403, error: { error: { request_id: "r-403" } } });
    renderSearch();
    apply();
    const panel = resultsPanel();
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toContain("You do not have permission to view audit for this scope.");
    expect(within(alert).getByText("r-403").closest("bdi")?.getAttribute("dir")).toBe("ltr");
  });

  test("a failed Load more keeps the rows and offers the retry, inside the panel (RT-269)", async () => {
    listAuditEvents
      .mockResolvedValueOnce({
        status: 200,
        data: { items: [row("e1", "shift.forced_close")], next_cursor: "c1" },
      })
      .mockResolvedValueOnce({ status: 500, error: { error: { request_id: "r-500" } } });
    renderSearch();
    apply();
    const panel = resultsPanel();
    expect(await within(panel).findByText("shift.forced_close")).toBeDefined();
    fireEvent.click(within(panel).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(panel).getByRole("alert")).toBeDefined());
    expect(within(panel).getByText("shift.forced_close")).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Retry" })).toBeDefined();
    expect(within(panel).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("only a refused platform access carries the red edge, beside its label", async () => {
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: {
        items: [
          row("e1", "platform.cross_tenant.accessed", { outcome: "rejected" }),
          row("e2", "platform.cross_tenant.accessed", { outcome: "granted" }),
          row("e3", "shift.forced_close"),
        ],
        next_cursor: null,
      },
    });
    renderSearch();
    apply();
    expect(await screen.findByText("Platform support access refused")).toBeDefined();
    const refused = document.querySelectorAll(".audit-table__row--refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.textContent).toContain("Platform support access refused");
  });

  test("the drawer's scope line names the tenant", async () => {
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: { items: [row("e1", "shift.forced_close")], next_cursor: null },
    });
    renderSearch();
    apply();
    fireEvent.click(await screen.findByText("shift.forced_close"));
    const drawer = await screen.findByRole("dialog", { name: "Audit event" });
    expect(within(drawer).getByText("Northstar Retail")).toBeDefined();
  });

  test("with a store in scope, the drawer's scope line names tenant and store", async () => {
    activeContext.mockReturnValue({
      context: {
        active_tenant: { id: "t1", name: "Northstar Retail" },
        active_store: { id: "s1", name: "Maadi Branch" },
      },
    });
    listAuditEvents.mockResolvedValue({
      status: 200,
      data: { items: [row("e1", "shift.forced_close")], next_cursor: null },
    });
    renderSearch();
    apply();
    fireEvent.click(await screen.findByText("shift.forced_close"));
    const drawer = await screen.findByRole("dialog", { name: "Audit event" });
    expect(within(drawer).getByText("Northstar Retail")).toBeDefined();
    expect(within(drawer).getByText("Maadi Branch")).toBeDefined();
  });
});
