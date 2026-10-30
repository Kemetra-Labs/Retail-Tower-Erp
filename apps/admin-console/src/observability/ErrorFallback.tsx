/**
 * Safe fallback screen for an unexpected render error (RT-633). It never shows
 * the error, its message or its stack: those can carry tokens, emails or
 * business data. `useT` reads the module-level locale store, so this renders
 * above every provider.
 *
 * RT-958: the copy reads What → Safety → Action → Evidence (DESIGN.md §8). The
 * evidence is the Sentry event id, shown only when an event was sent.
 */
import { useT } from "@/i18n";
import "@/components/banner.css";
import "./error-fallback.css";

/** The Sentry event id an operator can quote to support; nothing when absent. */
export function ErrorReference({
  reference,
}: Readonly<{ reference: string | undefined }>): React.JSX.Element | null {
  const t = useT();
  if (reference === undefined) return null;
  return (
    <span className="rtc-alert__req">
      {t.rich("app.crash.reference", { id: <bdi dir="ltr">{reference}</bdi> })}
    </span>
  );
}

export function ErrorFallback({ reference }: Readonly<{ reference?: string }>): React.JSX.Element {
  const t = useT();
  return (
    <main className="rtc-crash">
      <div className="rtc-alert rtc-alert--danger" role="alert">
        <h1 className="rtc-alert__title rtc-crash__title">{t("app.crash.title")}</h1>
        <span className="rtc-alert__body">{t("app.crash.what")}</span>
        <span className="rtc-alert__body">{t("app.crash.safety")}</span>
        <span className="rtc-alert__body">{t("app.crash.action")}</span>
        <ErrorReference reference={reference} />
        <span className="rtc-alert__action">
          <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>
            {t("app.crash.reload")}
          </button>
        </span>
      </div>
    </main>
  );
}
