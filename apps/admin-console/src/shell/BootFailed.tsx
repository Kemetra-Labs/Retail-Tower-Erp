/**
 * RT-962: the state shown when the active locale's catalog can't be fetched
 * before the first render (main.tsx). It needs no catalog, so its two lines
 * live here, in the language the pre-paint script already painted (one
 * language at a time, UX-12). Retry reloads the page: the browser keeps a
 * failed import() failed for the page's lifetime.
 */
import type { Locale } from "@/i18n/locale";

const COPY: Record<Locale, { message: string; retry: string }> = {
  ar: {
    message: "تعذّر تحميل لوحة التحكم. تحقّق من الاتصال ثم أعد المحاولة.",
    retry: "إعادة المحاولة",
  },
  en: {
    message: "The Console could not load. Check the connection and try again.",
    retry: "Try again",
  },
};

export function BootFailed({
  locale,
  onRetry,
}: Readonly<{ locale: Locale; onRetry: () => void }>): React.JSX.Element {
  const copy = COPY[locale];
  return (
    <main className="rtc-crash">
      <div className="rtc-alert rtc-alert--danger" role="alert">
        <span className="rtc-alert__body">{copy.message}</span>
        <span className="rtc-alert__action">
          <button type="button" className="btn-secondary" onClick={onRetry}>
            {copy.retry}
          </button>
        </span>
      </div>
    </main>
  );
}
