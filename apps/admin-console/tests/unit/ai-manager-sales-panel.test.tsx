import { ManagerSalesMount } from "@/ai-manager-sales/ManagerSalesMount";
import { setLocale } from "@/i18n/locale";
import { translate } from "@/i18n/translate";
import { createQueryClient } from "@/lib/query";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  REQUEST_ID,
  STORES,
  STORE_A,
  STORE_B,
  TENANT_ID,
  answerBody,
  apiError,
  refusalBody,
  unavailableBody,
} from "./ai-manager-sales-fixtures";

/**
 * RT-1541 panel: role and flag gating, every state of RT-1526 §5.2, the request it sends, and
 * the rules it keeps (no arithmetic, text as text, a fresh Idempotency-Key per submit).
 */
interface Ctx {
  user?: { is_platform_admin?: boolean };
  active_tenant?: { id: string } | null;
  active_role_code?: string | null;
  memberships?: Array<{
    tenant_id: string;
    store_access_kind?: "all" | "specific";
    accessible_store_ids?: string[];
  }>;
}
let ctx: Ctx = {};
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({ context: ctx }),
}));
vi.mock("@/shift-closes/useShiftCloses", () => ({
  useStoreDirectory: () => ({ stores: STORES, ready: true }),
}));

const explain = vi.fn();
vi.mock("@/lib/ai-manager-sales-queries", () => ({
  consoleExplainSales: (...a: unknown[]) => explain(...a),
}));

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);

function owner(extra: Partial<Ctx> = {}): Ctx {
  return {
    active_tenant: { id: TENANT_ID },
    active_role_code: "owner",
    memberships: [{ tenant_id: TENANT_ID, store_access_kind: "all" }],
    ...extra,
  };
}

function mount(enabled = true) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ManagerSalesMount enabled={enabled} />
    </QueryClientProvider>,
  );
}

const ok = (data: unknown) => ({ status: 200, data });

async function ask(chip: string) {
  fireEvent.click(await screen.findByRole("button", { name: chip }));
  fireEvent.click(screen.getByRole("button", { name: t("aiManagerSales.ask") }));
}

beforeEach(() => {
  ctx = owner();
  explain.mockReset();
  setLocale("en");
});
afterEach(() => cleanup());

describe("who gets the panel", () => {
  test("the flag OFF: nothing rendered and nothing requested, for every role", async () => {
    for (const role of ["owner", "tenant_admin", "store_manager"]) {
      ctx = owner({ active_role_code: role });
      const { container } = mount(false);
      await Promise.resolve();
      expect(container.innerHTML).toBe("");
      cleanup();
    }
    expect(explain).not.toHaveBeenCalled();
  });

  test("the flag is OFF by default: no env value turns it on", async () => {
    const { container } = render(
      <QueryClientProvider client={createQueryClient()}>
        <ManagerSalesMount />
      </QueryClientProvider>,
    );
    await Promise.resolve();
    expect(import.meta.env.VITE_AI_MANAGER_SALES_PANEL).toBeUndefined();
    expect(container.innerHTML).toBe("");
  });

  test.each(["owner", "tenant_admin", "store_manager"])("%s sees the panel", async (role) => {
    ctx = owner({ active_role_code: role });
    mount();
    expect(await screen.findByRole("heading", { name: t("aiManagerSales.title") })).toBeTruthy();
  });

  test.each(["store_staff", "cashier", "", undefined])(
    "role %s: nothing rendered",
    async (role) => {
      ctx = owner({ active_role_code: role });
      const { container } = mount();
      await Promise.resolve();
      expect(container.innerHTML).toBe("");
    },
  );

  test("a platform admin never sees it, even with an organization open", async () => {
    ctx = owner({ user: { is_platform_admin: true } });
    const { container } = mount();
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });

  test("no active tenant: nothing rendered", async () => {
    ctx = { active_role_code: "owner", active_tenant: null };
    const { container } = mount();
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });
});

