import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  REQUEST_ID,
  TENANT_ID,
  VERSION_B,
  brandingEmpty,
  brandingWithLogo,
  pngFile,
  preview,
  refusal,
} from "./branding-fixtures";

/**
 * RT-474: the tenant logo page against the v0.3.3 contract. The wrappers are
 * mocked; the canvas is stubbed (jsdom has neither createImageBitmap nor a 2D
 * context), and the drawn size is asserted to be the server rendition's own.
 */
const ctx = vi.hoisted(() => ({ role: "owner" as string, tenant: "" }));
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: { active_tenant: { id: ctx.tenant }, active_role_code: ctx.role },
  }),
}));
vi.mock("@/shell/useSignOut", () => ({ useSignOut: () => () => {} }));

const api = vi.hoisted(() => ({
  get: vi.fn(),
  preview: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@/lib/tenant-branding-queries", () => ({
  consoleGetTenantLogo: (...a: unknown[]) => api.get(...a),
  consolePreviewTenantLogo: (...a: unknown[]) => api.preview(...a),
  consolePutTenantLogo: (...a: unknown[]) => api.put(...a),
  consoleDeleteTenantLogo: (...a: unknown[]) => api.del(...a),
}));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useParams: () => ({ tenantId: TENANT_ID }) };
});

import { TenantBrandingPage } from "@/branding/TenantBrandingPage";
import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { reportRateLimited, resetRateLimit } from "@/lib/rate-limit";

const drawn: { canvas: HTMLCanvasElement; width: number; height: number }[] = [];

beforeEach(() => {
  setLocale("ar");
  ctx.role = "owner";
  ctx.tenant = TENANT_ID;
  for (const fn of Object.values(api)) fn.mockReset();
  drawn.length = 0;
  resetRateLimit();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      drawImage: () => drawn.push({ canvas: this, width: this.width, height: this.height }),
    } as unknown as CanvasRenderingContext2D;
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <TenantBrandingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  return input;
}

function choose(file: File) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

const saveButton = () => screen.getByRole("button", { name: /حفظ الشعار/ });

describe("access (owner and tenant_admin of this tenant only)", () => {
  test("a store_manager gets the no-access screen and nothing is requested", async () => {
    ctx.role = "store_manager";
    renderPage();
    expect(await screen.findByRole("heading", { level: 1 })).toBeDefined();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  test("an owner of another tenant gets the no-access screen and nothing is requested", async () => {
    ctx.tenant = "0190f000-0000-7000-8000-0000000000ff";
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  test("a tenant_admin sees the page", async () => {
    ctx.role = "tenant_admin";
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    renderPage();
    expect(await screen.findByRole("heading", { name: "هوية المؤسسة" })).toBeDefined();
  });

  test("the server's non-disclosing 404 shows the no-access screen", async () => {
    api.get.mockResolvedValue(refusal(404, "not_found"));
    renderPage();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "هوية المؤسسة" })).toBeNull());
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe("current logo (states A and B)", () => {
  test("no logo: the empty state, one primary «رفع شعار» and the requirements line", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    renderPage();
    expect(
      await screen.findByText("لا يوجد شعار للمؤسسة. تعرض أجهزة الكاشير اسم المؤسسة نصًا في مكانه."),
    ).toBeDefined();
    const upload = screen.getByRole("button", { name: "رفع شعار" });
    expect(upload.className).toContain("btn-primary");
    expect(screen.getByText(/PNG أو SVG، حتى 1 ميجابايت/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "إزالة الشعار" })).toBeNull();
  });

  test("a logo: the server's rendition, last updated with its zone, replace and remove", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingWithLogo() });
    renderPage();
    expect(await screen.findByText("آخر تحديث")).toBeDefined();
    expect(screen.getByText(/UTC/)).toBeDefined();
    expect(screen.getByRole("button", { name: "استبدال الشعار" }).className).toContain(
      "btn-secondary",
    );
    expect(screen.getByRole("button", { name: "إزالة الشعار" }).className).toContain(
      "btn-danger-quiet",
    );
    expect(screen.getByRole("img", { name: "الشعار الحالي للمؤسسة" })).toBeDefined();
  });
});

