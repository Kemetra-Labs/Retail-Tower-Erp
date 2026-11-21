import { ManagerSalesPanel } from "@/ai-manager-sales/ManagerSalesPanel";
import { DocumentLocale } from "@/i18n";
import { registerCatalog } from "@/i18n/catalogs";
import { ar } from "@/i18n/messages/ar";
import { en } from "@/i18n/messages/en";
import { createQueryClient } from "@/lib/query";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/tokens.css";
import "@/styles/controls.css";
import "@/styles/a11y.css";

// RT-962: the app loads catalogs on demand (main.tsx); a harness has both up front.
registerCatalog("ar", ar);
registerCatalog("en", en);

/**
 * RT-1541 e2e harness: the Manager Sales panel mounted on its own, with the flag decision taken
 * out (the flag itself is proved OFF on the built SPA in ai-manager-sales-off.spec.ts). It
 * imports the real panel, the real generated client and the app's own stylesheets, so the mocked
 * API (Playwright routes) and axe see what a screen would render. Never shipped: build.ts bundles
 * it into a temp directory for the Playwright run only. `?role=` picks the viewer's role.
 */
const STORES = [
  { id: "0190f000-0000-7000-8000-0000000000a1", name: "Maadi", timezone: "Africa/Cairo" },
  { id: "0190f000-0000-7000-8000-0000000000b2", name: "Nasr City", timezone: "Africa/Cairo" },
];

function Harness(): React.JSX.Element {
  const role = new URLSearchParams(window.location.search).get("role") ?? "owner";
  return (
    <QueryClientProvider client={createQueryClient()}>
      <DocumentLocale />
      <h1>Sales</h1>
      <ManagerSalesPanel stores={STORES} tenantWide={role !== "store_manager"} role={role} />
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
