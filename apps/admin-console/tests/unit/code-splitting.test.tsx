import { readdirSync } from "node:fs";
import { join } from "node:path";
import { lazyPage } from "@/shell/lazyPage";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { readSource } from "./source-scan";

/**
 * RT-962: the Console ships route by route. Screens load on demand behind the
 * existing loading state, and only the active locale's catalog is in the entry.
 */

/** Static value imports (`import { X } from "..."`), type-only imports excluded. */
function valueImports(src: string): string[] {
  return [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";?$/gms)].map(
    (m) => m[1] ?? "",
  );
}

const routeFiles = readdirSync(join(process.cwd(), "src/shell"))
  .filter((f) => f.endsWith("Routes.tsx"))
  .map((f) => `src/shell/${f}`);

afterEach(cleanup);

describe("route-level code splitting (RT-962)", () => {
  test("route families import their screens with import(), never statically", () => {
    expect(routeFiles.length).toBeGreaterThan(10);
    const offenders = routeFiles.flatMap((file) =>
      valueImports(readSource(file))
        .filter((spec) => spec !== "react-router" && spec !== "@/shell/lazyPage")
        .map((spec) => `${file}: ${spec}`),
    );
    expect(offenders).toEqual([]);
    for (const file of routeFiles) expect(readSource(file), file).toMatch(/import\("@\//);
  });

  test("App.tsx keeps only the shell, sign-in and error paths in the entry", () => {
    const eager = valueImports(readSource("src/App.tsx")).filter((s) => s.startsWith("@/"));
    const allowed =
      /^@\/(auth\/AcceptInvitation|context\/|i18n|lib\/query|observability\/|shell\/|styles\/)/;
    expect(eager.filter((s) => !allowed.test(s))).toEqual([]);
  });

  test("the message catalogs are not statically imported by the lookup", () => {
    const src = readSource("src/i18n/translate.ts");
    expect(valueImports(src).filter((s) => /messages\/(ar|en)$/.test(s))).toEqual([]);
    const loader = readSource("src/i18n/catalogs.ts");
    expect(loader).toContain('import("./messages/ar")');
    expect(loader).toContain('import("./messages/en")');
  });

  test("a screen not yet loaded shows the loading state, then the page", async () => {
    let resolve: (m: { Screen: () => React.JSX.Element }) => void = () => undefined;
    const Page = lazyPage(
      () =>
        new Promise<{ Screen: () => React.JSX.Element }>((r) => {
          resolve = r;
        }),
      "Screen",
    );
    render(<Page />);
    expect(screen.getByText("Loading items…")).toBeTruthy();
    await act(async () => resolve({ Screen: () => <h1>Loaded screen</h1> }));
    expect(await screen.findByRole("heading", { name: "Loaded screen" })).toBeTruthy();
    expect(screen.queryByText("Loading items…")).toBeNull();
  });
});
