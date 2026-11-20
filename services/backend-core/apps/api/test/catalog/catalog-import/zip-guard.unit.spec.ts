/**
 * RT-1505 (spec 049 §8.5; RT-1504 comments 17944 / 17947): the zip guard of an
 * XLSX upload, against every hostile fixture. Each case builds the archive by
 * hand (`__support__/zip-fixtures.ts`, which can lie in any header) and asserts
 * the code the guard refuses it with, BEFORE `read-excel-file` would see it.
 */
import { deflateRawSync } from "node:zlib";

import { ImportFileRejectedError, type ImportFileRejectionCode } from "../../../src/catalog/catalog-import/import-file-rejected";
import { inspectZip } from "../../../src/catalog/catalog-import/zip-guard";
import { buildXlsx, buildZip, xlsxEntries, type ZipEntrySpec } from "./__support__/zip-fixtures";

async function refusal(buf: Buffer): Promise<ImportFileRejectionCode | "accepted"> {
  try {
    await inspectZip(buf);
    return "accepted";
  } catch (err) {
    if (err instanceof ImportFileRejectedError) return err.code as ImportFileRejectionCode;
    throw err;
  }
}

const SHEET_ROWS = [["sku", "name"], ["A1", "Tea"]];
const entries = (): ZipEntrySpec[] => xlsxEntries(SHEET_ROWS);
const MIB = 1024 * 1024;

describe("zip guard: what it accepts", () => {
  it("accepts an honest workbook and reads its parts", async () => {
    const zip = await inspectZip(buildXlsx([{ name: "Products", rows: SHEET_ROWS }]));
    expect(zip.names).toContain("xl/workbook.xml");
    expect((await zip.read("xl/workbook.xml"))?.toString()).toContain('name="Products"');
    expect(await zip.read("nope.xml")).toBeNull();
  });

  it.each([
    ["stored", { method: 0 as const }],
    ["with a data descriptor", { descriptor: "plain" as const }],
    ["with a signed data descriptor", { descriptor: "signed" as const }],
  ])("accepts entries %s", async (_label, extra) => {
    const buf = buildZip(entries().map((e) => ({ ...e, ...extra })));
    expect(await refusal(buf)).toBe("accepted");
  });

  it("accepts exactly 200 entries", async () => {
    const many = [...entries(), ...Array.from({ length: 200 - entries().length }, (_v, i) => ({ name: `docProps/p${i}.bin`, data: "x" }))];
    expect(many).toHaveLength(200);
    expect(await refusal(buildZip(many))).toBe("accepted");
  });

  it("is not moved by an end record signature inside the zip comment", async () => {
    // A fake record whose own comment length does not reach the end of the file: it cannot be the real one.
    const tail = Buffer.alloc(18);
    tail.writeUInt16LE(1000, 16);
    const comment = Buffer.concat([Buffer.from("note "), Buffer.from([0x50, 0x4b, 0x05, 0x06]), tail]);
    expect(await refusal(buildZip(entries(), { comment }))).toBe("accepted");
  });

  it("does not inflate an entry the library never reads", async () => {
    // A .png with a stream that is not deflate: the library ignores it, so the guard does not inflate it either.
    const junk: ZipEntrySpec = { name: "xl/media/image1.png", data: "ignored", rawCompressed: Buffer.from("not a deflate stream"), central: { compressedSize: 20 }, local: { compressedSize: 20 } };
    expect(await refusal(buildZip([...entries(), junk]))).toBe("accepted");
  });
});

describe("zip guard: type and encryption", () => {
  it.each(["xl/vbaProject.bin", "xl/VBAPROJECT.BIN", "vbaProject.bin", "xl/vbaProjectSignature.bin"])("refuses %s", async (name) => {
    expect(await refusal(buildZip([...entries(), { name, data: "macro" }]))).toBe("file_type_unsupported");
  });

  it("refuses an encrypted entry", async () => {
    const encrypted = entries().map((e, i) => (i === 0 ? { ...e, central: { flags: 0x0001 } } : e));
    expect(await refusal(buildZip(encrypted))).toBe("file_type_unsupported");
  });

  it("refuses a compression method other than stored or deflate", async () => {
    const bzip2 = entries().map((e, i) => (i === 1 ? { ...e, central: { method: 12 } } : e));
    expect(await refusal(buildZip(bzip2))).toBe("file_type_unsupported");
  });

  it("refuses zip64 (the locator, and a saturated end record)", async () => {
    expect(await refusal(buildZip(entries(), { zip64Locator: true }))).toBe("file_type_unsupported");
    expect(await refusal(buildZip(entries(), { eocd: { totalEntries: 0xffff, thisDisk: 0xffff } }))).toBe("file_type_unsupported");
  });

  it("refuses a multi-disk archive", async () => {
    expect(await refusal(buildZip(entries(), { eocd: { disk: 1 } }))).toBe("file_type_unsupported");
    expect(await refusal(buildZip(entries(), { eocd: { centralDisk: 1 } }))).toBe("file_type_unsupported");
  });

  it("refuses an archive with no entries", async () => {
    expect(await refusal(buildZip([]))).toBe("file_type_unsupported");
  });
});