describe("ready to ask (U-1)", () => {
  test("every template chip is offered, T-11 is not, and nothing is sent until Ask", async () => {
    mount();
    const group = await screen.findByRole("group", { name: t("aiManagerSales.chips.legend") });
    expect(within(group).getAllByRole("button", { pressed: false })).toHaveLength(11);
    expect(screen.queryByText("T-11")).toBeNull();
    expect(explain).not.toHaveBeenCalled();
  });

  test("Ask with no choice says so and sends nothing", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: t("aiManagerSales.ask") }));
    expect(await screen.findByText(t("aiManagerSales.error.noChoice"))).toBeTruthy();
    expect(explain).not.toHaveBeenCalled();
  });

  test("a period over 31 days is refused client-side with the field error (U-11)", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText(t("sales.filter.from")), {
      target: { value: "2026-09-01" },
    });
    fireEvent.change(screen.getByLabelText(t("sales.filter.to")), {
      target: { value: "2026-11-01" },
    });
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("sales.filter.spanTooWide"))).toBeTruthy();
    expect(explain).not.toHaveBeenCalled();
  });

  test("an invalid currency is refused client-side", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText(t("aiManagerSales.currency.label")), {
      target: { value: "E" },
    });
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.error.currency"))).toBeTruthy();
    expect(explain).not.toHaveBeenCalled();
  });
});

describe("the request", () => {
  test("a chip sends its template with the controls' scope, and a fresh Idempotency-Key each submit", async () => {
    explain.mockResolvedValue(ok(answerBody()));
    mount();
    await ask(t("aiManagerSales.chip.T04"));
    await screen.findByText(t("aiManagerSales.announce.answer"));
    fireEvent.click(screen.getByRole("button", { name: t("aiManagerSales.ask") }));
    await waitFor(() => expect(explain).toHaveBeenCalledTimes(2));

    const [first, key1] = explain.mock.calls[0];
    const [, key2] = explain.mock.calls[1];
    expect(first).toMatchObject({
      templateId: "T-04",
      storeIds: [],
      currency: "EGP",
      locale: "en",
    });
    expect(Object.keys(first)).not.toContain("tenant_id");
    expect(key1).toMatch(/^[\x21-\x7E]{16,128}$/);
    expect(key2).toMatch(/^[\x21-\x7E]{16,128}$/);
    expect(key1).not.toBe(key2);
  });

  test("a question selects a template only: no template, the same controls", async () => {
    explain.mockResolvedValue(ok(refusalBody("unsupported_question")));
    mount();
    fireEvent.change(await screen.findByLabelText(t("aiManagerSales.question.label")), {
      target: { value: "show Nasr City please" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("aiManagerSales.ask") }));
    await waitFor(() => expect(explain).toHaveBeenCalled());
    const [body] = explain.mock.calls[0];
    expect(body.question).toBe("show Nasr City please");
    expect(body.templateId).toBeUndefined();
    expect(body.storeIds).toEqual([]);
  });

  test("a specific-scope store_manager sends explicit store ids, never the empty list", async () => {
    ctx = owner({
      active_role_code: "store_manager",
      memberships: [
        { tenant_id: TENANT_ID, store_access_kind: "specific", accessible_store_ids: [STORE_A] },
      ],
    });
    explain.mockResolvedValue(ok(answerBody()));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    await waitFor(() => expect(explain).toHaveBeenCalled());
    expect(explain.mock.calls[0][0].storeIds).toEqual([STORE_A]);
    // And only the stores of their grant are offered.
    fireEvent.click(screen.getByLabelText(t("aiManagerSales.stores.all")));
    expect(screen.getByLabelText("Maadi")).toBeTruthy();
    expect(screen.queryByLabelText("Nasr City")).toBeNull();
  });

  test("picked stores are sent as picked", async () => {
    explain.mockResolvedValue(ok(answerBody()));
    mount();
    fireEvent.click(await screen.findByLabelText(t("aiManagerSales.stores.all")));
    fireEvent.click(screen.getByLabelText("Nasr City"));
    await ask(t("aiManagerSales.chip.T05"));
    await waitFor(() => expect(explain).toHaveBeenCalled());
    expect(explain.mock.calls[0][0].storeIds).toEqual([STORE_B]);
  });

  test("Ask while busy is ignored: one request, focus stays on the button", async () => {
    let release: (v: unknown) => void = () => {};
    explain.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    const button = screen.getByRole("button", { name: t("aiManagerSales.ask") });
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    expect(explain).toHaveBeenCalledTimes(1);
    release(ok(answerBody()));
    await screen.findByRole("table");
  });
});

