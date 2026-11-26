/**
 * RT-965: «كيف تُقرأ هذه الصفحة» / "How to read this page". A collapsed disclosure for the
 * caveats that explain a screen but are not needed to do its task. Truth-critical statements
 * (for example the time zone of the times shown) stay visible on the page itself, never here.
 */
import { useT } from "@/i18n";
import "./reading-note.css";

export function ReadingNote({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <details className="reading-note">
      <summary className="reading-note__summary">{t("components.readingNote.summary")}</summary>
      <div className="reading-note__body">{children}</div>
    </details>
  );
}