describe("zip guard: limits", () => {
  it("refuses more than 200 entries before reading the central directory", async () => {
    const many = [...entries(), ...Array.from({ length: 201 - entries().length }, (_v, i) => ({ name: `docProps/p${i}.bin`, data: "x" }))];
    expect(many).toHaveLength(201);
    expect(await refusal(buildZip(many))).toBe("xlsx_limits_exceeded");
  });

  it("refuses an end record that claims more than 200 entries even with a central directory that holds fewer", async () => {
    expect(await refusal(buildZip(entries(), { eocd: { totalEntries: 5000, thisDisk: 5000 } }))).toBe("xlsx_limits_exceeded");
  });

  it("refuses a zip bomb: a sheet that inflates past 50 MiB, honestly declared", async () => {
    const bomb = Buffer.alloc(120 * MIB, 0x20);
    const bombed = entries().map((e) => (e.name === "xl/worksheets/sheet1.xml" ? { ...e, data: bomb } : e));
    const zip = buildZip(bombed);
    expect(zip.length).toBeLessThan(1 * MIB);
    expect(await refusal(zip)).toBe("xlsx_limits_exceeded");
  });

  it("refuses a declared size past 50 MiB without inflating anything (1.2 GiB declared)", async () => {
    const lying = entries().map((e, i) => (i === 0 ? { ...e, central: { uncompressedSize: 1200 * MIB } } : e));
    expect(await refusal(buildZip(lying))).toBe("xlsx_limits_exceeded");
  });

  it("accepts a declared total just under 50 MiB", async () => {
    const big = [...entries(), { name: "xl/media/big.bin", data: "x", central: { uncompressedSize: 49 * MIB }, local: { uncompressedSize: 49 * MIB } }];
    expect(await refusal(buildZip(big))).toBe("accepted");
  });
});

describe("zip guard: lying headers", () => {
  it("refuses a stream that inflates past what both headers declare (no cap in the library: 62 s, then a crash)", async () => {
    const real = Buffer.alloc(30 * MIB, 0x20);
    const lying = entries().map((e) =>
      e.name === "xl/worksheets/sheet1.xml"
        ? { ...e, data: Buffer.alloc(40), rawCompressed: deflateRawSync(real), central: { uncompressedSize: 40, compressedSize: deflateRawSync(real).length }, local: { uncompressedSize: 40, compressedSize: deflateRawSync(real).length } }
        : e,
    );
    expect(await refusal(buildZip(lying))).toBe("file_unreadable");
  });

  it("refuses a central directory that disagrees with the local header", async () => {
    const lying = entries().map((e, i) => (i === 2 ? { ...e, central: { uncompressedSize: e.data.length - 1 } } : e));
    expect(await refusal(buildZip(lying))).toBe("file_unreadable");
  });

  it("refuses a local header that names another entry", async () => {
    const lying = entries().map((e, i) => (i === 2 ? { ...e, local: { name: "xl/other.xml" } } : e));
    expect(await refusal(buildZip(lying))).toBe("file_unreadable");
  });

  it("refuses a local header with another method than the central record", async () => {
    const lying = entries().map((e, i) => (i === 2 ? { ...e, local: { method: 0 } } : e));
    expect(await refusal(buildZip(lying))).toBe("file_unreadable");
  });

  it("refuses an entry hidden between the local entries and the central directory", async () => {
    const hidden = buildZip([{ name: "xl/hidden.xml", data: "<x/>" }]);
    const gap = hidden.subarray(0, hidden.length - 22 - 46 - "xl/hidden.xml".length);
    expect(await refusal(buildZip(entries(), { gap }))).toBe("file_unreadable");
  });

  it("refuses a duplicate entry name", async () => {
    const [first] = entries();
    expect(await refusal(buildZip([...entries(), first as ZipEntrySpec]))).toBe("file_unreadable");
  });

  it("refuses a compressed stream that ends before its declared size (bytes after it)", async () => {
    const comp = deflateRawSync(Buffer.from("<workbook/>"));
    const padded = Buffer.concat([comp, Buffer.from("PK\u0003\u0004hidden")]);
    const lying = entries().map((e) =>
      e.name === "xl/workbook.xml" ? { ...e, data: "<workbook/>", rawCompressed: padded, central: { compressedSize: padded.length }, local: { compressedSize: padded.length } } : e,
    );
    expect(await refusal(buildZip(lying))).toBe("file_unreadable");
  });

  it("refuses a CRC that does not match the inflated bytes", async () => {
    const lying = entries().map((e) => (e.name === "xl/workbook.xml" ? { ...e, central: { crc: 1 }, local: { crc: 1 } } : e));
    expect(await refusal(buildZip(lying))).toBe("file_unreadable");
  });

  it("refuses a data descriptor that disagrees with the central record", async () => {
    const good = buildZip(entries().map((e) => ({ ...e, descriptor: "plain" as const })));
    const lying = Buffer.from(good);
    // Flip the CRC of the first descriptor (right after the first entry's data).
    const first = entries()[0] as ZipEntrySpec;
    const compressed = deflateRawSync(Buffer.from(first.data));
    const at = 30 + (first.name.length) + compressed.length;
    lying[at] = (lying[at] ?? 0) ^ 0xff;
    expect(await refusal(lying)).toBe("file_unreadable");
  });

  it("refuses a stored entry whose two sizes differ", async () => {
    const lying = entries().map((e, i) => (i === 2 ? { ...e, method: 0 as const, central: { compressedSize: e.data.length + 1 } } : e));
    expect(await refusal(buildZip(lying))).toBe("file_unreadable");
  });

  it("refuses bytes that are not an archive", async () => {
    expect(await refusal(Buffer.from("PK\u0003\u0004 and then nothing useful"))).toBe("file_unreadable");
  });

  it("refuses a truncated archive", async () => {
    const zip = buildXlsx([{ name: "Products", rows: SHEET_ROWS }]);
    expect(await refusal(zip.subarray(0, zip.length - 40))).toBe("file_unreadable");
  });
});
