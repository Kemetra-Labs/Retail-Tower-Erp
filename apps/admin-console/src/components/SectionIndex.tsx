/**
 * RT-1009 (DESIGN.md v4.0 §12.2): the section index badge («01», «02»…) beside
 * the title of each section on a multi-panel page. The digits are decoration:
 * the section's heading stays its only name, so the badge is `aria-hidden` and
 * sits beside the heading, never inside it. Not used on single-panel screens.
 */
import "./section-index.css";

/** The badge text for a 1-based position: two digits, Latin, as on the boards. */
export function sectionIndexLabel(position: number): string {
  return String(position).padStart(2, "0");
}

export function SectionIndex({ position }: Readonly<{ position: number }>): React.JSX.Element {
  return (
    <span className="section-index" aria-hidden="true">
      {sectionIndexLabel(position)}
    </span>
  );
}
