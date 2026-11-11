import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-1329: the Platform Console "POS pilot" page against a stubbed network
 * boundary. The two reads are those agreed with RT-1328 (`{ items }` of the
 * contract's PilotRelease / PilotTenant); the writes answer with the statuses
 * and codes of `pos-pilot-releases.openapi.yaml`.
 */
const getActiveContext = vi.fn();
const listTenants = vi.fn();
const listReleases = vi.fn();
const listPilotTenants = vi.fn();
const activate = vi.fn();
const addTenant = vi.fn();
const removeTenant = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return {
    ...actual,
    getActiveContext: (...a: unknown[]) => getActiveContext(...a),
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  };
});
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listTenants: (...a: unknown[]) => listTenants(...a) };
});
vi.mock("@/lib/pilot-platform-queries", () => ({
  platformListPilotReleases: (...a: unknown[]) => listReleases(...a),
  platformListPilotTenants: (...a: unknown[]) => listPilotTenants(...a),
  platformActivatePilotRelease: (...a: unknown[]) => activate(...a),
  platformAddPilotTenant: (...a: unknown[]) => addTenant(...a),
  platformRemovePilotTenant: (...a: unknown[]) => removeTenant(...a),
}));

import { ActiveContextProvider } from "@/context/ActiveContextProvider";
import { createQueryClient } from "@/lib/query";
import { reportRateLimited, resetRateLimit } from "@/lib/rate-limit";
import { PLATFORM_NAV, tenantNav } from "@/shell/nav-model";
import { platformRoutes } from "@/shell/platformRoutes";
import { loadPlatformPages } from "./platform-pages";

await loadPlatformPages();

const admin = { id: "u1", email: "ops@kemetra.test", display_name: "Ops", is_platform_admin: true };
const ctx = (user: unknown) => ({
  user,
  active_tenant: null,
  active_store: null,
  memberships: [],
  support_session: null,
});

const DELTA = "0190f000-0000-7000-8000-0000000000d1";
const NILE = "0190f000-0000-7000-8000-0000000000d2";
const RAYAN = "0190f000-0000-7000-8000-0000000000d3";
const GONE = "0190f000-0000-7000-8000-0000000000d9";
const TENANTS = [
  { id: DELTA, slug: "delta-markets", name: "Delta Markets" },
  { id: NILE, slug: "nile-pharma", name: "Nile Pharma" },
  { id: RAYAN, slug: "rayan", name: "Rayan Trading" },
];

const release = (id: string, version: string, over: Record<string, unknown> = {}) => ({
  releaseId: id,
  version,
  sha256: "abcdef012345".padEnd(64, "0"),
  sizeBytes: 100_000_000,
  publisher: "CN=Kemetra Pilot",
  signingClass: "pilot",
  attestationRef: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/42",
  sourceSha: "c".repeat(40),
  approved: true,
  approvedBy: "kemetra-owner",
  approvedAt: "2026-11-10T10:00:00Z",
  promotionRunUrl: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/123",
  artifactVersionId: "v1",
  registeredAt: "2026-11-10T10:05:00Z",
  withdrawnAt: null,
  withdrawnBy: null,
  activatedAt: null,
  activatedByUserId: null,
  ...over,
});
const R013 = "0190f000-0000-7000-8000-00000000a013";
const R012 = "0190f000-0000-7000-8000-00000000a012";
const R011 = "0190f000-0000-7000-8000-00000000a011";
const RELEASES = [
  release(R013, "0.1.3"),
  release(R012, "0.1.2", { activatedAt: "2026-11-01T09:00:00Z" }),
  release(R011, "0.1.1", {
    activatedAt: "2026-10-20T09:00:00Z",
    withdrawnAt: "2026-10-30T09:00:00Z",
    withdrawnBy: "kemetra-owner",
  }),
];
const pilot = (tenantId: string) => ({
  tenantId,
  addedAt: "2026-11-11T08:00:00Z",
  addedByUserId: "0190f000-0000-7000-8000-0000000000aa",
});

const ok = (data: unknown) => ({ status: 200, data, error: undefined });
const res = (status: number, code?: string, requestId = "req-9") => ({
  status,
  data: undefined,
  error: code ? { error: { code, message: "x", request_id: requestId } } : undefined,
});

