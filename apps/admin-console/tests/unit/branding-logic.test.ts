import {
  LOGO_MAX_BYTES,
  LOGO_REFUSAL_CODES,
  LOGO_WARNINGS,
  classifyBrandingWrite,
  precheckLogoFile,
  receiptSizeMm,
  renditionFor,
  scaleForPixelRatio,
  warningKey,
} from "@/branding/brandingLogic";
import { translate } from "@/i18n";
import { setLocale } from "@/i18n/locale";
import { beforeEach, describe, expect, test } from "vitest";
import { REQUEST_ID, brandingWithLogo, preview, refusal, screenSet } from "./branding-fixtures";

/**
 * RT-474: every closed Backend-Core refusal code and warning of the v0.3.3
 * tenant-branding contract maps to owner-approved Arabic copy through a message
 * key (UX-12.33), and the server's `message` is never what the user reads.
 */
const ar = (key: Parameters<typeof translate>[1]) => translate("ar", key);

function refusedKey(status: number, code: string, extra?: Record<string, unknown>) {
  const outcome = classifyBrandingWrite(refusal(status, code, extra));
  if (outcome.kind !== "refused") throw new Error(`expected refused, got ${outcome.kind}`);
  return outcome.messageKey;
}

beforeEach(() => setLocale("ar"));

describe("refusal copy (brief §5.1), one test per code", () => {
  const COPY: Record<string, [number, string]> = {
    file_type_not_allowed: [422, "نوع الملف غير مدعوم. ارفع صورة PNG أو SVG."],
    image_malformed: [
      422,
      "تعذّرت قراءة الصورة، وقد يكون الملف تالفًا. احفظ الشعار من جديد في برنامج التصميم ثم ارفعه.",
    ],
    image_dimensions_too_large: [422, "أبعاد الصورة كبيرة جدًا. الحد الأقصى 4000 بكسل لكل ضلع."],
    image_too_small: [
      422,
      "الصورة صغيرة. المطلوب 512×512 بكسل على الأقل للشعار المربع، أو ارتفاع 256 بكسل للشعار العرضي.",
    ],
    aspect_ratio_out_of_range: [
      422,
      "شكل الشعار غير مناسب. يجب أن تكون نسبة العرض إلى الارتفاع بين 1:1 و4:1.",
    ],
    image_empty: [422, "الصورة لا تحتوي على شعار ظاهر."],
    svg_unsupported: [422, "تعذّرت معالجة ملف SVG هذا. صدّر الشعار بصيغة PNG وارفعه."],
    file_too_large: [413, "حجم الملف أكبر من 1 ميجابايت."],
    logo_preview_mismatch: [
      409,
      "الملف لا يطابق المعاينة المعروضة. اختر الملف مرة أخرى لعرض معاينة جديدة، ثم احفظ.",
    ],
  };

  for (const [code, [status, text]] of Object.entries(COPY)) {
    test(`${code} (${String(status)})`, () => {
      expect(ar(refusedKey(status, code))).toBe(text);
    });
  }

  test("svg_unsafe_content: one message for all eight constructs, never naming one", () => {
    const constructs = [
      "script",
      "event_handler",
      "external_reference",
      "foreign_object",
      "embedded_content",
      "entity",
      "image_element",
      "css_import",
    ];
    const texts = new Set(
      constructs.map((construct) =>
        ar(refusedKey(422, "svg_unsafe_content", { details: { construct } })),
      ),
    );
    expect([...texts]).toEqual([
      "يحتوي ملف SVG على عناصر غير مسموح بها لأسباب أمنية. صدّر الشعار بصيغة PNG وارفعه.",
    ]);
    for (const c of constructs) expect([...texts][0]).not.toContain(c);
  });

  test("the closed 422 set is exactly the contract's, each with its own key", () => {
    expect([...LOGO_REFUSAL_CODES].sort()).toEqual(
      [
        "aspect_ratio_out_of_range",
        "file_type_not_allowed",
        "image_dimensions_too_large",
        "image_empty",
        "image_malformed",
        "image_too_small",
        "svg_unsafe_content",
        "svg_unsupported",
      ].sort(),
    );
    const keys = new Set(LOGO_REFUSAL_CODES.map((c) => refusedKey(422, c)));
    expect(keys.size).toBe(LOGO_REFUSAL_CODES.length);
  });

  test("an unknown 422 code gets a fallback, never the server's message", () => {
    const key = refusedKey(422, "something_new");
    expect(ar(key)).not.toContain("server text");
    expect(ar(key).length).toBeGreaterThan(0);
  });

  test("every refusal key also exists in English", () => {
    for (const code of [...LOGO_REFUSAL_CODES, "file_too_large", "logo_preview_mismatch"]) {
      const status = code === "file_too_large" ? 413 : code === "logo_preview_mismatch" ? 409 : 422;
      expect(translate("en", refusedKey(status, code))).toMatch(/\w/);
    }
  });
});

