import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  CAIRO_STORE,
  NEW_YORK_STORE,
  PRODUCT_1,
  ctx,
  detail,
  identifier,
  one,
  writeFailure,
} from "./catalog-fixtures";

const consoleGetCatalogProduct = vi.fn();
const consoleAddProductIdentifier = vi.fn();
const consoleRetireProductIdentifier = vi.fn();
vi.mock("@/lib/catalog-queries", () => ({
  consoleGetCatalogProduct: (...a: unknown[]) => consoleGetCatalogProduct(...a),
  consoleAddProductIdentifier: (...a: unknown[]) => consoleAddProductIdentifier(...a),
  consoleRetireProductIdentifier: (...a: unknown[]) => consoleRetireProductIdentifier(...a),
  consoleRetireCatalogProduct: vi.fn(),
  consoleUpdateCatalogProduct: vi.fn(),
  consoleListCatalogProducts: vi.fn(),
  consoleListCatalogCategories: vi.fn(),
}));
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rf2-queries")>()),
  listStores: (...a: unknown[]) => listStores(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { CatalogProductDetail } from "@/catalog/CatalogProductDetail";
import { createQueryClient } from "@/lib/query";

/**
 * RT-769 identifiers add / retire on the item detail (CAT-C2b, RT-752 AC 3, D6).
 * Tests first for: the byte-for-byte value, each prevent rule, the Arabic-digit
 * warning, each error code, and role gating.
 */
const ADDED = identifier({ value: "6223000000017", createdAt: "2026-10-26T08:00:00Z" });

function renderDetail() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/catalog/products/${PRODUCT_1}`]}>
        <Routes>
          <Route path="/catalog/products/:productId" element={<CatalogProductDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function loaded(): Promise<void> {
  await screen.findByRole("heading", { level: 1, name: "Mineral water 1.5L" });
}

const addStart = () => screen.getByRole("button", { name: "Add identifier" });
const drawer = (name: string) => screen.getByRole("dialog", { name });
const valueInput = () => screen.getByLabelText(/^Value/) as HTMLInputElement;
const typeSelect = () => screen.getByLabelText("Type") as HTMLSelectElement;

async function openAdd(): Promise<HTMLElement> {
  renderDetail();
  await loaded();
  fireEvent.click(addStart());
  return drawer("Add identifier");
}

function submit(): void {
  fireEvent.click(within(drawer("Add identifier")).getByRole("button", { name: "Add identifier" }));
}

function type(value: string): void {
  fireEvent.change(valueInput(), { target: { value } });
}

function describedText(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" | ");
}

describe("identifiers add / retire (RT-769, CAT-C2b)", () => {
  beforeEach(() => {
    consoleGetCatalogProduct.mockReset();
    consoleAddProductIdentifier.mockReset();
    consoleRetireProductIdentifier.mockReset();
    listStores.mockReset();
    activeContext.mockReset();
    activeContext.mockReturnValue(ctx());
    consoleGetCatalogProduct.mockResolvedValue(one(detail()));
    consoleAddProductIdentifier.mockResolvedValue({
      status: 201,
      data: detail({ identifiers: [identifier(), ADDED] }),
    });
    consoleRetireProductIdentifier.mockResolvedValue(one(detail({ identifiers: [] })));
    listStores.mockResolvedValue({
      status: 200,
      data: [
        { id: CAIRO_STORE, code: "CAI", name: "Cairo Festival" },
        { id: NEW_YORK_STORE, code: "NYC", name: "New York" },
      ],
    });
  });

  // --- Role gating ---------------------------------------------------------------------------

  test.each(["owner", "tenant_admin"])("%s sees Add and a Retire per identifier", async (role) => {
    activeContext.mockReturnValue(ctx(role));
    renderDetail();
    await loaded();
    expect(addStart()).toBeDefined();
    expect(screen.getByRole("button", { name: "Retire Barcode 0012345678905" })).toBeDefined();
  });

  test("store_manager sees the identifiers read-only: no Add, no Retire", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderDetail();
    await loaded();
    expect(screen.getByText("0012345678905")).toBeDefined();
    expect(screen.queryByRole("button", { name: /identifier/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Retire/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
  });

  test.each(["cashier", "accountant", "platform_admin"])(
    "%s (outside the write roles) gets no identifier control",
    async (role) => {
      activeContext.mockReturnValue(ctx(role));
      renderDetail();
      // The read itself may be refused for these roles; either way nothing writes.
      await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
      expect(screen.queryByRole("button", { name: "Add identifier" })).toBeNull();
    },
  );

  test("a retired item's identifiers are read-only for everyone", async () => {
    consoleGetCatalogProduct.mockResolvedValue(one(detail({}, { status: "retired" })));
    renderDetail();
    await loaded();
    expect(screen.queryByRole("button", { name: "Add identifier" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Retire/ })).toBeNull();
  });

  test("opening the page or the drawer writes nothing", async () => {
    await openAdd();
    expect(consoleAddProductIdentifier).not.toHaveBeenCalled();
    expect(consoleRetireProductIdentifier).not.toHaveBeenCalled();
  });

  // --- The add form ---------------------------------------------------------------------------

  test("the value is a machine field: LTR, isolated, no spellcheck, no autocorrect", async () => {
    await openAdd();
    const input = valueInput();
    expect(input.getAttribute("dir")).toBe("ltr");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.className).toContain("catalog-identifier__value");
  });

  test("the type select offers the five contract types; barcode first", async () => {
    await openAdd();
    const options = within(typeSelect())
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["barcode", "sku", "plu", "supplier_code", "external_pos_id"]);
    expect(typeSelect().value).toBe("barcode");
  });

  test("scope: tenant-wide or a store in the caller's scope; store-scoped sends the store", async () => {
    await openAdd();
    const scope = screen.getByLabelText("Applies to") as HTMLSelectElement;
    await waitFor(() => expect(within(scope).getAllByRole("option")).toHaveLength(3));
    expect(within(scope).getAllByRole("option")[0].textContent).toBe("All stores");
    fireEvent.change(scope, { target: { value: CAIRO_STORE } });
    type("SKU-77");
    fireEvent.change(typeSelect(), { target: { value: "sku" } });
    submit();
    await waitFor(() => expect(consoleAddProductIdentifier).toHaveBeenCalledTimes(1));
    expect(consoleAddProductIdentifier).toHaveBeenCalledWith(PRODUCT_1, {
      identifierType: "sku",
      value: "SKU-77",
      storeId: CAIRO_STORE,
      sourceSystem: null,
    });
  });

  test("a membership limited to specific stores offers only those", async () => {
    activeContext.mockReturnValue({
      context: {
        ...ctx().context,
        memberships: [
          {
            tenant_id: "t1",
            store_access_kind: "specific",
            accessible_store_ids: [NEW_YORK_STORE],
          },
        ],
      },
    });
    await openAdd();
    const scope = screen.getByLabelText("Applies to") as HTMLSelectElement;
    await waitFor(() => expect(within(scope).getAllByRole("option")).toHaveLength(2));
    expect(within(scope).queryByRole("option", { name: "Cairo Festival" })).toBeNull();
  });

  test("an external POS id hides the scope and requires a source system", async () => {
    await openAdd();
    fireEvent.change(typeSelect(), { target: { value: "external_pos_id" } });
    expect(screen.queryByLabelText("Applies to")).toBeNull();
    const source = screen.getByLabelText(/^Source system/) as HTMLInputElement;
    expect(source.getAttribute("aria-required")).toBe("true");
    expect(source.getAttribute("dir")).toBe("ltr");
    type("ext-1");
    submit();
    await waitFor(() => expect(document.activeElement).toBe(source));
    expect(source.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(source)).toContain("Enter the source system.");
    expect(consoleAddProductIdentifier).not.toHaveBeenCalled();

    fireEvent.change(source, { target: { value: "Legacy POS" } });
    submit();
    await waitFor(() => expect(consoleAddProductIdentifier).toHaveBeenCalledTimes(1));
    expect(consoleAddProductIdentifier).toHaveBeenCalledWith(PRODUCT_1, {
      identifierType: "external_pos_id",
      value: "ext-1",
      storeId: null,
      sourceSystem: "Legacy POS",
    });
  });

  test("the source system is not asked for on any other type", async () => {
    await openAdd();
    expect(screen.queryByLabelText(/^Source system/)).toBeNull();
  });

  // --- Byte for byte ---------------------------------------------------------------------------

  test.each([
    ["leading zeros", "0012345678906"],
    ["inner spaces and case", "Ab  cD"],
    ["Arabic-Indic digits", "٦٢٢٣٠٠٠"],
  ])("the value is sent byte for byte (%s)", async (_name, value) => {
    await openAdd();
    type(value);
    submit();
    await waitFor(() => expect(consoleAddProductIdentifier).toHaveBeenCalledTimes(1));
    const body = consoleAddProductIdentifier.mock.calls[0][1] as { value: string };
    expect(body.value).toBe(value);
    expect(body).toEqual({ identifierType: "barcode", value, storeId: null, sourceSystem: null });
  });

  test("an accepted add closes the drawer, shows the server's list, and says so", async () => {
    await openAdd();
    type("6223000000017");
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("6223000000017")).toBeDefined();
    expect(screen.getByText("Identifier added.")).toBeDefined();
    expect(document.activeElement).toBe(addStart());
    // The detail came back with the write: no second read.
    expect(consoleGetCatalogProduct).toHaveBeenCalledTimes(1);
  });

  // --- Prevent rules ----------------------------------------------------------------------------

  test("no premature errors: nothing is in error before the first submit", async () => {
    const panel = await openAdd();
    type(" 12");
    expect(panel.querySelector("[aria-invalid='true']")).toBeNull();
  });

  test.each([
    ["empty", "", "Enter the value."],
    ["a control character", "12\t34", "The value contains an invisible control character"],
    ["a leading space", " 123", "The value starts or ends with a space"],
    ["a trailing space", "123 ", "The value starts or ends with a space"],
    ["too long", "9".repeat(201), "The value must be at most 200 characters."],
  ])("%s is blocked, named inline, focused, and left as typed", async (_name, value, message) => {
    await openAdd();
    type(value);
    submit();
    const input = valueInput();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(input)).toContain(message);
    expect(input.value).toBe(value);
    expect(consoleAddProductIdentifier).not.toHaveBeenCalled();
    // No summary in a drawer (D7).
    expect(document.querySelector(".form-error-summary")).toBeNull();
  });

  test("an error clears live once the value is fixed", async () => {
    await openAdd();
    type(" 123");
    submit();
    await waitFor(() => expect(valueInput().getAttribute("aria-invalid")).toBe("true"));
    type("123");
    expect(valueInput().getAttribute("aria-invalid")).toBeNull();
  });

  // --- D6 ---------------------------------------------------------------------------------------

  test("Arabic-Indic digits in a barcode warn without blocking; the value is not converted", async () => {
    await openAdd();
    type("٦٢٢٣");
    const input = valueInput();
    expect(describedText(input)).toContain("Scanners send 0-9");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    submit();
    await waitFor(() => expect(consoleAddProductIdentifier).toHaveBeenCalledTimes(1));
    expect(consoleAddProductIdentifier.mock.calls[0][1]).toMatchObject({ value: "٦٢٢٣" });
  });

  test("the warning also covers a PLU, and not a SKU", async () => {
    await openAdd();
    type("٤٢");
    fireEvent.change(typeSelect(), { target: { value: "plu" } });
    expect(describedText(valueInput())).toContain("Scanners send 0-9");
    fireEvent.change(typeSelect(), { target: { value: "sku" } });
    expect(describedText(valueInput())).not.toContain("Scanners send 0-9");
  });

  test("the warning region is a polite status that is always present", async () => {
    await openAdd();
    const region = document.getElementById("identifier-value-warning");
    expect(region?.tagName).toBe("OUTPUT");
    expect(region?.textContent).toBe("");
  });

  // --- Each error code ----------------------------------------------------------------------------

  test("409 alias_conflict is an error on the value, focused, naming no other item", async () => {
    consoleAddProductIdentifier.mockResolvedValue(writeFailure(409, "alias_conflict", "r-alias"));
    await openAdd();
    type("0012345678905");
    submit();
    const input = valueInput();
    await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(input);
    expect(describedText(input)).toContain("Already used by another item.");
    const panel = drawer("Add identifier");
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(panel.textContent).not.toContain("r-alias");
    expect(input.value).toBe("0012345678905");

    // The same key again is not sent: it would only be refused again.
    submit();
    expect(consoleAddProductIdentifier).toHaveBeenCalledTimes(1);

    // A changed value clears the error.
    type("0012345678906");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  test("409 product_retired is a surface error; the form locks; closing re-reads the item", async () => {
    consoleAddProductIdentifier.mockResolvedValue(writeFailure(409, "product_retired", "r-ret"));
    await openAdd();
    type("123");
    submit();
    const panel = drawer("Add identifier");
    await within(panel).findByText("This item is retired, so no identifier can be added to it.");
    expect(within(panel).getByText("r-ret")).toBeDefined();
    expect(valueInput().getAttribute("aria-invalid")).toBeNull();
    expect(
      (within(panel).getByRole("button", { name: "Add identifier" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    consoleGetCatalogProduct.mockResolvedValue(one(detail({}, { status: "retired" })));
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(consoleGetCatalogProduct).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Add identifier" })).toBeNull(),
    );
  });

  test.each([
    [400, "validation_failed", "The server refused this identifier."],
    [401, "unauthenticated", "Your session has expired."],
    [403, "origin_rejected", "The request was refused"],
    [403, "forbidden", "You do not have permission to change this item."],
    [404, "not_found", "This item, or the chosen store, is no longer available to you."],
    [429, "rate_limited", "Too many requests."],
    [500, "internal_error", "Something went wrong and nothing was saved."],
  ])("add %i %s is a banner in the drawer with its request id", async (status, code, message) => {
    consoleAddProductIdentifier.mockResolvedValue(writeFailure(status, code, `r-${status}`));
    await openAdd();
    type("123");
    submit();
    const panel = drawer("Add identifier");
    await within(panel).findByText(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(within(panel).getByText(`r-${status}`)).toBeDefined();
    expect(valueInput().getAttribute("aria-invalid")).toBeNull();
    expect(valueInput().value).toBe("123");
  });

  test("a request that never completes is a visible failure, not silence", async () => {
    consoleAddProductIdentifier.mockRejectedValue(new TypeError("offline"));
    await openAdd();
    type("123");
    submit();
    await within(drawer("Add identifier")).findByText(
      "Something went wrong and nothing was saved. Try again.",
    );
  });

  // --- Retire -----------------------------------------------------------------------------------

  test("Retire names the identifier and the consequence, then sends its full key as read", async () => {
    const scoped = identifier({ identifierType: "sku", value: "Sku 07 ", storeId: CAIRO_STORE });
    consoleGetCatalogProduct.mockResolvedValue(one(detail({ identifiers: [scoped] })));
    renderDetail();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Retire SKU Sku 07" }));
    const panel = drawer("Retire identifier");
    expect(within(panel).getByText("Sku 07 ", { normalizer: (s) => s })).toBeDefined();
    expect(within(panel).getByText(/Its value is freed/)).toBeDefined();
    expect(consoleRetireProductIdentifier).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole("button", { name: "Yes, retire identifier" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(consoleRetireProductIdentifier).toHaveBeenCalledWith(PRODUCT_1, {
      identifierType: "sku",
      value: "Sku 07 ",
      storeId: CAIRO_STORE,
      sourceSystem: null,
    });
    expect(screen.getByText("Identifier retired. Its value is free to use again.")).toBeDefined();
    expect(screen.getByText("This item has no active identifiers.")).toBeDefined();
    // Its row is gone: focus lands on Add, not on the body.
    expect(document.activeElement).toBe(addStart());
  });

  test("Cancel on Retire writes nothing", async () => {
    renderDetail();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Retire Barcode 0012345678905" }));
    fireEvent.click(within(drawer("Retire identifier")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(consoleRetireProductIdentifier).not.toHaveBeenCalled();
    expect(consoleGetCatalogProduct).toHaveBeenCalledTimes(1);
  });

  test("a retire 404 says the identifier is no longer active, locks, and re-reads on close", async () => {
    consoleRetireProductIdentifier.mockResolvedValue(writeFailure(404, "not_found", "r-404"));
    renderDetail();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Retire Barcode 0012345678905" }));
    const panel = drawer("Retire identifier");
    fireEvent.click(within(panel).getByRole("button", { name: "Yes, retire identifier" }));
    await within(panel).findByText(/no longer active on this item/);
    expect(within(panel).getByText("r-404")).toBeDefined();
    expect(
      (within(panel).getByRole("button", { name: "Yes, retire identifier" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    consoleGetCatalogProduct.mockResolvedValue(one(detail({ identifiers: [] })));
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(consoleGetCatalogProduct).toHaveBeenCalledTimes(2));
    await screen.findByText("This item has no active identifiers.");
  });

  test("a failed retire is a banner with the request id; the identifier stays", async () => {
    consoleRetireProductIdentifier.mockResolvedValue(writeFailure(500, "internal_error", "r-500"));
    renderDetail();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Retire Barcode 0012345678905" }));
    const panel = drawer("Retire identifier");
    fireEvent.click(within(panel).getByRole("button", { name: "Yes, retire identifier" }));
    await within(panel).findByText("Something went wrong and nothing was saved. Try again.");
    expect(within(panel).getByText("r-500")).toBeDefined();
  });
});
