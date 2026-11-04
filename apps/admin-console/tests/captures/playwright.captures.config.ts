import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import type { LocaleFixtures } from "../e2e/fixtures";

/**
 * RT-1118: the v4.0 evidence captures (.github/workflows/admin-captures.yml),
 * on top of the E2E config: the same two locale projects, the same preview
 * server and base URL. Paths in a config resolve against its own folder, so the
 * preview server runs from the app root. Light theme and reduced motion for
 * every capture; one retry, since a capture only fails when a route crashes.
 */
const appRoot = resolve(import.meta.dirname, "../..");
type WebServer = Exclude<NonNullable<typeof base.webServer>, readonly unknown[]>;

export default defineConfig<Pick<LocaleFixtures, "appLocale">>({
  ...base,
  testDir: ".",
  testMatch: "**/*.capture.ts",
  outputDir: resolve(appRoot, "test-results/captures"),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { ...base.use, colorScheme: "light", contextOptions: { reducedMotion: "reduce" } },
  webServer: { ...(base.webServer as WebServer), cwd: appRoot },
});
