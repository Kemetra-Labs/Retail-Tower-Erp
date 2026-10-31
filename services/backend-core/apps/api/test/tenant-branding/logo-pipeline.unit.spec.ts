/**
 * RT-473 S2 — the tenant logo pipeline without HTTP or a database (spec 039
 * FR-03 … FR-13, contract §5 / §6):
 *   - every closed `422` refusal code, including the malicious inputs of the
 *     acceptance criteria (SVG script / handlers / external href, PNG/ZIP
 *     polyglot, header bomb, non-PNG/SVG magic bytes);
 *   - normalization (metadata dropped, sRGB, trim, 8% clear space);
 *   - the 8 screen renditions and the 1-bit receipt rendition at 203 dpi;
 *   - warnings and presentation; determinism of every output and `version`.
 */
import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  RECEIPT_DPI,
  RECEIPT_MAX_H_PX,
  RECEIPT_MAX_W_PX,
  SLOT_BOXES,
} from "../../src/tenant-branding/logo-config";
import { processLogo, type ProcessedLogo } from "../../src/tenant-branding/logo-pipeline";
import { LogoRejectedError } from "../../src/tenant-branding/logo-refusal";
import { inspectPng } from "../../src/tenant-branding/png-codec";
import {
  BLACK,
  canvas,
  chunks,
  fillRect,
  headerBomb,
  idatStream,
  ihdr,
  logoPng,
  NAVY,
  PALE_YELLOW,
  pngChunk,
  pngHeader,
  RECT,
  svg,
  SVG_ROOT,
  toPng,
  WHITE,
  withChunkBeforeIend,
  ZIP_BYTES,
} from "./__support__/logo-images";

async function refusal(bytes: Buffer): Promise<{ code: string; construct: string | null }> {
  try {
    await processLogo(bytes);
  } catch (err) {
    if (err instanceof LogoRejectedError) return { code: err.code, construct: err.construct };
    throw err;
  }
  throw new Error("expected a refusal");
}

/** Five levels of ten `<use>` each over ten rects: 55 elements that expand to over 10^5 nodes. */
const FAN_OUT = (() => {
  let defs = `<g id="l0">${"<rect width='1' height='1'/>".repeat(10)}</g>`;
  for (let level = 1; level <= 4; level += 1) defs += `<g id="l${level}">${`<use href="#l${level - 1}"/>`.repeat(10)}</g>`;
  return `<defs>${defs}</defs><use href="#l4"/>`;
})();

/** The pr-review repro: about 55 elements that took resvg 155 s to render before the gate counted expansion. */
const OPACITY_BOMB = (() => {
  let defs = `<rect id="g0" width="400" height="100" opacity="0.5" fill="#102060"/>`;
  for (let level = 1; level <= 4; level += 1) defs += `<g id="g${level}">${`<use href="#g${level - 1}"/>`.repeat(10)}</g>`;
  return `<defs>${defs}</defs><use href="#g4"/>`;
})();

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** The horizontal reference logo: a 1024 × 256 navy block (exactly 4:1) in a transparent margin. */
const HORIZONTAL = logoPng(1024, 256);

