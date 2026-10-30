import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-930 (RT-777 as-built P1-2): a renew or end answered 409
 * `support_session_absent` sends the operator to the directory, which then says
 * why, in a persistent notice that names the lost session's tenant. The network
 * boundary is stubbed; codes are those of the pinned contract.
 */
const getActiveContext = vi.fn();
const renewSupportSession = vi.fn();
const endSupportSession = vi.fn();
const listTenants = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return {
    ...actual,
    getActiveContext: (...a: unknown[]) => getActiveContext(...a),
    refreshSession: vi.fn(),
    signOut: async () => ({ status: 204 }),
  };
});
vi.mock("@/lib/support-session-queries", () => ({
  renewSupportSession: (...a: unknown[]) => renewSupportSession(...a),
  endSupportSession: (...a: unknown[]) => endSupportSession(...a),
  openSupportSession: vi.fn(),
}));
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listTenants: (...a: unknown[]) => listTenants(...a) };
});

import { ActiveContextProvider } from "@/context/ActiveContextProvider";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";
import { resetSupportSessionExpiry } from "@/lib/support-session-expiry";
import { getSessionGone, resetSessionGone, setSessionGone } from "@/platform/session/sessionGone";
import { ProtectedArea } from "@/shell/ProtectedArea";
import { platformRoutes } from "@/shell/platformRoutes";
import { loadPlatformPages } from "./platform-pages";

// RT-944: load the lazily routed pages before any test waits for one.
await loadPlatformPages();

