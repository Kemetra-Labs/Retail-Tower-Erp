import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consoleListPeopleNames = vi.fn();
vi.mock("@/lib/people-queries", () => ({
  consoleListPeopleNames: (...a: unknown[]) => consoleListPeopleNames(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { PeopleNames, PersonRef } from "@/people/PersonRef";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = uuid(1);
const B = uuid(2);

function renderRef(ids: string[], refs: string[] = ids) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <PeopleNames ids={ids}>
        {refs.map((id) => (
          <p key={id} data-testid={id}>
            <PersonRef userId={id} />
          </p>
        ))}
      </PeopleNames>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  consoleListPeopleNames.mockReset();
  activeContext.mockReturnValue({ context: { active_tenant: { id: "t1", name: "T" } } });
  setLocale("en");
});

describe.each(["en", "ar"] as const)("PersonRef (%s)", (locale) => {
  beforeEach(() => setLocale(locale));

  test("shows the name beside the id, never instead of it", async () => {
    consoleListPeopleNames.mockResolvedValue({
      status: 200,
      data: { items: [{ user_id: A, display_name: "Omar Khaled" }] },
    });
    renderRef([A]);
    await waitFor(() => expect(screen.getByText("Omar Khaled")).toBeDefined());
    const id = screen.getByText(A);
    expect(id.tagName).toBe("BDI");
    expect(id.getAttribute("dir")).toBe("ltr");
  });
});

describe("people directory fallbacks (no banner)", () => {
  test.each([
    ["a null name", { status: 200, data: { items: [{ user_id: A, display_name: null }] } }],
    ["an absent id", { status: 200, data: { items: [] } }],
    ["a 404", { status: 404, data: undefined }],
    ["a 429", { status: 429, data: undefined }],
    ["a 500", { status: 500, data: undefined }],
  ])("%s falls back to the id", async (_n, answer) => {
    consoleListPeopleNames.mockResolvedValue(answer);
    renderRef([A]);
    await waitFor(() => expect(consoleListPeopleNames).toHaveBeenCalled());
    expect(screen.getByText(A)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a thrown lookup falls back to the id", async () => {
    consoleListPeopleNames.mockRejectedValue(new Error("network"));
    renderRef([A]);
    await waitFor(() => expect(consoleListPeopleNames).toHaveBeenCalled());
    expect(screen.getByText(A)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a failed lookup is not cached as fresh: the next mount asks again", async () => {
    const client = createQueryClient();
    const mount = () =>
      render(
        <QueryClientProvider client={client}>
          <PeopleNames ids={[A]}>
            <PersonRef userId={A} />
          </PeopleNames>
        </QueryClientProvider>,
      );
    consoleListPeopleNames.mockResolvedValueOnce({ status: 500, data: undefined });
    const first = mount();
    await waitFor(() => expect(consoleListPeopleNames).toHaveBeenCalledTimes(1));
    first.unmount();
    consoleListPeopleNames.mockResolvedValue({
      status: 200,
      data: { items: [{ user_id: A, display_name: "Omar Khaled" }] },
    });
    mount();
    await waitFor(() => expect(screen.getByText("Omar Khaled")).toBeDefined());
    expect(consoleListPeopleNames).toHaveBeenCalledTimes(2);
  });

  test("no provider: the id alone, no request", () => {
    render(<PersonRef userId={A} />);
    expect(screen.getByText(A)).toBeDefined();
    expect(consoleListPeopleNames).not.toHaveBeenCalled();
  });
});

describe("people directory batching", () => {
  test("one call for the distinct ids on a screen", async () => {
    consoleListPeopleNames.mockResolvedValue({
      status: 200,
      data: {
        items: [
          { user_id: A, display_name: "Omar" },
          { user_id: B, display_name: "Sara" },
        ],
      },
    });
    renderRef([A, B, A.toUpperCase(), B], [A, B]);
    await waitFor(() => expect(screen.getByText("Sara")).toBeDefined());
    expect(consoleListPeopleNames).toHaveBeenCalledTimes(1);
    expect(consoleListPeopleNames).toHaveBeenCalledWith([A, B]);
  });

  test("more than 200 ids split into calls of at most 200", async () => {
    consoleListPeopleNames.mockResolvedValue({ status: 200, data: { items: [] } });
    const ids = Array.from({ length: 450 }, (_, i) => uuid(i + 1));
    renderRef(ids, [ids[0] as string]);
    await waitFor(() => expect(consoleListPeopleNames).toHaveBeenCalledTimes(3));
    const sizes = consoleListPeopleNames.mock.calls
      .map((c) => (c[0] as string[]).length)
      .sort((a, b) => a - b);
    expect(sizes).toEqual([50, 200, 200]);
  });

  test("no tenant: no request", () => {
    activeContext.mockReturnValue({ context: null });
    renderRef([A]);
    expect(consoleListPeopleNames).not.toHaveBeenCalled();
    expect(screen.getByText(A)).toBeDefined();
  });
});