describe("preview (states C to F)", () => {
  test("choosing a file previews it; four slots and the receipt are the server's renditions", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    api.preview.mockResolvedValue({ status: 200, data: preview() });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    const file = pngFile();
    choose(file);

    expect(await screen.findByRole("img", { name: "شاشة التشغيل" })).toBeDefined();
    expect(api.preview).toHaveBeenCalledWith(TENANT_ID, file, expect.any(AbortSignal));
    for (const label of ["شاشة التشغيل", "شاشة ربط الجهاز", "شريط تسجيل الدخول", "شاشة القفل"]) {
      expect(screen.getByRole("img", { name: label })).toBeDefined();
    }
    expect(screen.getAllByText(/بدعم من/)).toHaveLength(4);
    expect(screen.getByText("كما سيُطبع على الإيصال")).toBeDefined();
    expect(screen.getByRole("img", { name: "نسخة الإيصال من الشعار" })).toBeDefined();
    expect(screen.getByText("مقاس تقريبي على الشاشة")).toBeDefined();
    expect(screen.queryByText(/افتراضية/)).toBeNull();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test("a rendition that is not valid base64 stays blank, unannounced, and the page keeps working", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    const broken = preview();
    broken.screen = broken.screen.map((r) =>
      r.slot === "boot" ? { ...r, png_base64: "%%% not base64 %%%" } : r,
    );
    api.preview.mockResolvedValue({ status: 200, data: broken });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    choose(pngFile());
    expect(await screen.findByRole("img", { name: "شاشة ربط الجهاز" })).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("img", { name: "شاشة التشغيل" })).toBeNull());
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test("each canvas is drawn at its rendition's own pixel size", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    api.preview.mockResolvedValue({ status: 200, data: preview() });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    choose(pngFile());
    await screen.findByRole("img", { name: "شاشة التشغيل" });
    await waitFor(() => expect(drawn.length).toBeGreaterThanOrEqual(5));
    const boot = screen.getByRole("img", { name: "شاشة التشغيل" }) as HTMLCanvasElement;
    expect([boot.width, boot.height]).toEqual([240, 60]);
    expect(boot.style.width).toBe("240px");
    const receipt = screen.getByRole("img", {
      name: "نسخة الإيصال من الشعار",
    }) as HTMLCanvasElement;
    expect([receipt.width, receipt.height]).toEqual([297, 74]);
    expect(receipt.style.width).toBe(`${((297 / 203) * 25.4).toFixed(2)}mm`);
  });

  test("while the preview runs, save is unavailable", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    api.preview.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    choose(pngFile());
    await waitFor(() => expect(api.preview).toHaveBeenCalled());
    expect(
      saveButton().getAttribute("aria-disabled") === "true" ||
        (saveButton() as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("low_contrast: every slot on the white card, a warning beside it, save still available", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    api.preview.mockResolvedValue({
      status: 200,
      data: preview({ warnings: ["low_contrast"], presentation: { card: true } }),
    });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    choose(pngFile());
    expect(await screen.findByText(/الشعار فاتح على الخلفية البيضاء/)).toBeDefined();
    const slots = document.querySelectorAll(".logo-slot__box");
    expect(slots).toHaveLength(4);
    for (const box of slots) expect(box.classList.contains("logo-slot__box--card")).toBe(true);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test("the card follows presentation.card, not the warnings", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    api.preview.mockResolvedValue({ status: 200, data: preview({ presentation: { card: true } }) });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    choose(pngFile());
    await screen.findByRole("img", { name: "شاشة التشغيل" });
    expect(document.querySelectorAll(".logo-slot__box--card")).toHaveLength(4);
    expect(screen.queryByText(/الشعار فاتح/)).toBeNull();
  });

  test("both receipt warnings show beside the receipt preview and never block saving", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    api.preview.mockResolvedValue({
      status: 200,
      data: preview({ warnings: ["receipt_high_black_coverage", "receipt_thin_strokes"] }),
    });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    choose(pngFile());
    const receipt = (await screen.findByText("كما سيُطبع على الإيصال")).closest("section");
    if (!receipt) throw new Error("no receipt section");
    expect(within(receipt).getByText(/مساحة السواد كبيرة/)).toBeDefined();
    expect(within(receipt).getByText(/بعض خطوط الشعار رفيعة/)).toBeDefined();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  test("the latest file wins: an earlier preview is aborted and its late answer ignored", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    let resolveFirst: (v: unknown) => void = () => {};
    api.preview
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r;
          }),
      )
      .mockResolvedValueOnce({
        status: 200,
        data: preview({ warnings: ["receipt_thin_strokes"] }),
      });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    choose(pngFile("first.png"));
    choose(pngFile("second.png"));
    expect(await screen.findByText(/بعض خطوط الشعار رفيعة/)).toBeDefined();
    const firstSignal = api.preview.mock.calls[0][2] as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    await act(async () => {
      resolveFirst({
        status: 200,
        data: preview({ warnings: ["low_contrast"], presentation: { card: true } }),
      });
    });
    expect(screen.queryByText(/الشعار فاتح/)).toBeNull();
    expect(screen.getByText("second.png")).toBeDefined();
  });
});