const NOW = Date.parse("2026-10-22T10:00:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const admin = { id: "u1", email: "ops@kemetra.test", display_name: "Ops", is_platform_admin: true };

function sessionSummary(id = "s1") {
  return {
    id,
    tenant_id: "t1",
    purpose: "incident",
    ticket_ref: "SUP-2291",
    status: "active",
    expires_at: at(40 * MIN),
    renewal_cap_at: at(8 * 60 * MIN),
  };
}

function context(
  support_session: unknown,
  activeTenant: unknown = { id: "t1", name: "Delta Markets" },
) {
  return {
    user: admin,
    active_tenant: activeTenant,
    active_store: null,
    active_role_code: "owner",
    memberships: [{ tenant_id: "t9", tenant_name: "Kemetra Internal", role_code: "owner" }],
    support_session,
  };
}

const noSession = { user: admin, active_tenant: null, memberships: [], support_session: null };

function Where(): React.JSX.Element {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

let qc: QueryClient;

function mount(path: string): void {
  qc = createQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ActiveContextProvider>
          <Where />
          <Routes>
            {platformRoutes}
            <Route path="/" element={<ProtectedArea />}>
              <Route index element={<h1>Tenant surface</h1>} />
            </Route>
          </Routes>
        </ActiveContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function serve(ctx: unknown): void {
  getActiveContext.mockResolvedValue({ status: 200, data: ctx });
}

const res = (status: number, code?: string, data?: unknown) => ({
  status,
  data,
  error: code ? { error: { code, message: "x", request_id: "req-9" } } : undefined,
});

const RENEW_COPY =
  "The support session for Delta Markets ended before it could be renewed: it was ended or replaced elsewhere. Nothing changed in the organization. Open a new session to continue.";
const END_COPY =
  "The support session for Delta Markets had already ended before you could end it: it was ended or replaced elsewhere. Nothing changed in the organization. Open a new session to continue.";

const bar = () => screen.findByRole("region", { name: "Support session" });
/** The notice: the polite status region holding the explanation. */
async function notice(): Promise<HTMLElement> {
  const text = await screen.findByText(/^The support session for /);
  const region = screen.getAllByRole("status").find((el) => el.contains(text));
  if (!region) throw new Error("the explanation is not inside a status region");
  return region;
}
const noNotice = () => expect(screen.queryByText(/^The support session for /)).toBeNull();

async function goneBy(action: "Renew session" | "End session", from = "/platform/tenants") {
  mount(from);
  await bar();
  serve(noSession);
  fireEvent.click(screen.getByRole("button", { name: action }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Support session" })).toBeNull());
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/platform/tenants"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  resetRateLimit();
  resetSupportSessionExpiry();
  resetSessionGone();
  for (const m of [getActiveContext, renewSupportSession, endSupportSession, listTenants]) {
    m.mockReset();
  }
  listTenants.mockResolvedValue({ status: 200, data: [], error: undefined });
});
afterEach(() => vi.useRealTimers());

describe("the reason hand-off", () => {
  test("renew 409 support_session_absent records a renew reason with the lost session's tenant", async () => {
    serve(context(sessionSummary()));
    renewSupportSession.mockResolvedValue(res(409, "support_session_absent"));
    await goneBy("Renew session");
    expect(getSessionGone()).toEqual({
      action: "renew",
      userId: "u1",
      sessionId: "s1",
      tenantId: "t1",
      tenantName: "Delta Markets",
    });
  });

  test("end 409 support_session_absent records an end reason with the lost session's tenant", async () => {
    serve(context(sessionSummary()));
    endSupportSession.mockResolvedValue(res(409, "support_session_absent"));
    await goneBy("End session", "/");
    expect(getSessionGone()).toEqual({
      action: "end",
      userId: "u1",
      sessionId: "s1",
      tenantId: "t1",
      tenantName: "Delta Markets",
    });
  });

  test("a successful end records no reason", async () => {
    serve(context(sessionSummary()));
    endSupportSession.mockResolvedValue(res(200, undefined, { status: "ended" }));
    await goneBy("End session");
    expect(getSessionGone()).toBeNull();
  });

  test("other renew outcomes record no reason", async () => {
    serve(context(sessionSummary()));
    renewSupportSession.mockResolvedValue(res(409, "support_session_expired"));
    mount("/platform/tenants");
    await bar();
    fireEvent.click(screen.getByRole("button", { name: "Renew session" }));
    await waitFor(() => expect(renewSupportSession).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getSessionGone()).toBeNull();
  });
});

describe("the directory notice", () => {
  test("after renew: a polite notice names the tenant, says what happened and takes focus", async () => {
    serve(context(sessionSummary()));
    renewSupportSession.mockResolvedValue(res(409, "support_session_absent"));
    await goneBy("Renew session");
    const shown = await notice();
    expect(shown.textContent).toContain(RENEW_COPY);
    await waitFor(() => expect(document.activeElement).toBe(shown));
    // Polite, never an alert.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("after end from the tenant shell: the end variant shows on the directory", async () => {
    serve(context(sessionSummary()));
    endSupportSession.mockResolvedValue(res(409, "support_session_absent"));
    await goneBy("End session", "/");
    expect((await notice()).textContent).toContain(END_COPY);
  });

  test("dismiss removes it and it does not come back", async () => {
    serve(context(sessionSummary()));
    renewSupportSession.mockResolvedValue(res(409, "support_session_absent"));
    await goneBy("Renew session");
    await notice();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    noNotice();
    expect(getSessionGone()).toBeNull();
  });

  test("a new session clears it", async () => {
    serve(context(sessionSummary()));
    renewSupportSession.mockResolvedValue(res(409, "support_session_absent"));
    await goneBy("Renew session");
    await notice();
    // The operator opens another session (the drawer re-reads the context).
    serve(context(sessionSummary("s2")));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["activeContext"] });
    });
    await bar();
    noNotice();
    expect(getSessionGone()).toBeNull();
  });

  test("a normal visit and a successful end show no notice", async () => {
    serve(noSession);
    mount("/platform/tenants");
    await screen.findByRole("heading", { level: 1, name: "Organizations" });
    noNotice();
    cleanup();

    serve(context(sessionSummary()));
    endSupportSession.mockResolvedValue(res(200, undefined, { status: "ended" }));
    await goneBy("End session");
    await screen.findByRole("heading", { level: 1, name: "Organizations" });
    noNotice();
  });

  test("sign-out forgets it, so the next sign-in in this tab starts without it", async () => {
    serve(context(sessionSummary()));
    renewSupportSession.mockResolvedValue(res(409, "support_session_absent"));
    await goneBy("Renew session");
    await notice();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/signin"));
    expect(getSessionGone()).toBeNull();
  });

  test("a reason recorded for another user never shows", async () => {
    setSessionGone({
      action: "renew",
      userId: "u0",
      sessionId: "s1",
      tenantId: "t1",
      tenantName: "Delta Markets",
    });
    serve(noSession);
    mount("/platform/tenants");
    await screen.findByRole("heading", { level: 1, name: "Organizations" });
    noNotice();
  });

  test("the tenant name falls back to the directory when the context did not carry it", async () => {
    listTenants.mockResolvedValue({
      status: 200,
      data: [{ id: "t1", slug: "delta", name: "Delta Markets" }],
      error: undefined,
    });
    serve(context(sessionSummary(), null));
    renewSupportSession.mockResolvedValue(res(409, "support_session_absent"));
    await goneBy("Renew session");
    expect((await notice()).textContent).toContain(RENEW_COPY);
  });
});