function mount(path = "/platform/pos-pilot"): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ActiveContextProvider>
          <Routes>
            {platformRoutes}
            <Route path="/" element={<h1>Tenant surface</h1>} />
          </Routes>
        </ActiveContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Messages isolate names and versions (FSI/LRI…PDI); match the visible text. */
const plain = { normalizer: (s: string) => s.replace(/[\u2066-\u2069]/g, "").trim() };
const notice = (message: string) => screen.findByText(message, plain);

const releasesTable = () => screen.findByRole("table", { name: "Pilot releases" });
const allowlistTable = () => screen.findByRole("table", { name: "Pilot allowlist" });
const rowOf = async (table: () => Promise<HTMLElement>, text: string) => {
  const rows = within(await table()).getAllByRole("row");
  const row = rows.find((r) => within(r).queryByText(text));
  if (!row) throw new Error(`no row with ${text}`);
  return row;
};

beforeEach(() => {
  resetRateLimit();
  for (const m of [
    getActiveContext,
    listTenants,
    listReleases,
    listPilotTenants,
    activate,
    addTenant,
    removeTenant,
  ]) {
    m.mockReset();
  }
  getActiveContext.mockResolvedValue({ status: 200, data: ctx(admin) });
  listTenants.mockResolvedValue(ok(TENANTS));
  listReleases.mockResolvedValue(ok({ items: RELEASES }));
  listPilotTenants.mockResolvedValue(ok({ items: [pilot(NILE), pilot(GONE)] }));
});
afterEach(() => cleanup());

describe("navigation and access", () => {
  test("the platform nav lists the page; the in-session tenant nav does not", () => {
    const platform = PLATFORM_NAV.flatMap((g) => g.entries.map((e) => e.to));
    expect(platform).toEqual(["/platform/tenants", "/platform/pos-pilot"]);
    const session = tenantNav("owner", true).flatMap((g) => g.entries.map((e) => e.to));
    expect(session).toEqual(["/platform/tenants"]);
  });

  test.each(["owner", "tenant_admin", "store_manager"])(
    "a tenant user (%s) gets the no-access state and no pilot read is sent",
    async (role) => {
      getActiveContext.mockResolvedValue({
        status: 200,
        data: {
          ...ctx({ ...admin, is_platform_admin: false }),
          active_tenant: { id: DELTA, name: "Delta Markets" },
          active_role_code: role,
          memberships: [{ tenant_id: DELTA, tenant_name: "Delta Markets", role_code: role }],
        },
      });
      mount();
      await waitFor(() => expect(getActiveContext).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByRole("heading", { level: 1 })).not.toBeNull());
      expect(screen.queryByRole("heading", { name: "POS pilot" })).toBeNull();
      expect(listReleases).not.toHaveBeenCalled();
      expect(listPilotTenants).not.toHaveBeenCalled();
    },
  );
});

