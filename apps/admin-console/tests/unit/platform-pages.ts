import { readSource } from "./source-scan";

/**
 * RT-944: `platformRoutes` loads its pages with import() (RT-962). In a test,
 * a page's first import is also its first transform, and every worker queues
 * for that on the one Vitest server: 0.2-0.5 s alone, more than the 1 s a test
 * waits for the page under full-suite load. A file that renders the routes
 * awaits this at the top, so that cost is paid while the file loads, before
 * any test starts waiting. The list is read from the routes file itself.
 */
export async function loadPlatformPages(): Promise<void> {
  const pages = [
    ...readSource("src/shell/platformRoutes.tsx").matchAll(/import\("(@\/[^"]+)"\)/g),
  ].map((match) => match[1] ?? "");
  if (pages.length === 0) throw new Error("platformRoutes.tsx has no import() pages to load");
  await Promise.all(pages.map((page) => import(/* @vite-ignore */ page)));
}