describe("refusals (state G)", () => {
  test("a 422 shows inline on the upload field with «لم يتغيّر الشعار الحالي.»; no preview, save unavailable", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingWithLogo() });
    api.preview.mockResolvedValue(refusal(422, "image_too_small"));
    renderPage();
    await screen.findByRole("button", { name: "استبدال الشعار" });
    choose(pngFile());
    expect(
      await screen.findByText(/الصورة صغيرة/, { selector: ".logo-upload__error-line" }),
    ).toBeDefined();
    expect(screen.getByText("لم يتغيّر الشعار الحالي.")).toBeDefined();
    const live = document.querySelector('p.sr-only[aria-live="polite"]');
    expect(live?.textContent).toContain("الصورة صغيرة");
    expect(live?.textContent).toContain("لم يتغيّر الشعار الحالي.");
    const control = screen.getByRole("button", { name: "اختيار ملف آخر" });
    expect(document.activeElement).toBe(control);
    const described = (control.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain("الصورة صغيرة");
    expect(screen.queryByText("كما سيظهر على أجهزة الكاشير")).toBeNull();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("img", { name: "الشعار الحالي للمؤسسة" })).toBeDefined();
    expect(screen.queryByText("server text never shown")).toBeNull();
  });

  test("a file over 1 MiB is refused before any request", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    choose(pngFile("big.png", 1_048_577));
    expect(await screen.findByText("حجم الملف أكبر من 1 ميجابايت.")).toBeDefined();
    expect(api.preview).not.toHaveBeenCalled();
  });
});

async function previewReady(branding = brandingWithLogo()) {
  api.get.mockResolvedValue({ status: 200, data: branding });
  api.preview.mockResolvedValue({ status: 200, data: preview() });
  renderPage();
  await screen.findByRole("button", { name: branding.logo ? "استبدال الشعار" : "رفع شعار" });
  const file = pngFile();
  choose(file);
  await screen.findByRole("img", { name: "شاشة التشغيل" });
  return file;
}