describe("releases", () => {
  test("every release with its state; Activate only on the registered, approved one", async () => {
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "POS pilot" })).toBeDefined();
    const rows = within(await releasesTable())
      .getAllByRole("row")
      .slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("Registered")).toBeDefined();
    expect(within(rows[1]).getByText("Current")).toBeDefined();
    expect(within(rows[2]).getByText("Withdrawn")).toBeDefined();
    expect(within(rows[0]).getByText("abcdef012345")).toBeDefined();
    expect(within(rows[0]).getByText("100 MB")).toBeDefined();
    expect(within(rows[0]).getByRole("link", { name: "Promotion run" })).toHaveProperty(
      "href",
      "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/123",
    );
    expect(screen.getAllByRole("button", { name: /^Activate version/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  test("an unapproved release offers no Activate", async () => {
    listReleases.mockResolvedValue(ok({ items: [release(R013, "0.1.3", { approved: false })] }));
    mount();
    await releasesTable();
    expect(screen.getByText("Not approved")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Activate version/ })).toBeNull();
  });

  test("activate: a confirm naming the version, then the call and a refetch", async () => {
    activate.mockResolvedValue({ status: 200 });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Activate version 0.1.3" }));
    const confirm = screen.getByRole("region", { name: "Confirm release activation" });
    expect(within(confirm).getByText("0.1.3")).toBeDefined();
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(activate).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm activation" }));
    expect(await notice("Version 0.1.3 is now the current release.")).toBeDefined();
    expect(activate).toHaveBeenCalledWith(R013);
    expect(activate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listReleases).toHaveBeenCalledTimes(2));
  });

  test("cancel sends nothing and returns focus to the Activate button", async () => {
    mount();
    const invoker = await screen.findByRole("button", { name: "Activate version 0.1.3" });
    invoker.focus();
    fireEvent.click(invoker);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Confirm release activation" })).toBeNull();
    expect(activate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(invoker);
  });

  test("while another release is current, the confirm says the activation will be refused", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Activate version 0.1.3" }));
    const confirm = screen.getByRole("region", { name: "Confirm release activation" });
    expect(confirm.textContent).toContain("Version 0.1.2 is current");
    expect(confirm.textContent).toContain("will be refused");
  });

  test("with no current release, the confirm promises the activation and focus lands on the panel after it", async () => {
    listReleases.mockResolvedValue(ok({ items: [release(R013, "0.1.3")] }));
    activate.mockResolvedValue({ status: 200 });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Activate version 0.1.3" }));
    const confirm = screen.getByRole("region", { name: "Confirm release activation" });
    expect(confirm.textContent).toContain("It becomes the current pilot release");
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm activation" }));
    expect(await notice("Version 0.1.3 is now the current release.")).toBeDefined();
    expect(document.activeElement?.id).toBe("pos-pilot-releases");
  });

  test("404: the release is gone, the list is read again", async () => {
    activate.mockResolvedValue(res(404, "not_found"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Activate version 0.1.3" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm activation" }));
    expect(
      await notice("This release no longer exists. The list is being read again."),
    ).toBeDefined();
    await waitFor(() => expect(listReleases).toHaveBeenCalledTimes(2));
  });

  test("a write 429: one message (the shell banner skips it), and no re-read into the window", async () => {
    activate.mockImplementation(async () => ({
      ...res(429, "rate_limited"),
      rateLimitSeq: reportRateLimited(30),
    }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Activate version 0.1.3" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm activation" }));
    expect(
      await notice("That didn't go through because of too many requests. Try again shortly."),
    ).toBeDefined();
    expect(screen.queryByText("Too many requests")).toBeNull();
    expect(listReleases).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  test("a 403 read says not permitted, with no retry", async () => {
    listReleases.mockResolvedValue(res(403, "forbidden"));
    mount();
    expect(await screen.findByText("You aren't permitted to do this.")).toBeDefined();
    expect(screen.queryAllByRole("button", { name: "Try again" })).toHaveLength(0);
  });

  test("a 200 without items is a failure, never an empty registry", async () => {
    listReleases.mockResolvedValue(ok({}));
    mount();
    expect(await screen.findByText("Couldn't load the releases.")).toBeDefined();
    expect(screen.queryByText("No registered releases")).toBeNull();
  });

  test.each([
    [
      "release_current_exists",
      "Another release is current. The promotion workflow must withdraw it before 0.1.3 can be activated. Nothing changed.",
    ],
    ["release_withdrawn", "Version 0.1.3 is withdrawn and can't be activated. Nothing changed."],
  ])("409 %s gets its own message, sent once, then a refetch", async (code, message) => {
    activate.mockResolvedValue(res(409, code));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Activate version 0.1.3" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm activation" }));
    expect(await notice(message)).toBeDefined();
    expect(activate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listReleases).toHaveBeenCalledTimes(2));
  });

  test("403 origin_rejected is 'not permitted'", async () => {
    activate.mockResolvedValue(res(403, "origin_rejected"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Activate version 0.1.3" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm activation" }));
    expect(await screen.findByText("You aren't permitted to do this.")).toBeDefined();
  });

  test("a failed list read names the failure with its request id and retries on demand", async () => {
    listReleases.mockResolvedValueOnce(res(500, "system_failure", "req-500"));
    mount();
    expect(await screen.findByText("Couldn't load the releases.")).toBeDefined();
    expect(screen.getByText("req-500")).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    expect(await releasesTable()).toBeDefined();
  });

  test("an empty registry says so", async () => {
    listReleases.mockResolvedValue(ok({ items: [] }));
    mount();
    expect(await screen.findByText("No registered releases")).toBeDefined();
  });
});