describe("U-2 loading and U-3/U-4 answer", () => {
  test("loading shows the line and no figure; the live region announces it", async () => {
    explain.mockReturnValue(new Promise(() => {}));
    mount();
    await ask(t("aiManagerSales.chip.T04"));
    const live = (await screen.findAllByText(t("aiManagerSales.loading")))[0].closest("output");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("1,250.50 EGP")).toBeNull();
  });

  test("the answer restates scope and period first, then a semantic table of the server's figures", async () => {
    explain.mockResolvedValue(ok(answerBody()));
    mount();
    await ask(t("aiManagerSales.chip.T04"));
    const table = await screen.findByRole("table");
    expect(screen.getByText(t("aiManagerSales.announce.answer"))).toBeTruthy();

    // Context line: scope, period, as of, received-only.
    const context = document.querySelector(".ams-context");
    expect(context?.textContent).toContain("Stores: 2 stores");
    expect(context?.textContent).toContain("Period:");
    expect(context?.textContent).toContain("As of");
    expect(context?.textContent).toContain("Received by the server only");

    // Table semantics.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Store", "Received sales", "Count", "Share of all your stores"]);
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByRole("rowheader").textContent).toContain("Maadi");
    // Money formatted for locale only; a ratio exactly as served; a count as a number.
    expect(within(rows[1]).getByText("1,250.50 EGP")).toBeTruthy();
    expect(within(rows[1]).getByText("0.6250")).toBeTruthy();
    expect(within(rows[1]).getByText("12")).toBeTruthy();
    expect(within(rows[2]).getByText("750.00 EGP")).toBeTruthy();
    // The statement slot is resolved from the table figure of the same ref, not recomputed.
    expect(document.querySelector(".ams-statement")?.textContent).toContain("1,250.50 EGP");
    // received_only is always shown.
    expect(screen.getByText(t("aiManagerSales.notice.receivedOnly"))).toBeTruthy();
  });

  test("no arithmetic: a total is never derived from the rows", async () => {
    explain.mockResolvedValue(ok(answerBody()));
    mount();
    await ask(t("aiManagerSales.chip.T04"));
    await screen.findByRole("table");
    expect(document.body.textContent).not.toContain("2,000.50");
    expect(document.body.textContent).not.toContain("2000.5");
  });

  test("a citation chip opens the sources and focuses its entry", async () => {
    explain.mockResolvedValue(ok(answerBody()));
    mount();
    await ask(t("aiManagerSales.chip.T04"));
    await screen.findByRole("table");
    const details = document.querySelector("details.ams-sources") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(
      screen.getAllByRole("button", { name: t("aiManagerSales.cite.open", { n: 2 }) })[0],
    );
    expect(details.open).toBe(true);
    expect(document.activeElement?.tagName).toBe("LI");
    expect(details.textContent).toContain("consoleGetSalesByStore");
  });

  test("partial data: day_in_progress and received_only notices, a decline, gaps, and no 'final' wording", async () => {
    explain.mockResolvedValue(
      ok(
        answerBody({
          notices: ["received_only", "day_in_progress", "multi_currency", "scope_relative_ratio"],
          declined: ["partial_data_not_conclusive", "causal_not_supported"],
          gaps: ["G-1", "G-5"],
        }),
      ),
    );
    mount();
    await ask(t("aiManagerSales.chip.T10"));
    await screen.findByRole("table");
    expect(
      screen.getByText(
        /Today is still in progress: figures include only what reached the server by/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(t("aiManagerSales.notice.multiCurrency"))).toBeTruthy();
    expect(screen.getByText(t("aiManagerSales.notice.scopeRelativeRatio"))).toBeTruthy();
    expect(screen.getByText(t("aiManagerSales.decline.causal"))).toBeTruthy();
    expect(
      screen.getByText(
        t("aiManagerSales.decline.conclusive", {
          reason: t("aiManagerSales.reason.dayInProgress"),
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByText(t("aiManagerSales.gap.g1"))).toBeTruthy();
    expect(screen.getByText(t("aiManagerSales.gap.g5"))).toBeTruthy();
  });

  test("untrusted text is text: markup in a store name is not rendered, bidi controls are stripped", async () => {
    const body = answerBody();
    const table = body.blocks[1];
    if (table.type !== "table") throw new Error("fixture");
    table.rows[0][0] = { ref: table.rows[0][0].ref, value: "‮<img src=x onerror=alert(1)>Maadi" };
    explain.mockResolvedValue(ok(body));
    mount();
    await ask(t("aiManagerSales.chip.T04"));
    const rendered = await screen.findByRole("table");
    expect(rendered.querySelector("img")).toBeNull();
    expect(rendered.textContent).toContain("<img src=x onerror=alert(1)>Maadi");
    expect(rendered.textContent).not.toContain("‮");
  });

  test("a statement slot with no matching figure points to the source and invents no number", async () => {
    const body = answerBody({
      blocks: [
        {
          type: "statement",
          key: "x",
          slots: { total: { ref: "ss:scope:range:receivedSales.total:EGP" } },
        },
      ],
    });
    explain.mockResolvedValue(ok(body));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.figure.seeSource"))).toBeTruthy();
  });
});

describe("U-6 refusals and U-7/U-8 unavailable", () => {
  test.each([
    ["finance_source_absent", "aiManagerSales.refusal.finance"],
    ["forecast_not_supported", "aiManagerSales.refusal.forecast"],
    ["write_action_not_supported", "aiManagerSales.refusal.write"],
    ["unsupported_question", "aiManagerSales.refusal.unsupported"],
  ] as const)("refusal %s is persistent text from the catalogue", async (code, key) => {
    explain.mockResolvedValue(ok(refusalBody(code)));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t(key))).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(t("aiManagerSales.announce.noAnswer"))).toBeTruthy();
  });

  test("kill switch (U-7) and entitlement denial (U-8) by role", async () => {
    explain.mockResolvedValue(ok(unavailableBody("feature_disabled_system")));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.unavailable.system"))).toBeTruthy();
    cleanup();

    ctx = owner({ active_role_code: "store_manager" });
    explain.mockResolvedValue(ok(unavailableBody("not_entitled")));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.unavailable.generic"))).toBeTruthy();
    // No plan or meter detail for a store_manager.
    expect(document.body.textContent).not.toMatch(/plan|trial|quota|limit/i);
    cleanup();

    ctx = owner();
    explain.mockResolvedValue(ok(unavailableBody("feature_disabled_tenant")));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.unavailable.optOutOwner"))).toBeTruthy();
    cleanup();

    explain.mockResolvedValue(ok(unavailableBody("quota_exhausted")));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.unavailable.quotaOwner"))).toBeTruthy();
  });

  test("evidence_unavailable is an error with retry and no figure (U-10)", async () => {
    explain.mockResolvedValueOnce(ok(unavailableBody("evidence_unavailable")));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.error.generic"))).toBeTruthy();
    explain.mockResolvedValueOnce(ok(answerBody()));
    fireEvent.click(screen.getByRole("button", { name: t("aiManagerSales.retry") }));
    await screen.findByRole("table");
    expect(explain).toHaveBeenCalledTimes(2);
    expect(explain.mock.calls[0][1]).not.toBe(explain.mock.calls[1][1]);
  });
});