describe("save, conflict and remove (states H to J)", () => {
  test("save sends the previewed file, its version and the loaded revision, then shows the new logo", async () => {
    const file = await previewReady();
    const stored = brandingWithLogo(4);
    if (!stored.logo) throw new Error("fixture has a logo");
    const saved = { ...stored, logo: { ...stored.logo, version: VERSION_B } };
    api.put.mockResolvedValue({ status: 200, data: saved });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText("تم حفظ الشعار. ستعرضه أجهزة الكاشير بعد تحديث بياناتها."),
    ).toBeDefined();
    expect(api.put).toHaveBeenCalledWith(TENANT_ID, file, {
      previewVersion: VERSION_B,
      expectedRevision: 3,
    });
    expect(screen.queryByText("كما سيظهر على أجهزة الكاشير")).toBeNull();

    // The next write chains the revision the server returned.
    api.del.mockResolvedValue({ status: 200, data: brandingEmpty(5) });
    fireEvent.click(screen.getByRole("button", { name: "إزالة الشعار" }));
    const confirm = await screen.findByText(/إزالة شعار المؤسسة؟/);
    const region = confirm.closest("section") as HTMLElement;
    fireEvent.click(within(region).getByRole("button", { name: "إزالة الشعار" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith(TENANT_ID, { expectedRevision: 4 }));
  });

  test("409 logo_changed_concurrently: the conflict banner, and the revision is not refreshed silently", async () => {
    await previewReady();
    api.put.mockResolvedValue(refusal(409, "logo_changed_concurrently"));
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(
        "تغيّر شعار المؤسسة بعد فتحك لهذه الصفحة. حدّث الصفحة لترى الشعار الحالي، ثم أعد المحاولة.",
      ),
    ).toBeDefined();
    expect(api.get).toHaveBeenCalledTimes(1);
    // A save that is sure to 409 again stays unavailable until the page is refreshed.
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);

    api.get.mockResolvedValue({ status: 200, data: brandingWithLogo(5) });
    fireEvent.click(screen.getByRole("button", { name: "تحديث الصفحة" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(false));
    api.put.mockResolvedValue({ status: 200, data: brandingWithLogo(6) });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(api.put.mock.calls[1][2]).toEqual({ previewVersion: VERSION_B, expectedRevision: 5 });
  });

  test("a cancel while the save is in flight wins: a late refusal does not reopen the editor", async () => {
    await previewReady();
    let answer: (v: unknown) => void = () => {};
    api.put.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answer = r;
        }),
    );
    fireEvent.click(saveButton());
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    await act(async () => {
      answer(refusal(409, "logo_preview_mismatch"));
    });
    expect(screen.queryByText(/الملف لا يطابق المعاينة المعروضة/)).toBeNull();
    expect(screen.getByRole("button", { name: "استبدال الشعار" })).toBeDefined();
  });

  test("409 logo_preview_mismatch on save is a field refusal", async () => {
    await previewReady();
    api.put.mockResolvedValue(refusal(409, "logo_preview_mismatch"));
    fireEvent.click(saveButton());
    expect(
      await screen.findByText(/الملف لا يطابق المعاينة المعروضة/, {
        selector: ".logo-upload__error-line",
      }),
    ).toBeDefined();
    expect(screen.queryByRole("img", { name: "شاشة التشغيل" })).toBeNull();
  });

  test("a 500 on save shows the generic error with the request id; the logo is unchanged", async () => {
    await previewReady();
    api.put.mockResolvedValue(refusal(500, "internal_error"));
    fireEvent.click(saveButton());
    expect(await screen.findByText(REQUEST_ID)).toBeDefined();
    expect(screen.getByRole("img", { name: "الشعار الحالي للمؤسسة" })).toBeDefined();
  });

  test("remove needs a confirm step; .btn-destructive appears only there; cancel keeps the logo", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingWithLogo() });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "إزالة الشعار" }));
    expect(
      screen.getByText(
        "إزالة شعار المؤسسة؟ ستعرض أجهزة الكاشير والإيصالات اسم المؤسسة نصًا بدل الشعار.",
      ),
    ).toBeDefined();
    const destructive = document.querySelectorAll(".btn-destructive");
    expect(destructive).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    expect(document.querySelectorAll(".btn-destructive")).toHaveLength(0);
    expect(api.del).not.toHaveBeenCalled();
  });

  test("confirmed removal sends the revision and shows the text fallback", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingWithLogo() });
    api.del.mockResolvedValue({ status: 200, data: brandingEmpty(4) });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "إزالة الشعار" }));
    const region = screen.getByText(/إزالة شعار المؤسسة؟/).closest("section") as HTMLElement;
    fireEvent.click(within(region).getByRole("button", { name: "إزالة الشعار" }));
    expect(
      await screen.findByText(
        "تمت إزالة الشعار. ستعرض أجهزة الكاشير اسم المؤسسة نصًا بعد تحديث بياناتها.",
      ),
    ).toBeDefined();
    expect(api.del).toHaveBeenCalledWith(TENANT_ID, { expectedRevision: 3 });
    expect(screen.getByText(/لا يوجد شعار للمؤسسة/)).toBeDefined();
  });

  test("cancel discards the preview and returns focus to «استبدال الشعار»", async () => {
    await previewReady();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "اختيار ملف آخر" }));
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    expect(screen.queryByText("كما سيظهر على أجهزة الكاشير")).toBeNull();
    const replace = screen.getByRole("button", { name: "استبدال الشعار" });
    await waitFor(() => expect(document.activeElement).toBe(replace));
  });

  test("a conflict on remove closes the confirm and returns focus to «إزالة الشعار»", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingWithLogo() });
    api.del.mockResolvedValue(refusal(409, "logo_changed_concurrently"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "إزالة الشعار" }));
    const region = screen.getByText(/إزالة شعار المؤسسة؟/).closest("section") as HTMLElement;
    fireEvent.click(within(region).getByRole("button", { name: "إزالة الشعار" }));
    expect(await screen.findByText(/تغيّر شعار المؤسسة بعد فتحك/)).toBeDefined();
    const remove = screen.getByRole("button", { name: "إزالة الشعار" });
    await waitFor(() => expect(document.activeElement).toBe(remove));
  });

  test("a 429 on the first read: the shell banner has the message, the page keeps a gated retry", async () => {
    api.get.mockImplementationOnce(async () => {
      reportRateLimited(30);
      return { ...refusal(429, "rate_limited"), retryAfter: "30" };
    });
    renderPage();
    const retry = await screen.findByRole("button", { name: /إعادة المحاولة/ });
    expect(screen.queryByText("تعذّر تحميل شعار المؤسسة.")).toBeNull();
    expect((retry as HTMLButtonElement).disabled).toBe(true);

    act(() => resetRateLimit());
    api.get.mockResolvedValueOnce({ status: 200, data: brandingEmpty() });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "رفع شعار" })).toBeDefined();
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});