describe("allowlist", () => {
  test("names joined from the tenant list; an unknown tenant keeps its id", async () => {
    mount();
    const rows = within(await allowlistTable())
      .getAllByRole("row")
      .slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Nile Pharma")).toBeDefined();
    expect(within(rows[1]).getByText("Unknown organization")).toBeDefined();
    expect(within(rows[1]).getByText(GONE)).toBeDefined();
  });

  test("add: picks from the tenant list (no typed id), excluding listed ones; 201 is added", async () => {
    addTenant.mockResolvedValue({ status: 201 });
    mount();
    const select = await screen.findByLabelText("Add an organization");
    expect(select.tagName).toBe("SELECT");
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Choose an organization", "Delta Markets", "Rayan Trading"]);
    const submit = screen.getByRole("button", { name: "Add to pilot" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(select, { target: { value: RAYAN } });
    fireEvent.click(submit);
    expect(await notice("Rayan Trading was added to the pilot.")).toBeDefined();
    expect(addTenant).toHaveBeenCalledWith(RAYAN);
    await waitFor(() => expect(listPilotTenants).toHaveBeenCalledTimes(2));
  });

  test("add: 200 is 'already listed', 404 tenant_not_found refreshes the tenant list", async () => {
    addTenant.mockResolvedValueOnce({ status: 200 });
    mount();
    const select = await screen.findByLabelText("Add an organization");
    fireEvent.change(select, { target: { value: DELTA } });
    fireEvent.click(screen.getByRole("button", { name: "Add to pilot" }));
    expect(
      await notice("Delta Markets was already on the allowlist. Nothing changed."),
    ).toBeDefined();

    addTenant.mockResolvedValueOnce(res(404, "tenant_not_found"));
    fireEvent.change(screen.getByLabelText("Add an organization"), { target: { value: DELTA } });
    fireEvent.click(screen.getByRole("button", { name: "Add to pilot" }));
    expect(
      await notice("This organization no longer exists. The lists are being read again."),
    ).toBeDefined();
    await waitFor(() => expect(listTenants).toHaveBeenCalledTimes(2));
  });

  test("remove: a confirm naming the organization, then the call", async () => {
    removeTenant.mockResolvedValue({ status: 204 });
    mount();
    const row = await rowOf(allowlistTable, "Nile Pharma");
    fireEvent.click(within(row).getByRole("button", { name: "Remove Nile Pharma from the pilot" }));
    const confirm = screen.getByRole("region", { name: "Confirm organization removal" });
    expect(within(confirm).getByText("Nile Pharma")).toBeDefined();
    expect(removeTenant).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm removal" }));
    expect(await notice("Nile Pharma was removed from the pilot.")).toBeDefined();
    expect(removeTenant).toHaveBeenCalledWith(NILE);
    expect(removeTenant).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listPilotTenants).toHaveBeenCalledTimes(2));
  });

  test("a failed tenant list blocks Add with a reason and a retry; rows keep their ids", async () => {
    listTenants.mockResolvedValueOnce(res(500, "system_failure"));
    mount();
    expect(
      await screen.findByText("Couldn't load the organizations, so none can be added now."),
    ).toBeDefined();
    const table = await allowlistTable();
    expect(within(table).getByText(NILE)).toBeDefined();
    expect(within(table).queryByText("Unknown organization")).toBeNull();
    expect(screen.queryByLabelText("Add an organization")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Add an organization")).toBeDefined();
    expect(within(await allowlistTable()).getByText("Nile Pharma")).toBeDefined();
  });

  test("while the tenant names load: no 'all listed', no 'unknown'; ids only", async () => {
    listTenants.mockReturnValue(new Promise(() => {}));
    mount();
    const table = await allowlistTable();
    expect(screen.getByText("Loading organizations…")).toBeDefined();
    expect(screen.queryByText("Every organization is on the allowlist.")).toBeNull();
    expect(within(table).queryByText("Unknown organization")).toBeNull();
    expect(within(table).getByText(NILE)).toBeDefined();
  });

  test("a 429 on the allowlist read is said once (claimed) and not retried", async () => {
    listPilotTenants.mockImplementation(async () => ({
      ...res(429, "rate_limited"),
      rateLimitSeq: reportRateLimited(30),
    }));
    mount();
    expect(
      await screen.findByText(
        "That didn't go through because of too many requests. Try again shortly.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Too many requests")).toBeNull();
    expect(listPilotTenants).toHaveBeenCalledTimes(1);
  });
});