describe("HTTP states", () => {
  test("400 scope_too_large (U-11)", async () => {
    explain.mockResolvedValue({ status: 400, error: apiError("scope_too_large") });
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.clarify.scopeTooLarge"))).toBeTruthy();
  });

  test("400 validation_error for the period when the server says so", async () => {
    explain.mockResolvedValue({ status: 400, error: apiError("validation_error") });
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.clarify.invalid"))).toBeTruthy();
  });

  test("404 is one non-disclosing message: it never says a store does not exist, never names a cause, shows no reference", async () => {
    explain.mockResolvedValue({ status: 404, error: apiError("not_found") });
    mount();
    fireEvent.click(await screen.findByLabelText(t("aiManagerSales.stores.all")));
    fireEvent.click(screen.getByLabelText("Nasr City"));
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.denied"))).toBeTruthy();
    expect(screen.getByText(t("aiManagerSales.deniedHint"))).toBeTruthy();
    const text = document.querySelector(".ams-result")?.textContent ?? "";
    expect(text).not.toMatch(/exist|not found|outside|access|permission|Nasr City|platform/i);
    expect(text).not.toContain(REQUEST_ID);
    expect(screen.queryByRole("table")).toBeNull();
    // The panel stays usable: the person can choose again.
    expect(screen.getByRole("button", { name: t("aiManagerSales.ask") })).toBeTruthy();
  });

  test("401 says the session ended", async () => {
    explain.mockResolvedValue({ status: 401 });
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.error.session"))).toBeTruthy();
  });

  test("429 says wait and offers retry; the retry is a new request", async () => {
    explain.mockResolvedValueOnce({ status: 429 });
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.error.rateLimited"))).toBeTruthy();
    expect(screen.getByText(t("aiManagerSales.error.rateLimitedHint"))).toBeTruthy();
    explain.mockResolvedValueOnce(ok(answerBody()));
    fireEvent.click(screen.getByRole("button", { name: t("aiManagerSales.retry") }));
    await screen.findByRole("table");
  });

  test("a 500 shows the generic error with the exact reference (U-10) and never the server's message", async () => {
    explain.mockResolvedValue({ status: 500, error: apiError("system_failure") });
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.error.generic"))).toBeTruthy();
    expect(screen.getByText(REQUEST_ID).closest("bdi")?.getAttribute("dir")).toBe("ltr");
    expect(screen.getByRole("button", { name: t("aiManagerSales.retry") })).toBeTruthy();
  });

  test("a request that throws (offline) is the same generic error, no crash", async () => {
    explain.mockRejectedValue(new Error("offline"));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    expect(await screen.findByText(t("aiManagerSales.error.generic"))).toBeTruthy();
  });
});

describe("Arabic and RTL", () => {
  test("the answer renders in Arabic from the catalogue, with money and ids left-to-right", async () => {
    setLocale("ar");
    explain.mockResolvedValue(ok(answerBody()));
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: translate("ar", "aiManagerSales.chip.T04") }),
    );
    fireEvent.click(screen.getByRole("button", { name: translate("ar", "aiManagerSales.ask") }));
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader")[1].textContent).toBe(
      translate("ar", "aiManagerSales.col.receivedSales"),
    );
    const money = within(table).getByText("1,250.50 EGP");
    expect(money.closest("bdi")?.getAttribute("dir")).toBe("ltr");
    expect(document.querySelector(".ams-context")?.textContent).toContain(
      "يشمل ما استلمه النظام فقط",
    );
  });
});

describe("a store name in the scope line", () => {
  test("a single-store answer names the store from the directory", async () => {
    explain.mockResolvedValue(ok(answerBody({ scope: { mode: "store", storeRefs: [STORE_A] } })));
    mount();
    await ask(t("aiManagerSales.chip.T01"));
    await screen.findByRole("table");
    expect(document.querySelector(".ams-context")?.textContent).toContain("Store: Maadi");
  });
});
