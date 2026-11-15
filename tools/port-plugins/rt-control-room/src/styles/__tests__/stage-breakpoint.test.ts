import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NARROW_PX } from "../../components/room/useNarrow";

// jsdom does not apply the style sheets, so the stack breakpoint (RT-1416) is pinned on the CSS text.
const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const panel = readFileSync(join(dir, "panel.css"), "utf8");

/** The max-width of the media query whose block holds a rule for `selector`, or undefined. */
function stackWidth(selector: string): number | undefined {
  for (const m of panel.matchAll(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)) {
    if (new RegExp(`\\n\\s*${selector.replace(".", "\\.")} \\{`).test(`\n${m[2]}`)) return Number(m[1]);
  }
  return undefined;
}

describe("the alarm column stack point", () => {
  it("stacks .stage at 1400 px, so a 1600 to 1680 px window keeps the diagram", () => {
    expect(stackWidth(".stage")).toBe(1400);
  });

  it("leaves .lower at its own 1200 px point", () => {
    expect(stackWidth(".lower")).toBe(1200);
  });

  it("never lets the side by side layout squeeze the map under the diagram width", () => {
    // Map content (NARROW_PX) + room card padding (2 x 16) + alarm column (370) + gap (12)
    // + shell padding (2 x 16) + a scroll bar (about 15).
    const needed = NARROW_PX + 2 * 16 + 370 + 12 + 2 * 16 + 15;
    expect(needed).toBe(1361);
    expect(stackWidth(".stage")).toBeGreaterThanOrEqual(needed);
  });
});