describe("other outcomes", () => {
  test("409 logo_changed_concurrently is a conflict, not a field refusal", () => {
    expect(classifyBrandingWrite(refusal(409, "logo_changed_concurrently"))).toEqual({
      kind: "conflict",
    });
  });

  test("429 is rate limited; 404 is no access; 401 is a lost session", () => {
    expect(classifyBrandingWrite(refusal(429, "rate_limited")).kind).toBe("rateLimited");
    expect(classifyBrandingWrite(refusal(404, "not_found")).kind).toBe("noAccess");
    expect(classifyBrandingWrite(refusal(401, "unauthorized")).kind).toBe("session");
  });

  test("400, 403 and 500 are a generic failure carrying the request id", () => {
    for (const [status, code] of [
      [400, "validation_error"],
      [403, "origin_rejected"],
      [500, "internal_error"],
    ] as const) {
      expect(classifyBrandingWrite(refusal(status, code))).toEqual({
        kind: "failed",
        status,
        requestId: REQUEST_ID,
      });
    }
  });

  test("a 2xx carries the body", () => {
    const body = brandingWithLogo();
    expect(classifyBrandingWrite({ status: 200, data: body })).toEqual({ kind: "ok", data: body });
  });
});

describe("warnings (brief §5.2)", () => {
  test("each warning has its own approved Arabic message", () => {
    expect(LOGO_WARNINGS).toEqual([
      "low_contrast",
      "receipt_high_black_coverage",
      "receipt_thin_strokes",
    ]);
    expect(ar(warningKey("low_contrast"))).toBe(
      "الشعار فاتح على الخلفية البيضاء، لذلك سيظهر داخل بطاقة بيضاء بإطار على أجهزة الكاشير. يمكنك حفظه كما هو.",
    );
    expect(ar(warningKey("receipt_high_black_coverage"))).toBe(
      "مساحة السواد كبيرة في نسخة الإيصال، فقد يظهر الشعار كتلة داكنة وتصبح الطباعة أبطأ. شعار بخلفية فاتحة يعطي نتيجة أوضح.",
    );
    expect(ar(warningKey("receipt_thin_strokes"))).toBe(
      "بعض خطوط الشعار رفيعة جدًا وقد تختفي في الطباعة الحرارية. شعار بخطوط أعرض يعطي نتيجة أوضح.",
    );
  });
});

describe("client pre-check (fast feedback only)", () => {
  test("only a file over 1 MiB is refused before the server sees it", () => {
    expect(LOGO_MAX_BYTES).toBe(1_048_576);
    expect(precheckLogoFile({ size: LOGO_MAX_BYTES })).toBeUndefined();
    expect(ar(precheckLogoFile({ size: LOGO_MAX_BYTES + 1 }) ?? "branding.title")).toBe(
      "حجم الملف أكبر من 1 ميجابايت.",
    );
  });
});

describe("rendition geometry", () => {
  test("the receipt prints at width_px / dpi × 25.4 mm, from the server's dpi", () => {
    const size = receiptSizeMm({ width_px: 383, height_px: 119, dpi: 203, png_base64: "x" });
    expect(size.widthMm).toBeCloseTo(47.92, 2);
    expect(size.heightMm).toBeCloseTo(14.89, 2);
    const at300 = receiptSizeMm({ width_px: 300, height_px: 100, dpi: 300, png_base64: "x" });
    expect(at300.widthMm).toBeCloseTo(25.4, 5);
  });

  test("a slot's rendition is picked by slot and scale; the scale follows the pixel ratio", () => {
    const set = screenSet();
    expect(renditionFor(set, "boot", 2)?.width_px).toBe(480);
    expect(renditionFor(set, "sign_in", 1)?.width_px).toBe(128);
    expect(scaleForPixelRatio(1)).toBe(1);
    expect(scaleForPixelRatio(1.25)).toBe(2);
    expect(scaleForPixelRatio(3)).toBe(2);
    expect(renditionFor(preview().screen, "lock", 1)?.height_px).toBe(50);
  });
});
