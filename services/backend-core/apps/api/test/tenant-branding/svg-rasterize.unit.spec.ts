/**
 * RT-473 S2 — the killable SVG rasterizer child (svg-rasterize.ts): a render
 * the child cannot finish, or one past the timeout, is `svg_unsupported`, and
 * renders run one at a time.
 */
import { LogoRejectedError } from "../../src/tenant-branding/logo-refusal";
import { rasterizeCheckedSvg } from "../../src/tenant-branding/svg-rasterize";
import { RECT, SVG_ROOT } from "./__support__/logo-images";

const GOOD = `<svg ${SVG_ROOT}>${RECT}</svg>`;

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (err) {
    return err instanceof LogoRejectedError ? err.code : `unexpected: ${String(err)}`;
  }
}

describe("rasterizeCheckedSvg", () => {
  it("renders a checked SVG to a PNG at the fixed height", async () => {
    const png = await rasterizeCheckedSvg(GOOD);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.readUInt32BE(20)).toBe(960);
  });

  it("is svg_unsupported when the child fails", async () => {
    expect(await code(rasterizeCheckedSvg("<svg"))).toBe("svg_unsupported");
  });

  it("serializes renders: concurrent calls all complete", async () => {
    const all = await Promise.all([rasterizeCheckedSvg(GOOD), rasterizeCheckedSvg("<svg"), rasterizeCheckedSvg(GOOD)].map(code));
    expect(all).toEqual(["ok", "svg_unsupported", "ok"]);
  });

  it("kills the child at the timeout and refuses with svg_unsupported", async () => {
    expect(await code(rasterizeCheckedSvg(GOOD, 1))).toBe("svg_unsupported");
  });
});
