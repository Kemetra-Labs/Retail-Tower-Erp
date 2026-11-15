import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// jsdom does not apply the style sheets, so the v13 design changes (RT-1408 B2 to B5) are pinned on the CSS text.
const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = (name: string): string => readFileSync(join(dir, name), "utf8");
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return sheet.slice(at, sheet.indexOf("}", at));
}

describe("v13 design changes", () => {
  const room = css("room.css");
  const top = css("top.css");

  it("B2: a linked lamp is muted dashed grey, never the accent colour", () => {
    const box = rule(room, ".lamp.linked rect");
    expect(box).toContain("stroke-dasharray");
    expect(box).toContain("var(--color-rule-2)");
    expect(box).not.toContain("--color-cool");
    expect(rule(room, ".lamp.linked text")).toContain("var(--color-muted)");
  });

  it("B3: a trace spike is a neutral marker, not amber", () => {
    expect(rule(top, ".trace .spike")).not.toContain("stale");
    expect(rule(top, ".pulse .spike-label")).not.toContain("stale");
  });

  it("B4: historical CI failures use the muted past tone, red stays for live alarms", () => {
    expect(rule(top, ".trace .line.badline")).toContain("--color-past");
    expect(rule(top, ".trace .badpt")).toContain("--color-past");
    expect(readFileSync(join(dir, "..", "components", "CiStrip.tsx"), "utf8")).toContain('f: "var(--color-past)"');
    // The station cards' "CI fails" count is history too: a past tone, never the alarm red `.sv.bad`.
    expect(rule(room, ".sv.past")).toContain("--color-past");
    const station = readFileSync(join(dir, "..", "components", "room", "Station.tsx"), "utf8");
    expect(station).toMatch(/past && v > 0 \? "past"/);
    expect(station).not.toMatch(/bad && v > 0/);
    // The live-alarm cable keeps red.
    expect(rule(room, ".cable.fault")).toContain("--color-bad");
    // Both themes define the token.
    expect(css("tokens.css").match(/--color-past:/g)).toHaveLength(2);
  });

  it("B5: the fault pulse runs 4 x 1.5 s (6 s), not forever, and Pause and reduced motion still stop it", () => {
    const fault = rule(room, ".cable.fault");
    expect(fault).toMatch(/animation:\s*faultpulse 1\.5s ease-in-out 4;/);
    expect(fault).not.toContain("infinite");
    expect(room).toContain('.room[data-still="true"] .cable.fault');
    expect(room).toMatch(/prefers-reduced-motion: reduce\) \{[\s\S]*\.cable\.fault[\s\S]*animation: none !important/);
  });
});
