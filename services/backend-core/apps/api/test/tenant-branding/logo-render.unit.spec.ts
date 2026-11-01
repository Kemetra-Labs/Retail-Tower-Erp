/**
 * RT-1041 — the decode-and-render stage (logo-render.ts) run in-thread,
 * against the same upload through `processLogo`, which runs it in the logo
 * worker: every post-decode branch (each refusal, opaque trim, every warning,
 * the card, an SVG render) gives the same bytes or the same refusal on both
 * sides. And the worker reply protocol, in-thread.
 */
import { LogoRejectedError } from "../../src/tenant-branding/logo-refusal";
import { processLogo } from "../../src/tenant-branding/logo-pipeline";
import { fromReply, renderLogo, renderReply, type ProcessedLogo } from "../../src/tenant-branding/logo-render";
import { rasterizeCheckedSvg } from "../../src/tenant-branding/svg-rasterize";
import { scanSvg } from "../../src/tenant-branding/svg-scan";
import { canvas, fillRect, logoPng, NAVY, PALE_YELLOW, RECT, svg, toPng, WHITE } from "./__support__/logo-images";

type Outcome = { ok: true; logo: ProcessedLogo } | { ok: false; code: string; construct: string | null };

/** "ok" plus the warnings and "card", or the refusal code. */
const summary = (o: Outcome): string =>
  o.ok ? ["ok", ...o.logo.warnings, ...(o.logo.presentationCard ? ["card"] : [])].join(" ") : o.code;

async function outcome(work: Promise<ProcessedLogo>): Promise<Outcome> {
  try {
    return { ok: true, logo: await work };
  } catch (err) {
    if (err instanceof LogoRejectedError) return { ok: false, code: err.code, construct: err.construct };
    throw err;
  }
}

function frame(): Buffer {
  const c = fillRect(canvas(1064, 296), 20, 20, 1024, 256, NAVY);
  return toPng(fillRect(c, 60, 60, 944, 176, [0, 0, 0, 0]));
}

function hairlines(): Buffer {
  const c = canvas(1064, 296);
  for (let y = 20; y < 276; y += 6) fillRect(c, 20, y, 1024, 1, NAVY);
  return toPng(fillRect(c, 20, 275, 1024, 1, NAVY));
}

const CASES: ReadonlyArray<readonly [string, Buffer, string]> = [
  ["a thick frame on transparency (no warning)", frame(), "ok"],
  ["a solid horizontal 4:1 block", logoPng(1024, 256), "ok receipt_high_black_coverage"],
  ["a solid 512 square", logoPng(512, 512), "ok receipt_high_black_coverage"],
  ["opaque, trimmed by its margin colour", logoPng(1024, 256, { background: WHITE }), "ok receipt_high_black_coverage card"],
  ["pale", logoPng(1024, 256, { colour: PALE_YELLOW }), "ok low_contrast receipt_thin_strokes card"],
  ["hairlines", hairlines(), "ok receipt_thin_strokes"],
  ["taller than wide", logoPng(256, 512), "aspect_ratio_out_of_range"],
  ["wider than 4:1", logoPng(2100, 500), "aspect_ratio_out_of_range"],
  ["square below 512", logoPng(400, 400), "image_too_small"],
  ["horizontal below 256 tall", logoPng(600, 200), "image_too_small"],
  ["fully transparent", toPng(canvas(600, 600)), "image_empty"],
];

describe("renderLogo in-thread = processLogo in the worker", () => {
  it.each(CASES)("%s", async (_name, png, expected) => {
    const here = await outcome(renderLogo(png));
    const there = await outcome(processLogo(png));
    expect(summary(here)).toBe(expected);
    expect(there).toEqual(here);
  });

  it("an SVG's render", async () => {
    const bytes = svg(RECT);
    const here = await renderLogo(await rasterizeCheckedSvg(scanSvg(bytes)));
    expect(await processLogo(bytes)).toEqual(here);
  });

  it("is image_malformed when libvips cannot decode the bytes", async () => {
    expect(await outcome(renderLogo(Buffer.from("not a png")))).toEqual({ ok: false, code: "image_malformed", construct: null });
  });
});

describe("the worker reply protocol", () => {
  it("round-trips a rendered logo through structured clone, back to Buffers", async () => {
    const reply = await renderReply(new Uint8Array(logoPng(1024, 256)));
    const logo = fromReply(structuredClone(reply));
    expect(logo).toEqual(fromReply(reply));
    expect(logo.version).toMatch(/^[0-9a-f]{64}$/);
    expect([logo.master.png, logo.receipt.png, ...logo.screen.map((s) => s.png)].every((b) => Buffer.isBuffer(b))).toBe(true);
  });

  it("carries a refusal as its code and rebuilds the LogoRejectedError", async () => {
    const reply = await renderReply(new Uint8Array(toPng(canvas(600, 600))));
    expect(reply).toEqual({ ok: false, refusal: { code: "image_empty", construct: null } });
    expect(() => fromReply(reply)).toThrow(LogoRejectedError);
  });

  it("turns any other failure into a plain Error (→ 500)", () => {
    expect(() => fromReply({ ok: false, refusal: null, error: "boom" })).toThrow(new Error("logo worker: boom"));
  });
});
