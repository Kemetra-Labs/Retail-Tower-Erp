/**
 * Nest providers for the email pipeline's transport (RT-1280).
 *
 *   EMAIL_CONFIG            resolveEmailConfig(process.env) — throws at boot
 *                           in production unless SES is fully configured.
 *   EMAIL_ADAPTER           SesEmailAdapter for `ses`, NoOpEmailAdapter for
 *                           `noop` (non-production only, by construction).
 *   EMAIL_CONSOLE_BASE_URL  Admin Console origin for invitation links.
 *
 * Kept out of `worker.module.ts` so the factories are unit-testable without
 * building the whole module.
 */
import type { Provider } from "@nestjs/common";
import { EMAIL_ADAPTER, type EmailAdapter, NoOpEmailAdapter } from "./email.adapter";
import { EMAIL_CONFIG, type EmailConfig, resolveEmailConfig } from "./email.config";
import { EMAIL_CONSOLE_BASE_URL } from "./email.processor";
import { createSesEmailAdapter } from "./ses-email.adapter";

export function emailAdapterFromConfig(config: EmailConfig): EmailAdapter {
  return config.kind === "ses"
    ? createSesEmailAdapter({ region: config.region, from: config.from })
    : new NoOpEmailAdapter();
}

export const emailTransportProviders: Provider[] = [
  {
    provide: EMAIL_CONFIG,
    useFactory: (): EmailConfig => resolveEmailConfig(process.env),
  },
  {
    provide: EMAIL_ADAPTER,
    useFactory: emailAdapterFromConfig,
    inject: [EMAIL_CONFIG],
  },
  {
    provide: EMAIL_CONSOLE_BASE_URL,
    useFactory: (config: EmailConfig): string | null => config.consoleBaseUrl,
    inject: [EMAIL_CONFIG],
  },
];
