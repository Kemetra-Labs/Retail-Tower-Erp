import type { Page } from "@playwright/test";

/**
 * RT-969: the language (RT-399) and theme (RT-398) switches live in the top
 * bar's user menu. Open it, unless it is already open.
 */
export async function openUserMenu(page: Page): Promise<void> {
  const button = page.locator(".topbar__user");
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await page.locator(".user-menu__panel").waitFor();
}
