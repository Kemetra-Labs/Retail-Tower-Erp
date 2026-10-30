import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-957 / DESIGN.md §9 button grammar, enforced over the TSX source.
 *
 * 1. A flow whose confirm step is `.btn-destructive` opens with `.btn-danger-quiet`.
 * 2. Cancel and back are `.btn-ghost`, never `.btn-primary` or `.btn-secondary`.
 */
const files = sourcesUnder("src").filter((f) => f.file.endsWith(".tsx"));

interface ButtonUse {
  file: string;
  cls: string;
  keys: string[];
}

/** Every element carrying a `btn-*` className, with the i18n keys of its label. */
function buttons(src: string): { cls: string; keys: string[] }[] {
  const out: { cls: string; keys: string[] }[] = [];
  for (const m of src.matchAll(/className=(?:"(btn-[a-z-]+)"|\{[^}]*?"(btn-[a-z-]+)"[^}]*?\})/g)) {
    const from = m.index ?? 0;
    const rest = src.slice(from, from + 700);
    const end = rest.search(/<\/(?:button|GatedButton|BusyButton|Link|a)>/);
    const body = end === -1 ? rest : rest.slice(0, end);
    out.push({
      cls: m[1] ?? m[2] ?? "",
      keys: [...body.matchAll(/\bt\(([^()]*)\)/g)].flatMap((call) =>
        [...(call[1] ?? "").matchAll(/"([^"]+)"/g)].map((k) => k[1] ?? ""),
      ),
    });
  }
  return out;
}

const uses: ButtonUse[] = files.flatMap((f) => buttons(f.src).map((b) => ({ file: f.file, ...b })));

const isCancelOrBack = (key: string): boolean =>
  key === "common.cancel" || key.endsWith(".back") || key === "devices.codes.cancelKeep";

describe("button grammar (RT-957, DESIGN.md §9)", () => {
  test("Cancel and back controls are btn-ghost, never primary or secondary", () => {
    const offenders = uses
      .filter((u) => u.keys.some(isCancelOrBack) && /^btn-(primary|secondary)$/.test(u.cls))
      .map((u) => `${u.file.split("/src/")[1]}: ${u.cls} ${u.keys.filter(isCancelOrBack)}`);
    expect(offenders).toEqual([]);
  });

  test("device revoke and retire open with btn-danger-quiet; replace and move stay secondary", () => {
    const src = readSource("src/devices/DeviceActions.tsx");
    expect(src).toMatch(/btn-danger-quiet/);
    expect(src).toMatch(/revoke/);
    expect(src).toMatch(/retire/);
    expect(src).toMatch(/"btn-secondary"/);
  });

  test("store suspend opens with btn-danger-quiet", () => {
    const opener = uses.find(
      (u) =>
        u.file.endsWith("stores/StoreStatusSection.tsx") &&
        u.keys.includes("stores.status.suspend"),
    );
    // The first suspend control is the opener; the destructive one is its confirm.
    const suspendUses = uses.filter(
      (u) =>
        u.file.endsWith("stores/StoreStatusSection.tsx") &&
        u.keys.includes("stores.status.suspend"),
    );
    expect(opener).toBeDefined();
    expect(suspendUses.map((u) => u.cls)).toEqual(["btn-danger-quiet", "btn-destructive"]);
  });

  test("a file that confirms with btn-destructive never opens the same action with a secondary button", () => {
    const offenders: string[] = [];
    for (const file of new Set(uses.map((u) => u.file))) {
      const inFile = uses.filter((u) => u.file === file);
      const confirmKeys = new Set(
        inFile.filter((u) => u.cls === "btn-destructive").flatMap((u) => u.keys),
      );
      for (const u of inFile) {
        const reopens = u.keys.some((k) => confirmKeys.has(k));
        if (reopens && /^btn-(primary|secondary)$/.test(u.cls))
          offenders.push(`${file}: ${u.keys}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
