import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-474 against the BUILT SPA with mocked Backend-Core (v0.3.3 tenant-branding
 * contract). Covers what the unit suite cannot:
 *
 * - The renditions really show under the production CSP. The Console's CSP
 *   (services/backend-core/Caddyfile:46) has no `img-src`, so `data:` and `blob:`
 *   images are refused; the page decodes the server PNG with createImageBitmap
 *   and draws it on a canvas. The page is served with that exact header, plus
 *   the `script-src 'unsafe-inline'` the pre-paint script of index.html needs
 *   (the same allowance as the RT-824 spec), and must raise no CSP violation
 *   while every canvas holds the server's pixels.
 * - The upload is the raw file under application/octet-stream.
 * - A keyboard-only walk: the file control opens the picker, save is reachable.
 * - No WCAG 2.1 A/AA axe violation with every warning shown and with a refusal
 *   shown, in light, dark and forced colours.
 */
const TENANT = "0190f000-0000-7000-8000-0000000000a1";
const CADDY_CSP =
  "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const TEST_CSP = CADDY_CSP.replace(
  "default-src 'self';",
  "default-src 'self'; script-src 'self' 'unsafe-inline';",
);

const BOXES = {
  boot: [240, 120],
  pairing: [200, 80],
  sign_in: [128, 32],
  lock: [200, 80],
} as const;

function ctx() {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: TENANT, name: "Northstar Retail" },
    active_store: null,
    active_role_code: "owner",
    memberships: [{ tenant_id: TENANT, tenant_name: "Northstar Retail", role_code: "owner" }],
  };
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** A real PNG of the given size (left half black), made by the browser itself. */
async function pngBase64(page: Page, width: number, height: number): Promise<string> {
  return page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      if (!g) throw new Error("no 2d context");
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#000000";
      g.fillRect(0, 0, Math.ceil(w / 2), h);
      return c.toDataURL("image/png").split(",")[1] ?? "";
    },
    [width, height] as const,
  );
}

async function previewBody(page: Page, warnings: string[], card: boolean) {
  const screen = [];
  for (const [slot, [w, h]] of Object.entries(BOXES)) {
    for (const scale of [1, 2]) {
      const width = Math.min(w, h * 4) * scale;
      const height = width / 4;
      screen.push({
        slot,
        scale,
        width_px: width,
        height_px: height,
        png_base64: await pngBase64(page, width, height),
      });
    }
  }
  return {
    version: "b".repeat(64),
    presentation: { card },
    warnings,
    screen,
    receipt: { width_px: 383, height_px: 96, dpi: 203, png_base64: await pngBase64(page, 383, 96) },
  };
}

interface Mocks {
  uploads: { contentType: string | null; size: number }[];
}

async function mockApi(page: Page, preview: unknown): Promise<Mocks> {
  const mocks: Mocks = { uploads: [] };
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx())));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([])));
  await page.route(`**/api/v1/tenants/${TENANT}/logo`, (r) =>
    r.fulfill(json({ tenant_display_name: "Northstar Retail", revision: 0, logo: null })),
  );
  await page.route(`**/api/v1/tenants/${TENANT}/logo/preview`, (r) => {
    const req = r.request();
    mocks.uploads.push({
      contentType: req.headers()["content-type"] ?? null,
      size: req.postDataBuffer()?.length ?? 0,
    });
    return r.fulfill(json(preview));
  });
  return mocks;
}

const FILE = {
  name: "logo.png",
  mimeType: "image/png",
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
};

test("RT-474: under the production CSP the four slots and the receipt show the server's pixels, with no CSP violation", async ({
  page,
  t,
}) => {
  await page.goto("about:blank");
  const preview = await previewBody(page, [], false);
  const mocks = await mockApi(page, preview);
  await page.route(`**/tenants/${TENANT}/branding`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": TEST_CSP },
    });
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });

  const navigation = await page.goto(`/tenants/${TENANT}/branding`);
  expect(navigation?.headers()["content-security-policy"]).toBe(TEST_CSP);
  await expect(page.getByRole("heading", { name: t("branding.title") })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(FILE);

  const boot = page.getByRole("img", { name: t("branding.slot.boot") });
  await expect(boot).toBeVisible();
  await expect(page.getByRole("img", { name: t("branding.receipt.alt") })).toBeVisible();
  expect(mocks.uploads).toEqual([
    { contentType: "application/octet-stream", size: FILE.buffer.length },
  ]);

  // Every canvas holds the decoded server image: its black half is drawn.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("canvas")).map((c) => {
          const g = c.getContext("2d");
          if (!g || c.width === 0) return false;
          const px = g.getImageData(0, Math.floor(c.height / 2), 1, 1).data;
          return px[3] === 255 && px[0] < 16;
        }),
      ),
    )
    .toEqual([true, true, true, true, true]);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);

  // The receipt is laid out at its printed size: 383 dots at 203 dpi = 47.92 mm.
  const receiptWidth = await page
    .getByRole("img", { name: t("branding.receipt.alt") })
    .evaluate((el) => (el as HTMLElement).style.width);
  expect(receiptWidth).toBe("47.92mm");
});

test("RT-474: keyboard only, the file control opens the picker and save is reachable", async ({
  page,
  t,
}) => {
  await page.goto("about:blank");
  await mockApi(page, await previewBody(page, [], false));
  await page.goto(`/tenants/${TENANT}/branding`);
  const control = page.getByRole("button", { name: t("branding.upload.choose") });
  await expect(control).toBeVisible();
  await control.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(FILE);
  const save = page.getByRole("button", { name: t("branding.save") });
  await expect(save).toBeEnabled();
  for (let i = 0; i < 30 && !(await save.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(save).toBeFocused();
});

for (const mode of ["light", "dark", "forced"] as const) {
  test(`RT-474: no axe violations with every warning and with a refusal (${mode})`, async ({
    page,
    t,
  }) => {
    await page.goto("about:blank");
    const preview = await previewBody(
      page,
      ["low_contrast", "receipt_high_black_coverage", "receipt_thin_strokes"],
      true,
    );
    await mockApi(page, preview);
    await page.goto(`/tenants/${TENANT}/branding`);
    if (mode === "forced") await page.emulateMedia({ forcedColors: "active" });
    if (mode === "dark") {
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
    }
    await page.locator('input[type="file"]').setInputFiles(FILE);
    await expect(page.getByText(t("branding.warning.receipt_thin_strokes"))).toBeVisible();
    await expectNoAxeViolations(page, `logo preview with warnings (${mode})`);
    await page.screenshot({
      path: test.info().outputPath(`tenant-logo-preview-${mode}.png`),
      fullPage: true,
    });

    await page.route(`**/api/v1/tenants/${TENANT}/logo/preview`, (r) =>
      r.fulfill(
        json(
          {
            error: {
              code: "aspect_ratio_out_of_range",
              message: "x",
              request_id: "0190f000-0000-7000-8000-00000000beef",
            },
          },
          422,
        ),
      ),
    );
    await page.locator('input[type="file"]').setInputFiles({ ...FILE, name: "wide.png" });
    // The refusal is in two places: the visible line on the field and the page's
    // persistent polite live region (sr-only). Each is checked on its own.
    const refusalText = t("branding.refusal.aspect_ratio_out_of_range");
    await expect(page.locator(".logo-upload__error-line", { hasText: refusalText })).toBeVisible();
    await expect(page.locator('p.sr-only[aria-live="polite"]')).toContainText(refusalText);
    await expectNoAxeViolations(page, `logo refusal (${mode})`);
  });
}
