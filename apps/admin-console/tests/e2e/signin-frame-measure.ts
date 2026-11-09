import type { Page } from "@playwright/test";

/**
 * RT-1301: measures the public night frame (sign-in and accept-invitation share
 * `AuthLayout`) in the page, so the e2e guard (`signin-frame-fit.spec.ts`) and the CI
 * capture (`tests/captures/signin-frame.capture.ts`) read the same numbers.
 */

export interface FrameMeasure {
  viewport: { width: number; height: number };
  /** The page scrolls sideways, or the frame clips something sideways. */
  pageScrollsX: boolean;
  mainClipsX: boolean;
  topClipsX: boolean;
  /** The page scrolls up and down (content is taller than the viewport). */
  pageScrollsY: boolean;
  /** Height the frame needs: padding + top row + form + foot + the two gaps. */
  neededHeight: number;
  formWidth: number;
  /** 0 when the picture is hidden. */
  artWidth: number;
  logo: { width: number; height: number };
  towerShown: boolean;
  towerWidth: number;
  /** Selectors of the fields or the button the tower's box overlaps. */
  towerOverlaps: string[];
}

/** In the page. */
const measure = (): FrameMeasure => {
  const root = document.documentElement;
  const q = (selector: string) => document.querySelector<HTMLElement>(selector);
  const rect = (el: Element | null) => el?.getBoundingClientRect() ?? new DOMRect();
  const main = q(".auth-main");
  const top = q(".auth-top");
  const foot = q(".auth-foot");
  const form = q(".auth-form");
  const art = q(".auth-art");
  const tower = q(".auth-tower");
  const tile = q(".auth-lockup__tile");
  const mainStyle = main ? getComputedStyle(main) : null;
  const num = (value: string | undefined) => Number.parseFloat(value ?? "") || 0;

  const towerBox = rect(tower);
  const towerShown = !!tower && getComputedStyle(tower).display !== "none" && towerBox.width > 0;
  const overlaps: string[] = [];
  if (towerShown) {
    const targets = [
      ...document.querySelectorAll<HTMLElement>(".auth-fields .input, .auth-fields .auth-submit"),
    ];
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      const across = Math.min(r.right, towerBox.right) - Math.max(r.left, towerBox.left);
      const down = Math.min(r.bottom, towerBox.bottom) - Math.max(r.top, towerBox.top);
      if (across > 0 && down > 0)
        overlaps.push(`${el.tagName.toLowerCase()}#${el.id || el.className}`);
    }
  }

  const needed =
    num(mainStyle?.paddingTop) +
    num(mainStyle?.paddingBottom) +
    rect(top).height +
    rect(foot).height +
    rect(form).height +
    2 * num(mainStyle?.rowGap);

  const artShown = !!art && getComputedStyle(art).display !== "none";
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    pageScrollsX: root.scrollWidth > root.clientWidth,
    mainClipsX: !!main && main.scrollWidth > main.clientWidth,
    topClipsX: !!top && top.scrollWidth > top.clientWidth,
    pageScrollsY: root.scrollHeight > window.innerHeight,
    neededHeight: Math.round(needed * 10) / 10,
    formWidth: Math.round(rect(form).width * 10) / 10,
    artWidth: artShown ? Math.round(rect(art).width * 10) / 10 : 0,
    logo: {
      width: Math.round(rect(tile).width * 10) / 10,
      height: Math.round(rect(tile).height * 10) / 10,
    },
    towerShown,
    towerWidth: towerShown ? Math.round(towerBox.width * 10) / 10 : 0,
    towerOverlaps: overlaps,
  };
};

export const FRAME_ROUTES = [
  { name: "signin", path: "/signin" },
  { name: "accept-invitation", path: "/accept-invitation?token=capture-token" },
] as const;

/** Signed out, with every other call answered empty. */
export async function mockSignedOut(page: Page): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill({ status: 200, json: {} }));
  await page.route("**/api/v1/auth/refresh", (r) => r.fulfill({ status: 401, json: {} }));
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill({ status: 401, json: { error: { code: "unauthorized" } } }),
  );
}

/** Opens a public route at a size, waits for the frame and the fonts, then measures it. */
export async function openAndMeasure(
  page: Page,
  path: string,
  size: { width: number; height: number },
): Promise<FrameMeasure> {
  await page.setViewportSize(size);
  await page.goto(path);
  await page.locator(".auth-form").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(measure);
}
