/// <reference types="vite/client" />

// Build-time env exposed to the client (D-1). No secret is committed
// here (C-8); VITE_API_BASE_URL defaults to same-origin in client.ts.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  // RT-1541: the default-OFF rollout flag of the Manager Sales Ask/Explain panel. Only the exact
  // string "true" turns it on; unset (every committed config) is OFF.
  readonly VITE_AI_MANAGER_SALES_PANEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// RT-633: the build's full commit SHA (GITHUB_SHA in CI), injected by
// vite.config.ts `define`. Not a secret: it is the release artifact's own
// commit, already public in /version.json. Empty outside CI.
declare const __CONSOLE_RELEASE_SHA__: string | undefined;