describe("429 rate_limited (Retry-After)", () => {
  test("a 429 preview keeps the file and offers a gated re-run once the wait is over", async () => {
    api.get.mockResolvedValue({ status: 200, data: brandingEmpty() });
    api.preview.mockImplementationOnce(async () => {
      reportRateLimited(30);
      return { ...refusal(429, "rate_limited"), retryAfter: "30" };
    });
    renderPage();
    await screen.findByRole("button", { name: "رفع شعار" });
    const file = pngFile();
    choose(file);
    const rerun = await screen.findByRole("button", { name: /إعادة عرض المعاينة/ });
    expect((rerun as HTMLButtonElement).disabled).toBe(true);
    expect(api.preview).toHaveBeenCalledTimes(1);

    act(() => resetRateLimit());
    api.preview.mockResolvedValueOnce({ status: 200, data: preview() });
    await waitFor(() => expect((rerun as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(rerun);
    expect(await screen.findByRole("img", { name: "شاشة التشغيل" })).toBeDefined();
    expect(api.preview.mock.calls[1][1]).toBe(file);
  });

  test("a 429 on save keeps the preview; save is gated while the wait runs", async () => {
    await previewReady();
    api.put.mockImplementationOnce(async () => {
      reportRateLimited(30);
      return { ...refusal(429, "rate_limited"), retryAfter: "30" };
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText("كما سيظهر على أجهزة الكاشير")).toBeDefined();
  });
});
