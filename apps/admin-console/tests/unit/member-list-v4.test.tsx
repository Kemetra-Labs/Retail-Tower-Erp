import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const listMembers = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return { ...actual, listMembers: (...a: unknown[]) => listMembers(...a) };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { MemberList } from "@/operators/MemberList";

function renderList(): ReturnType<typeof render> {
  const qc = createQueryClient();
  function Tree({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(
    <Tree>
      <MemberList />
    </Tree>,
  );
}

const withTenant = { context: { active_tenant: { id: "t1", name: "Northstar Retail" } } };

const member = (id: string, name: string | null, role: string, revoked = false) => ({
  membership_id: id,
  user: { id: `u-${id}`, email: `${id}@northstar.eg`, display_name: name },
  role_code: role,
  store_access_kind: "all",
  accessible_store_ids: [],
  revoked_at: revoked ? "2026-06-01T00:00:00Z" : null,
});

beforeEach(() => {
  setLocale("en");
  listMembers.mockReset();
  activeContext.mockReset();
  activeContext.mockReturnValue(withTenant);
});

/** RT-1014 (v4.0) band facts: the counts of the whole, unpaged list (AC 1). */
describe("MemberList band facts", () => {
  test("total, active and revoked counts equal the full list and are named", async () => {
    listMembers.mockResolvedValue({
      status: 200,
      data: [
        member("m1", "Amal Saleh", "tenant_admin"),
        member("m2", "Omar Khaled", "store_manager"),
        member("m3", "Sara Fathy", "cashier", true),
      ],
    });
    renderList();
    const facts = await screen.findByLabelText("Membership summary");
    for (const [label, value] of [
      ["Memberships", "3"],
      ["Active memberships", "2"],
      ["Revoked memberships", "1"],
    ]) {
      const fact = within(facts).getByText(label).parentElement as HTMLElement;
      expect(within(fact).getByText(value)).toBeDefined();
    }
  });

  test("the avatar pile is decoration, hidden from assistive technology", async () => {
    listMembers.mockResolvedValue({
      status: 200,
      data: ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => member(id, `Person ${id}`, "cashier")),
    });
    renderList();
    const facts = await screen.findByLabelText("Membership summary");
    const pile = facts.querySelector(".member-pile");
    expect(pile?.getAttribute("aria-hidden")).toBe("true");
    // Four avatars, then «+2» for the other two loaded active members.
    expect(pile?.querySelectorAll(".avatar")).toHaveLength(4);
    expect(pile?.textContent).toContain("+2");
  });

  test("no facts while loading", () => {
    listMembers.mockReturnValue(new Promise(() => undefined));
    renderList();
    expect(screen.queryByLabelText("Membership summary")).toBeNull();
    expect(screen.getByRole("status")).toBeDefined();
  });

  test("no facts on a 404", async () => {
    listMembers.mockResolvedValue({ status: 404, error: { error: { request_id: "req-404" } } });
    renderList();
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.queryByLabelText("Membership summary")).toBeNull();
  });

  test("no facts on the empty state", async () => {
    listMembers.mockResolvedValue({ status: 200, data: [] });
    renderList();
    expect(await screen.findByText(/no other members/i)).toBeDefined();
    expect(screen.queryByLabelText("Membership summary")).toBeNull();
  });

  test("Arabic: the facts are named in Arabic", async () => {
    setLocale("ar");
    listMembers.mockResolvedValue({
      status: 200,
      data: [member("m1", "Amal Saleh", "tenant_admin")],
    });
    renderList();
    const facts = await screen.findByLabelText("ملخص العضويات");
    for (const label of ["العضويات", "عضويات نشطة", "عضويات مُبطلة"]) {
      expect(within(facts).getByText(label)).toBeDefined();
    }
  });
});

/** The role-grouped rows: every member reachable, the same open action (AC 2). */
describe("MemberList grouped by role", () => {
  const mixed = [
    member("m1", "Cara Cashier", "cashier"),
    member("m2", "Omar Khaled", "store_manager", true),
    member("m3", "Amal Saleh", "tenant_admin"),
    member("m4", "Sami Store", "store_manager"),
    member("m5", "Una Known", "store_staff"),
    member("m6", null, "mystery_role"),
  ];

  test("groups in a fixed role order, unknown roles last, active before revoked", async () => {
    listMembers.mockResolvedValue({ status: 200, data: mixed });
    const { container } = renderList();
    await screen.findByRole("table");
    const names = [...container.querySelectorAll(".member-group__name")].map((n) => n.textContent);
    expect(names).toEqual(["Tenant admin", "Store manager", "Cashier", "Unknown role"]);
    const counts = [...container.querySelectorAll(".member-group__count")].map(
      (n) => n.textContent,
    );
    expect(counts).toEqual(["1", "2", "1", "2"]);
    // Inside «Store manager» the active member leads the revoked one.
    const managers = container.querySelectorAll("tbody")[1] as HTMLElement;
    expect(
      within(managers)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Open Sami Store", "Open Omar Khaled"]);
  });

  test("every member is in exactly one group and keeps the same open action name", async () => {
    listMembers.mockResolvedValue({ status: 200, data: mixed });
    renderList();
    await screen.findByRole("table");
    const opens = screen.getAllByRole("button", { name: /^Open / });
    expect(opens.map((b) => b.getAttribute("aria-label")).sort()).toEqual(
      [
        "Open Amal Saleh",
        "Open Cara Cashier",
        "Open Omar Khaled",
        "Open Sami Store",
        "Open Una Known",
        // No display name: the e-mail names the member, as before the regroup.
        "Open m6@northstar.eg",
      ].sort(),
    );
    // The header row, one row per group and one row per member.
    expect(screen.getAllByRole("row")).toHaveLength(1 + 4 + mixed.length);
    // One «Role» column header, whatever the number of groups.
    expect(screen.getAllByRole("columnheader", { name: "Role" })).toHaveLength(1);
    // A raw role code never reaches the page.
    expect(screen.queryByText("store_staff")).toBeNull();
    expect(screen.queryByText("mystery_role")).toBeNull();
  });

  test("the open action in a group opens that member's edit drawer with the scope line in its header", async () => {
    listMembers.mockResolvedValue({ status: 200, data: mixed });
    renderList();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Open Omar Khaled" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit member" });
    expect(within(dialog).getByText("Omar Khaled")).toBeDefined();
    expect(within(dialog).getByText(/^Editing/)).toBeDefined();
  });

  test("the section has its heading and no section-index badge (a single panel)", async () => {
    listMembers.mockResolvedValue({ status: 200, data: mixed });
    const { container } = renderList();
    expect(await screen.findByRole("heading", { level: 2, name: "Tenant members" })).toBeDefined();
    expect(container.querySelector(".section-index")).toBeNull();
  });
});
