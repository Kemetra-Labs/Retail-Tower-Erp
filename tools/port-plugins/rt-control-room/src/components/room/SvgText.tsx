import type { ReactNode, SVGProps } from "react";
import { useLang } from "../../i18n/LangContext";

const ARABIC = /[؀-ۿ]/;
type Anchor = "start" | "middle" | "end";

/**
 * SVG text for a diagram that always reads left to right. Arabic strings are
 * set right to left and their anchor is mirrored, so they sit where the
 * Latin text would. Everything else is a plain `<text>`.
 */
export function SvgText({
  anchor = "start",
  children,
  ...rest
}: Omit<SVGProps<SVGTextElement>, "textAnchor" | "direction"> & { anchor?: Anchor; children: ReactNode }) {
  const { lang } = useLang();
  const text = typeof children === "string" || typeof children === "number" ? String(children) : "";
  const rtl = lang === "ar" && ARABIC.test(text);
  const flipped: Anchor = rtl ? (anchor === "start" ? "end" : anchor === "end" ? "start" : anchor) : anchor;
  return (
    <text {...rest} textAnchor={flipped} direction={rtl ? "rtl" : undefined}>
      {children}
    </text>
  );
}
