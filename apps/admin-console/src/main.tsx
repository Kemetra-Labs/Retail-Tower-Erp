import { apiClient } from "@/generated/client";
import { loadCatalog } from "@/i18n/catalogs";
import { type Locale, getLocale } from "@/i18n/locale";
import { installRateLimitTracking } from "@/lib/rate-limit";
import { installRequestIdHeader } from "@/lib/request-id";
import { installSupportSessionExpiryTracking } from "@/lib/support-session-expiry";
import { AppErrorBoundary } from "@/observability/AppErrorBoundary";
import { telemetryConfigSource } from "@/observability/runtime-config";
import { startObservability } from "@/observability/sentry";
import { BootFailed } from "@/shell/BootFailed";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// D-1: React 19 SPA bootstrap. No router/state lib yet — those are
// slice-003 decisions (foundation R-4/R-6).
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

// RT-633: one X-Request-Id per Backend-Core call (contract RT-629 section 2).
installRequestIdHeader(apiClient);
// RT-621: every 429 feeds the shared Retry-After clock (banner, gates, retry).
installRateLimitTracking(apiClient);
// RT-781: a tenant call refused with 403 support_session_expired flips the page to the expired state.
installSupportSessionExpiryTracking(apiClient);

const root = createRoot(rootElement);

// RT-962: the active locale's catalog (the one the RT-399 pre-paint script
// chose) loads before the first render. If it can't be fetched, a catalog-free
// retry state shows instead of message keys. Once the Console is up, the other
// catalog is fetched when idle, so a later language switch also works offline;
// a failure there is retried on the switch itself.
const painted: Locale = getLocale();

function boot(): void {
  loadCatalog(painted).then(
    () => {
      root.render(
        <StrictMode>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </StrictMode>,
      );
      const other: Locale = painted === "ar" ? "en" : "ar";
      setTimeout(() => void loadCatalog(other).catch(() => undefined), 2000);
    },
    // A failed import() stays failed for this page, so retrying means a reload.
    () => root.render(<BootFailed locale={painted} onRetry={() => window.location.reload()} />),
  );
}

boot();

// RT-633/RT-673: after the first render, never blocking it. The config comes
// from Backend-Core (204 or any failure keeps the Console inert);
// initObservability never throws.
void startObservability(telemetryConfigSource());