describe("a valid horizontal PNG", () => {
  let out: ProcessedLogo;
  beforeAll(async () => {
    out = await processLogo(HORIZONTAL);
  });

  it("has a lowercase hex SHA-256 version", () => {
    expect(out.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("trims, adds 8% clear space per axis and caps the master at 1024", () => {
    // 1024 × 256 + round(8%) per side = 1188 × 296 → contain 1024 → 1024 × 255.
    expect(out.master).toMatchObject({ width: 1024, height: 255 });
    expect(chunks(out.master.png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("produces exactly one screen rendition per (slot, scale), contain-fitted in the OD-7 box", () => {
    expect(out.screen.map((s) => `${s.slot}@${s.scale}`)).toEqual([
      "boot@1", "boot@2", "pairing@1", "pairing@2", "sign_in@1", "sign_in@2", "lock@1", "lock@2",
    ]);
    for (const r of out.screen) {
      const box = SLOT_BOXES[r.slot];
      expect(r.width).toBeLessThanOrEqual(box.width * r.scale);
      expect(r.height).toBeLessThanOrEqual(box.height * r.scale);
      expect(r.width === box.width * r.scale || r.height === box.height * r.scale).toBe(true);
      expect(pngHeader(r.png)).toEqual({ width: r.width, height: r.height, bitDepth: 8, colourType: 6 });
      expect(chunks(r.png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    }
    expect(out.screen.find((s) => s.slot === "boot" && s.scale === 1)).toMatchObject({ width: 240, height: 60 });
    expect(out.screen.find((s) => s.slot === "sign_in" && s.scale === 2)).toMatchObject({ width: 256, height: 64 });
  });

  it("produces a 1-bit grayscale receipt rendition within 48 × 15 mm at 203 dpi (383 × 119 dots)", () => {
    expect([RECEIPT_MAX_W_PX, RECEIPT_MAX_H_PX]).toEqual([383, 119]);
    expect(out.receipt.dpi).toBe(RECEIPT_DPI);
    expect(out.receipt.width).toBeLessThanOrEqual(Math.floor((48 / 25.4) * out.receipt.dpi));
    expect(out.receipt.height).toBeLessThanOrEqual(Math.floor((15 / 25.4) * out.receipt.dpi));
    expect(out.receipt).toMatchObject({ width: 383, height: 95 });
    expect(pngHeader(out.receipt.png)).toEqual({ width: 383, height: 95, bitDepth: 1, colourType: 0 });
    expect(chunks(out.receipt.png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("is deterministic: the same bytes give the same version, master and renditions", async () => {
    const again = await processLogo(Buffer.from(HORIZONTAL));
    expect(again).toEqual(out);
  });

  it("pins the receipt dots (platform-independent: the inflated rows, not the deflate bytes)", () => {
    expect(sha(idatStream(out.receipt.png))).toBe("a4b4bc5175df16a7628514f8ed4a033f514238012f9622593519a83bd6c2d53f");
    const rows = idatStream(out.receipt.png);
    const rowBytes = Math.ceil(383 / 8) + 1;
    expect(rows.length).toBe(rowBytes * 95);
    // The top and bottom clear-space rows are white (every sample bit 1, padding 0).
    expect(rows.subarray(1, rowBytes - 1).every((b) => b === 0xff)).toBe(true);
  });

  it("is transparent-background with good contrast: no card, no screen warning", () => {
    expect(out.presentationCard).toBe(false);
    expect(out.warnings).not.toContain("low_contrast");
  });
});

describe("refusals (contract §5)", () => {
  it.each([
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])],
    ["GIF", Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")],
    ["ZIP", ZIP_BYTES],
    ["plain text", Buffer.from("hello, logo")],
    ["UTF-16 SVG", Buffer.from(`﻿<svg ${SVG_ROOT}/>`, "utf16le")],
    ["HTML", Buffer.from("<html><body>x</body></html>")],
  ])("file_type_not_allowed: %s", async (_name, bytes) => {
    expect(await refusal(bytes)).toEqual({ code: "file_type_not_allowed", construct: null });
  });

  describe("image_malformed (PNG)", () => {
    const flipped = Buffer.from(HORIZONTAL);
    const idatAt = flipped.indexOf("IDAT", 0, "latin1");
    flipped[idatAt + 10] = flipped[idatAt + 10]! ^ 0xff;

    it.each([
      ["a broken CRC", flipped],
      ["a truncated file", HORIZONTAL.subarray(0, HORIZONTAL.length - 5)],
      ["a PNG/ZIP polyglot (ZIP after IEND)", Buffer.concat([HORIZONTAL, ZIP_BYTES])],
      ["one stray byte after IEND", Buffer.concat([HORIZONTAL, Buffer.from([0])])],
      ["no IDAT", Buffer.concat([HORIZONTAL.subarray(0, 33), pngChunk("IEND", Buffer.alloc(0))])],
      ["IHDR not first", Buffer.concat([HORIZONTAL.subarray(0, 8), pngChunk("tEXt", Buffer.from("a\0b")), HORIZONTAL.subarray(8)])],
      ["a zero width", Buffer.concat([HORIZONTAL.subarray(0, 8), ihdr(0, 10), HORIZONTAL.subarray(33)])],
      ["an invalid bit depth", Buffer.concat([HORIZONTAL.subarray(0, 8), ihdr(10, 10, 3, 6), HORIZONTAL.subarray(33)])],
      ["pixel data that does not decode", headerBomb(600, 600)],
    ])("%s", async (_name, bytes) => {
      expect(await refusal(bytes)).toEqual({ code: "image_malformed", construct: null });
    });
  });

  describe("image_dimensions_too_large (from the header, before any decode)", () => {
    it.each([
      [4001, 10],
      [10, 4001],
      [100_000, 100_000],
      [0xffffffff, 0xffffffff],
    ])("%i × %i", async (w, h) => {
      // The IDAT cannot decode to this size: a decode attempt would be image_malformed.
      expect(await refusal(headerBomb(w, h))).toEqual({ code: "image_dimensions_too_large", construct: null });
    });

    it("passes the header check at exactly 4000 × 4000 (the decoder's own limit still applies)", () => {
      expect(inspectPng(headerBomb(4000, 4000))).toEqual({ width: 4000, height: 4000 });
    });
  });

  it.each([
    ["a square logo under 512 × 512", logoPng(500, 500)],
    ["a square-ish logo (aspect < 1.25) 600 × 500", logoPng(600, 500)],
    ["a horizontal logo under 256 px tall", logoPng(1000, 250)],
  ])("image_too_small: %s", async (_name, bytes) => {
    expect(await refusal(bytes)).toEqual({ code: "image_too_small", construct: null });
  });

  it.each([
    ["taller than wide", logoPng(300, 600)],
    ["600 × 601 (literal 1:1 lower bound)", logoPng(600, 601)],
    ["wider than 4:1", logoPng(2100, 500)],
  ])("aspect_ratio_out_of_range: %s", async (_name, bytes) => {
    expect(await refusal(bytes)).toEqual({ code: "aspect_ratio_out_of_range", construct: null });
  });

  it.each([
    ["fully transparent", toPng(canvas(600, 600))],
    ["a single opaque colour", toPng(canvas(600, 600, WHITE))],
    ["an SVG whose only content is text (no fonts are loaded)", svg(`<text x="10" y="100" font-size="60">ACME</text>`)],
  ])("image_empty: %s", async (_name, bytes) => {
    expect(await refusal(bytes)).toEqual({ code: "image_empty", construct: null });
  });
});

describe("accepted shapes", () => {
  it("accepts a 512 × 512 square and an exact 4:1", async () => {
    await expect(processLogo(logoPng(512, 512))).resolves.toMatchObject({ master: { width: 594, height: 594 } });
    await expect(processLogo(HORIZONTAL)).resolves.toBeDefined();
  });

  it("accepts a horizontal 1.25:1 logo at 256 px tall (not square-ish)", async () => {
    await expect(processLogo(logoPng(320, 256))).resolves.toBeDefined();
  });
});

describe("SVG", () => {
  it("rasterizes a safe SVG at a fixed size, so a small but well-framed viewBox meets the minimum (FR-09)", async () => {
    const tiny = `<rect x="5" y="5" width="30" height="10" fill="#102060"/>`;
    const out = await processLogo(svg(tiny, `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"`));
    expect(out.screen).toHaveLength(8);
    expect(out.master.width).toBe(1024);
  });

  it("image_too_small: content that fills only a corner of the SVG canvas", async () => {
    const corner = svg(`<rect x="0" y="0" width="20" height="10" fill="#102060"/>`, `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"`);
    expect(await refusal(corner)).toEqual({ code: "image_too_small", construct: null });
  });

  it("accepts a BOM and leading whitespace, and fragment references", async () => {
    const body = `<defs><linearGradient id="g"><stop offset="0" stop-color="#102060"/></linearGradient></defs>
      <rect x="50" y="50" width="300" height="100" fill="url(#g)" style="stroke:url( '#g' )"/><use href="#g"/>`;
    await expect(processLogo(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("\n  "), svg(body)]))).resolves.toBeDefined();
  });

  it("is deterministic", async () => {
    const bytes = svg(RECT);
    expect(await processLogo(bytes)).toEqual(await processLogo(Buffer.from(bytes)));
  });

  const XLINK = `xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 400 200"`;
  it.each([
    ["script", "script", `<script>alert(1)</script>${RECT}`, SVG_ROOT],
    ["script in another namespace prefix", "script", `<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>`, SVG_ROOT],
    ["SVG Tiny handler", "script", `<handler type="application/ecmascript">x</handler>`, SVG_ROOT],
    ["onload on the root", "event_handler", RECT, `${SVG_ROOT} onload="alert(1)"`],
    ["ONCLICK in upper case", "event_handler", `<rect ONCLICK="x" width="1" height="1"/>`, SVG_ROOT],
    ["an external href", "external_reference", `<use href="https://evil.example/a.svg#x"/>`, SVG_ROOT],
    ["an xlink:href with character references", "external_reference", `<use xlink:href="&#104;ttps://evil.example/a#x"/>`, XLINK],
    ["a javascript: href", "external_reference", `<a href="javascript:alert(1)">${RECT}</a>`, SVG_ROOT],
    ["a data: href", "external_reference", `<use href="data:image/svg+xml;base64,AAAA"/>`, SVG_ROOT],
    ["a CSS url() in an attribute", "external_reference", `<rect fill="url(https://evil.example/x)" width="1" height="1"/>`, SVG_ROOT],
    ["a CSS url() in style=", "external_reference", `<rect style="fill:url('//evil.example/x')" width="1" height="1"/>`, SVG_ROOT],
    ["an escaped url( in <style> CDATA", "external_reference", `<style><![CDATA[rect{fill:u\\72l(http://evil.example)}]]></style>`, SVG_ROOT],
    ["an entity-escaped url( in <style>", "external_reference", `<style>rect{fill:&#117;rl(http://evil.example)}</style>`, SVG_ROOT],
    ["@import in <style>", "css_import", `<style>@import "https://evil.example/x.css";</style>`, SVG_ROOT],
    ["an escaped @import", "css_import", `<style>@\\69mport "x.css";</style>`, SVG_ROOT],
    ["foreignObject", "foreign_object", `<foreignObject width="10" height="10"><div/></foreignObject>`, SVG_ROOT],
    ["iframe", "embedded_content", `<iframe src="https://evil.example"/>`, SVG_ROOT],
    ["embed", "embedded_content", `<embed src="x"/>`, SVG_ROOT],
    ["object", "embedded_content", `<object data="x"/>`, SVG_ROOT],
    ["image (even a fragment)", "image_element", `<image href="#x" width="1" height="1"/>`, SVG_ROOT],
  ])("svg_unsafe_content: %s → %s", async (_name, construct, body, root) => {
    expect(await refusal(svg(body, root))).toEqual({ code: "svg_unsafe_content", construct });
  });

  it.each([
    ["a DOCTYPE with an entity", `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg ${SVG_ROOT}>&x;</svg>`],
    ["a DOCTYPE without an entity", `<?xml version="1.0"?><!DOCTYPE svg><svg ${SVG_ROOT}/>`],
  ])("svg_unsafe_content: %s → entity", async (_name, text) => {
    expect(await refusal(Buffer.from(text))).toEqual({ code: "svg_unsafe_content", construct: "entity" });
  });

  it("a DOCTYPE before any prolog or <svg> root is not SVG by FR-03 (file_type_not_allowed)", async () => {
    expect(await refusal(Buffer.from(`<!DOCTYPE svg><svg ${SVG_ROOT}/>`))).toEqual({ code: "file_type_not_allowed", construct: null });
  });

  it("svg_unsafe_content: an xml-stylesheet instruction → css_import", async () => {
    const text = `<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/x.css"?><svg ${SVG_ROOT}>${RECT}</svg>`;
    expect(await refusal(Buffer.from(text))).toEqual({ code: "svg_unsafe_content", construct: "css_import" });
  });

  it.each([
    ["an unclosed element", `<svg ${SVG_ROOT}><rect></svg>`],
    ["an unknown entity", `<svg ${SVG_ROOT}>&nbsp;</svg>`],
    ["a bare ampersand", `<svg ${SVG_ROOT}><title>a & b</title></svg>`],
    ["a duplicate attribute", `<svg ${SVG_ROOT}><rect x="1" x="2"/></svg>`],
    ["an unquoted attribute", `<svg ${SVG_ROOT}><rect x=1/></svg>`],
    ["two roots", `<svg ${SVG_ROOT}/><svg ${SVG_ROOT}/>`],
    ["text after the root", `<svg ${SVG_ROOT}/>trailing`],
  ])("image_malformed: %s", async (_name, text) => {
    expect(await refusal(Buffer.from(text))).toEqual({ code: "image_malformed", construct: null });
  });

  it("image_malformed: invalid UTF-8", async () => {
    expect(await refusal(Buffer.concat([Buffer.from(`<svg ${SVG_ROOT}><title>`), Buffer.from([0xc3, 0x28]), Buffer.from("</title></svg>")]))).toEqual({
      code: "image_malformed",
      construct: null,
    });
  });

  it.each([
    ["no viewBox and no size", svg(RECT, `xmlns="http://www.w3.org/2000/svg"`)],
    ["percentage sizes only", svg(RECT, `xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"`)],
    ["a zero-area viewBox", svg(RECT, `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10"`)],
    ["a root that is not svg", Buffer.from(`<?xml version="1.0"?><html/>`)],
    ["more than 5000 elements", svg(`<g>${"<rect/>".repeat(5000)}</g>`)],
    ["nesting deeper than 64", svg(`${"<g>".repeat(64)}${"</g>".repeat(64)}`)],
    ["a <use> fan-out bomb (10^5 nodes from 55 elements)", svg(FAN_OUT)],
    ["the review's render bomb: 4 levels of 10 <use> over a translucent rect (10^4 nodes)", svg(OPACITY_BOMB)],
    ["a <use> reference cycle", svg(`<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>`)],
    ["a pattern used by a stylesheet rule on every element", svg(`<defs><pattern id="p">${"<rect/>".repeat(20)}</pattern></defs><style>rect{fill:url(#p)}</style>${RECT}`)],
    ["feTurbulence with 1000 octaves", svg(`<filter id="f"><feTurbulence numOctaves="1000"/></filter>${RECT}`)],
  ])("svg_unsupported: %s", async (_name, bytes) => {
    expect(await refusal(bytes)).toEqual({ code: "svg_unsupported", construct: null });
  });

  it("accepts modest <use> reuse and gradient inheritance", async () => {
    const body = `<defs><linearGradient id="a"><stop offset="0" stop-color="#102060"/></linearGradient>
      <linearGradient id="b" href="#a"/><g id="mark"><rect x="0" y="0" width="100" height="100" fill="url(#b)"/></g></defs>
      <use href="#mark" x="50" y="50"/><use href="#mark" x="150" y="50"/><use href="#mark" x="250" y="50"/>`;
    await expect(processLogo(svg(body))).resolves.toBeDefined();
  });

  it("accepts absolute width and height without a viewBox", async () => {
    await expect(processLogo(svg(RECT, `xmlns="http://www.w3.org/2000/svg" width="400px" height="200"`))).resolves.toBeDefined();
  });
});

describe("normalization (FR-08)", () => {
  it("drops every metadata chunk and keeps a hidden ZIP chunk out of the output", async () => {
    const tagged = withChunkBeforeIend(
      withChunkBeforeIend(HORIZONTAL, pngChunk("tEXt", Buffer.from("Author\0Someone private", "latin1"))),
      pngChunk("prVt", ZIP_BYTES),
    );
    const out = await processLogo(tagged);
    const all = [out.master.png, out.receipt.png, ...out.screen.map((s) => s.png)];
    for (const png of all) {
      expect(chunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
      expect(png.includes(ZIP_BYTES)).toBe(false);
    }
    // Metadata does not change the pixels, so it does not change the version.
    expect(out.version).toBe((await processLogo(HORIZONTAL)).version);
  });

  it("converts an embedded ICC profile to sRGB and drops the iCCP chunk", async () => {
    const raw = fillRect(canvas(1100, 300), 30, 22, 1024, 256, [200, 30, 30, 255]);
    const p3 = await sharp(Buffer.from(raw.data), { raw: { width: 1100, height: 300, channels: 4 } })
      .withIccProfile("p3")
      .png()
      .toBuffer();
    expect(chunks(p3).map((c) => c.type)).toContain("iCCP");
    const out = await processLogo(p3);
    expect(chunks(out.master.png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("pads an opaque image with its margin colour and shows it on a card", async () => {
    const out = await processLogo(logoPng(1024, 256, { background: WHITE }));
    expect(out.presentationCard).toBe(true);
    const corner = await sharp(out.master.png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect([...corner]).toEqual([255, 255, 255, 255]);
  });
});

describe("warnings and presentation (contract §6, FR-11)", () => {
  it("low_contrast for a pale logo, which forces the card", async () => {
    const out = await processLogo(logoPng(1024, 256, { colour: PALE_YELLOW }));
    expect(out.warnings).toContain("low_contrast");
    expect(out.presentationCard).toBe(true);
  });

  it("receipt_high_black_coverage for a large solid block", async () => {
    expect((await processLogo(logoPng(1024, 256, { colour: BLACK }))).warnings).toContain("receipt_high_black_coverage");
  });

  it("receipt_thin_strokes for hairlines", async () => {
    const c = canvas(1064, 296);
    for (let y = 20; y < 276; y += 6) fillRect(c, 20, y, 1024, 1, NAVY);
    fillRect(c, 20, 275, 1024, 1, NAVY);
    expect((await processLogo(toPng(c))).warnings).toContain("receipt_thin_strokes");
  });

  it("no warning for a thick dark frame on transparency", async () => {
    const c = fillRect(canvas(1064, 296), 20, 20, 1024, 256, NAVY);
    fillRect(c, 60, 60, 944, 176, [0, 0, 0, 0]);
    const out = await processLogo(toPng(c));
    expect(out.warnings).toEqual([]);
    expect(out.presentationCard).toBe(false);
  });
});
