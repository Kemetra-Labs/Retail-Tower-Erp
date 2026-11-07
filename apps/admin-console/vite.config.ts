import { URL, fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// D-1: React 19 + Vite 6, SPA mode (no SSR adapter).
export default defineConfig({
  plugins: [react()],
  // RT-633: Sentry `release` / `version` = the release SHA12. Only the commit
  // id is baked in; the tunnel and env arrive at runtime (src/observability/).
  define: {
    __CONSOLE_RELEASE_SHA__: JSON.stringify(process.env.GITHUB_SHA ?? ""),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Plain SPA build; target evergreen browsers (C-1).
    target: "es2022",
    outDir: "dist",
    // RT-962: only JavaScript is split. The stylesheet stays one file loaded up
    // front, as before: screens share utility classes defined in other screens'
    // CSS (.table-scroll, .muted, .num), which a per-route split would drop.
    cssCodeSplit: false,
    // RT-1242: build the maps but leave out the `sourceMappingURL` comment, so the browser is never
    // pointed at one. The release workflow moves them out of dist/ (uploaded to Sentry only, never
    // archived or hosted); release-artifact.ts refuses a dist/ that still holds a `.map`.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // RT-962: React and the router change only on a dependency bump, so they
        // ship as one long-cached vendor chunk beside the entry (routes and the
        // message catalogs are split by import() in src/).
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
});
